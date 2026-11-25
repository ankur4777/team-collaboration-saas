"""Delegated Gmail/Graph adapters. No user-controlled request hosts or HTML execution."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import getaddresses, format_datetime
from urllib.parse import quote, urlparse
import httpx
from django.core import signing
from rest_framework.exceptions import ValidationError, NotFound
from .common import MailError, ReconnectRequired, FOLDERS, opaque_id, decode_id, b64decode, b64encode, plain_html
from .oauth import access_token

GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
GRAPH = "https://graph.microsoft.com/v1.0/me"
LABELS = {"inbox": "INBOX", "sent": "SENT", "drafts": "DRAFT", "junk": "SPAM", "trash": "TRASH", "starred": "STARRED"}
GRAPH_FOLDERS = {"inbox": "inbox", "sent": "sentitems", "drafts": "drafts", "archive": "archive", "trash": "deleteditems", "junk": "junkemail"}
SELECT = "id,subject,from,toRecipients,ccRecipients,bccRecipients,replyTo,receivedDateTime,isRead,flag,bodyPreview,hasAttachments,isDraft,internetMessageId,conversationId"


def addresses(value):
    return [email for _, email in getaddresses([value or ""]) if email]


class RemoteMailbox:
    def __init__(self, account):
        self.account = account
        self.token = access_token(account)
        self.base = GMAIL if account.provider == "gmail" else GRAPH

    def call(self, method, path, *, params=None, data=None, sending=False):
        url = self.base + path
        headers = {"Authorization": "Bearer " + self.token}
        if self.account.provider == "outlook":
            headers.update({"Prefer": 'outlook.body-content-type="text", IdType="ImmutableId"'})
        try:
            response = httpx.request(method, url, params=params, json=data, headers=headers,
                                     timeout=25, follow_redirects=False)
        except httpx.HTTPError:
            error = MailError("The provider connection failed." + (" Sending status is uncertain; check Sent before sending again." if sending else ""))
            error.uncertain = sending
            raise error
        if response.status_code == 401:
            raise ReconnectRequired()
        if response.status_code == 404:
            raise NotFound("This message no longer exists in the connected mailbox.")
        if response.status_code == 429:
            raise MailError("The mail provider is rate limiting requests. Wait briefly before trying again.")
        if not 200 <= response.status_code < 300:
            error = MailError("The provider rejected the request (" + str(response.status_code) + "). Refresh or reconnect the mailbox.")
            error.uncertain = sending and (response.status_code >= 500 or response.status_code == 408)
            raise error
        if not response.content:
            return {}
        try:
            result = response.json()
        except ValueError:
            error = MailError("The mail provider returned an unreadable response." + (" Check Sent before sending again." if sending else ""))
            error.uncertain = sending
            raise error
        if not isinstance(result, dict):
            error = MailError("The mail provider returned an unexpected response.")
            error.uncertain = sending
            raise error
        return result

    def cursor(self, value, folder, query):
        return signing.dumps({"account": str(self.account.pk), "folder": folder, "q": query, "value": value}, salt="mail-page") if value else ""

    def uncursor(self, value, folder, query):
        if not value:
            return ""
        try:
            data = signing.loads(value, salt="mail-page", max_age=3600)
            if data["account"] != str(self.account.pk) or data["folder"] != folder or data["q"] != query:
                raise ValueError()
            return data["value"]
        except (signing.BadSignature, ValueError, KeyError):
            raise ValidationError("This page expired. Refresh the mailbox.")

    def folders(self):
        if self.account.provider == "gmail":
            # Label listing omits counts. Read the six system labels for accurate unread badges.
            def count(f):
                label = self.call("GET", "/labels/" + LABELS[f]) if f in LABELS else {}
                return {"id": f, "name": f.title(), "total": label.get("messagesTotal", 0),
                        "unread": label.get("messagesUnread", 0)}
            with ThreadPoolExecutor(max_workers=4) as pool:
                return list(pool.map(count, FOLDERS))
        # System folder IDs are opaque; well-known routes return the correct localized folders.
        def count(f):
            v = self.call("GET", "/mailFolders/" + GRAPH_FOLDERS[f], params={"$select": "totalItemCount,unreadItemCount"}) if f in GRAPH_FOLDERS else {}
            return {"id": f, "name": f.title(), "total": v.get("totalItemCount", 0), "unread": v.get("unreadItemCount", 0)}
        with ThreadPoolExecutor(max_workers=4) as pool:
            return list(pool.map(count, FOLDERS))

    def gmail_normalize(self, m, *, draft_id=None, detail=False):
        headers = {h["name"].lower(): h["value"] for h in m.get("payload", {}).get("headers", [])}
        labels = m.get("labelIds", [])
        folder = next((f for f in ("trash", "junk", "drafts", "sent", "inbox") if LABELS[f] in labels), "archive")
        sender = getaddresses([headers.get("from", "")])
        text_parts, html_parts, files = [], [], []
        def visit(part):
            body = part.get("body", {})
            if part.get("filename") and body.get("attachmentId"):
                files.append({"id": opaque_id(body["attachmentId"]), "name": part["filename"], "size": body.get("size", 0),
                              "content_type": part.get("mimeType", "application/octet-stream")})
            elif body.get("data"):
                value = b64decode(body["data"]).decode("utf-8", errors="replace")
                if part.get("mimeType") == "text/plain":
                    text_parts.append(value)
                elif part.get("mimeType") == "text/html":
                    html_parts.append(value)
            for child in part.get("parts", []):
                visit(child)
        visit(m.get("payload", {}))
        body = "\n".join(text_parts) or plain_html("\n".join(html_parts))
        date = datetime.fromtimestamp(int(m.get("internalDate", "0")) / 1000, tz=timezone.utc).isoformat()
        data = {
            "id": opaque_id(draft_id or m["id"], "draft" if draft_id else "message"),
            "subject": headers.get("subject", ""), "sender": sender[0][1] if sender else "",
            "sender_name": sender[0][0] if sender else "", "to": addresses(headers.get("to")),
            "cc": addresses(headers.get("cc")), "bcc": addresses(headers.get("bcc")) if folder in ("drafts", "sent") else [],
            "preview": m.get("snippet", ""), "date": date, "is_read": "UNREAD" not in labels,
            "is_starred": "STARRED" in labels, "folder": folder, "has_attachments": bool(files),
            "reply_to": addresses(headers.get("reply-to")) or addresses(headers.get("from")),
            "internet_id": headers.get("message-id", ""), "thread_id": m.get("threadId", ""),
        }
        if detail:
            data.update(body=body, attachments=files)
        return data

    def graph_normalize(self, m, folder="inbox", detail=False):
        sender = m.get("from", {}).get("emailAddress", {})
        def emails(field):
            return [r.get("emailAddress", {}).get("address", "") for r in m.get(field, [])]
        data = {
            "id": opaque_id(m["id"], "draft" if m.get("isDraft") else "message"),
            "subject": m.get("subject", ""), "sender": sender.get("address", ""),
            "sender_name": sender.get("name", ""), "to": emails("toRecipients"), "cc": emails("ccRecipients"),
            "bcc": emails("bccRecipients") if folder in ("sent", "drafts") else [],
            "preview": m.get("bodyPreview", ""), "date": m.get("receivedDateTime", ""),
            "is_read": m.get("isRead", True), "is_starred": m.get("flag", {}).get("flagStatus") == "flagged",
            "folder": "drafts" if m.get("isDraft") else folder, "has_attachments": m.get("hasAttachments", False),
            "reply_to": emails("replyTo") or [sender.get("address", "")], "internet_id": m.get("internetMessageId", ""),
            "thread_id": m.get("conversationId", ""),
        }
        if detail:
            body = m.get("body", {})
            text = plain_html(body.get("content", "")) if body.get("contentType", "").lower() == "html" else body.get("content", "")
            files = self.call("GET", "/messages/" + quote(m["id"], safe="") + "/attachments",
                              params={"$select": "id,name,contentType,size,isInline", "$top": 100}).get("value", []) if m.get("hasAttachments") else []
            data.update(body=text, attachments=[{
                "id": opaque_id(a["id"]), "name": a.get("name", "attachment"), "size": a.get("size", 0),
                "content_type": a.get("contentType", "application/octet-stream"),
            } for a in files if a.get("@odata.type") in (None, "#microsoft.graph.fileAttachment")])
        return data

    def messages(self, folder, query="", cursor=""):
        page = self.uncursor(cursor, folder, query)
        if self.account.provider == "gmail":
            drafts = folder == "drafts"
            params = {"maxResults": 25}
            if page:
                params["pageToken"] = page
            q = query
            if folder == "archive":
                q = "-in:inbox -in:sent -in:drafts -in:trash -in:spam " + q
            elif not drafts:
                params["labelIds"] = LABELS[folder]
            if q:
                params["q"] = q
            if folder in ("trash", "junk"):
                params["includeSpamTrash"] = "true"
            response = self.call("GET", "/drafts" if drafts else "/messages", params=params)
            rows = response.get("drafts" if drafts else "messages", [])
            def get(row):
                try:
                    if drafts:
                        v = self.call("GET", "/drafts/" + quote(row["id"], safe=""), params={"format": "full"})
                        return self.gmail_normalize(v["message"], draft_id=v["id"])
                    return self.gmail_normalize(self.call("GET", "/messages/" + quote(row["id"], safe=""), params={"format": "full"}))
                except NotFound:
                    # Another client may permanently delete or send an item
                    # between listing its ID and retrieving its contents.
                    return None
            with ThreadPoolExecutor(max_workers=5) as pool:
                results = [item for item in pool.map(get, rows) if item is not None]
            return {"results": results, "next_cursor": self.cursor(response.get("nextPageToken", ""), folder, query)}
        path = "/messages" if folder == "starred" else "/mailFolders/" + GRAPH_FOLDERS[folder] + "/messages"
        params = {"$top": 25, "$select": SELECT}
        if query:
            params["$search"] = '"' + query.replace('"', "").replace("\\", "") + '"'
            if folder == "starred":
                raise ValidationError("Search a regular folder; starred-folder search is not supported by Microsoft Graph.")
        else:
            params["$orderby"] = "receivedDateTime desc"
        if folder == "starred":
            params.pop("$orderby", None)
            params["$filter"] = "flag/flagStatus eq 'flagged'"
        if page:
            parsed = urlparse(page)
            if parsed.scheme != "https" or parsed.netloc != "graph.microsoft.com" or not parsed.path.startswith("/v1.0/me/"):
                raise ValidationError("Invalid provider page.")
            path, params = page[len(GRAPH):], None
        result = self.call("GET", path, params=params)
        return {"results": [self.graph_normalize(m, folder) for m in result.get("value", [])],
                "next_cursor": self.cursor(result.get("@odata.nextLink", ""), folder, query)}

    def detail(self, identity, folder="inbox"):
        raw, kind = decode_id(identity)
        if self.account.provider == "gmail":
            if kind == "draft":
                d = self.call("GET", "/drafts/" + quote(raw, safe=""), params={"format": "full"})
                return self.gmail_normalize(d["message"], draft_id=d["id"], detail=True)
            return self.gmail_normalize(self.call("GET", "/messages/" + quote(raw, safe=""), params={"format": "full"}), detail=True)
        m = self.call("GET", "/messages/" + quote(raw, safe=""), params={"$select": SELECT + ",body"})
        return self.graph_normalize(m, folder, True)

    def action(self, identity, action):
        raw, kind = decode_id(identity)
        if kind == "draft":
            raise ValidationError("Use the draft editor for this message.")
        path = "/messages/" + quote(raw, safe="")
        if self.account.provider == "gmail":
            if action in ("trash", "restore"):
                self.call("POST", path + ("/trash" if action == "trash" else "/untrash"), data={})
            else:
                add, remove = [], []
                if action == "read": remove = ["UNREAD"]
                elif action == "unread": add = ["UNREAD"]
                elif action == "star": add = ["STARRED"]
                elif action == "unstar": remove = ["STARRED"]
                elif action == "archive": remove = ["INBOX"]
                elif action == "junk": add, remove = ["SPAM"], ["INBOX"]
                elif action == "inbox": add, remove = ["INBOX"], ["SPAM", "TRASH"]
                self.call("POST", path + "/modify", data={"addLabelIds": add, "removeLabelIds": remove})
        else:
            if action in ("read", "unread", "star", "unstar"):
                data = {"isRead": action == "read"} if action in ("read", "unread") else {
                    "flag": {"flagStatus": "flagged" if action == "star" else "notFlagged"}}
                self.call("PATCH", path, data=data)
            else:
                target = {"restore": "inbox", "trash": "deleteditems", "junk": "junkemail"}.get(action, action)
                self.call("POST", path + "/move", data={"destinationId": target})
        return {"detail": "Message updated."}

    def draft(self, payload):
        if self.account.provider == "gmail":
            message = EmailMessage(policy=SMTP)
            message["From"] = self.account.email
            for header, field in (("To", "to"), ("Cc", "cc"), ("Bcc", "bcc")):
                if payload[field]:
                    message[header] = ", ".join(payload[field])
            message["Subject"] = payload["subject"]
            message["Date"] = format_datetime(datetime.now(timezone.utc))
            message.set_content(payload["body"])
            thread_id = ""
            if payload.get("reply_id") and payload["mode"] in ("reply", "reply_all"):
                original = self.detail(payload["reply_id"])
                if original.get("internet_id"):
                    message["In-Reply-To"] = original["internet_id"]
                    message["References"] = original["internet_id"]
                thread_id = original.get("thread_id", "")
            for a in payload["attachments"]:
                # Treat uploads as downloadable binary attachments; never execute inline content.
                message.add_attachment(base64.b64decode(a["data"]), maintype="application", subtype="octet-stream", filename=a["name"])
            body = {"message": {"raw": b64encode(message.as_bytes())}}
            if thread_id:
                body["message"]["threadId"] = thread_id
            if payload.get("draft_id"):
                raw, kind = decode_id(payload["draft_id"])
                if kind != "draft":
                    raise ValidationError("Only a draft can be saved.")
                result = self.call("PUT", "/drafts/" + quote(raw, safe=""), data=body)
            else:
                result = self.call("POST", "/drafts", data=body)
            return opaque_id(result["id"], "draft")
        def recipients(values):
            return [{"emailAddress": {"address": e}} for e in values]
        data = {
            "subject": payload["subject"], "body": {"contentType": "Text", "content": payload["body"]},
            "toRecipients": recipients(payload["to"]), "ccRecipients": recipients(payload["cc"]),
            "bccRecipients": recipients(payload["bcc"]),
        }
        if payload.get("draft_id"):
            raw, kind = decode_id(payload["draft_id"])
            if kind != "draft" or not self.call("GET", "/messages/" + quote(raw, safe=""), params={"$select": "isDraft"}).get("isDraft"):
                raise ValidationError("Only a draft can be saved.")
        elif payload.get("reply_id") and payload["mode"] != "new":
            source, _ = decode_id(payload["reply_id"])
            action = {"reply": "createReply", "reply_all": "createReplyAll", "forward": "createForward"}[payload["mode"]]
            raw = self.call("POST", "/messages/" + quote(source, safe="") + "/" + action, data={})["id"]
        else:
            raw = self.call("POST", "/messages", data=data)["id"]
        self.call("PATCH", "/messages/" + quote(raw, safe=""), data=data)
        # The UI carries existing attachments when editing. Replace rather than duplicate.
        existing = self.call("GET", "/messages/" + quote(raw, safe="") + "/attachments", params={"$select": "id", "$top": 100})
        for a in existing.get("value", []):
            self.call("DELETE", "/messages/" + quote(raw, safe="") + "/attachments/" + quote(a["id"], safe=""))
        for a in payload["attachments"]:
            self.graph_attach(raw, a)
        return opaque_id(raw, "draft")

    def graph_attach(self, message_id, attachment):
        path = "/messages/" + quote(message_id, safe="") + "/attachments"
        content = base64.b64decode(attachment["data"])
        if len(content) < 3 * 1024 * 1024:
            self.call("POST", path, data={
                "@odata.type": "#microsoft.graph.fileAttachment", "name": attachment["name"],
                "contentType": "application/octet-stream", "contentBytes": attachment["data"],
            })
            return
        session = self.call("POST", path + "/createUploadSession", data={
            "AttachmentItem": {"attachmentType": "file", "name": attachment["name"], "size": len(content)},
        })
        upload_url = session.get("uploadUrl", "")
        parsed = urlparse(upload_url)
        if parsed.scheme != "https" or parsed.hostname != "outlook.office.com" or parsed.port not in (None, 443) or parsed.username or parsed.password:
            raise MailError("The provider returned an unsupported attachment upload host.")
        chunk_size = 2 * 1024 * 1024
        for start in range(0, len(content), chunk_size):
            chunk = content[start:start + chunk_size]
            # A pre-authenticated provider URL: do not send our bearer token.
            try:
                response = httpx.put(upload_url, content=chunk, headers={
                    "Content-Type": "application/octet-stream", "Content-Length": str(len(chunk)),
                    "Content-Range": "bytes " + str(start) + "-" + str(start + len(chunk) - 1) + "/" + str(len(content)),
                }, timeout=30, follow_redirects=False)
            except httpx.HTTPError:
                raise MailError("Attachment upload failed. Save the draft again before sending.")
            expected_status = 201 if start + len(chunk) == len(content) else 200
            if response.status_code != expected_status:
                raise MailError("The provider rejected an attachment upload. Save the draft again before sending.")

    def send_draft(self, identity):
        raw, kind = decode_id(identity)
        if kind != "draft":
            raise ValidationError("A draft is required.")
        if self.account.provider == "gmail":
            result = self.call("POST", "/drafts/send", data={"id": raw}, sending=True)
            if not isinstance(result.get("id"), str) or not result["id"]:
                error = MailError("Gmail did not confirm the sent message ID. Check Sent before sending again.")
                error.uncertain = True
                raise error
            return {"status": "sent", "message_id": opaque_id(result["id"])}
        self.call("POST", "/messages/" + quote(raw, safe="") + "/send", sending=True)
        return {"status": "sent", "message_id": ""}

    def discard(self, identity):
        raw, kind = decode_id(identity)
        if kind != "draft":
            raise ValidationError("Only drafts may be permanently discarded.")
        if self.account.provider == "outlook":
            if not self.call("GET", "/messages/" + quote(raw, safe=""), params={"$select": "isDraft"}).get("isDraft"):
                raise ValidationError("Only drafts may be permanently discarded.")
        self.call("DELETE", ("/drafts/" if self.account.provider == "gmail" else "/messages/") + quote(raw, safe=""))

    def attachment(self, identity, attachment_id):
        # Verify that the attachment is part of the requested, authorized message.
        detail = self.detail(identity)
        meta = next((a for a in detail["attachments"] if a["id"] == attachment_id), None)
        if not meta:
            raise NotFound("Attachment not found.")
        if meta["size"] > 10 * 1024 * 1024:
            raise ValidationError("Open attachments larger than 10 MB in your provider's mailbox.")
        remote_attachment_id, _ = decode_id(attachment_id)
        raw, kind = decode_id(identity)
        if self.account.provider == "gmail":
            if kind == "draft":
                raw = self.call("GET", "/drafts/" + quote(raw, safe=""))["message"]["id"]
            data = self.call("GET", "/messages/" + quote(raw, safe="") + "/attachments/" + quote(remote_attachment_id, safe=""))
            content = b64decode(data["data"])
        else:
            data = self.call("GET", "/messages/" + quote(raw, safe="") + "/attachments/" + quote(remote_attachment_id, safe=""))
            content = base64.b64decode(data.get("contentBytes", ""))
        if len(content) > 10 * 1024 * 1024:
            raise ValidationError("Attachment exceeds the download limit.")
        return meta["name"], content
