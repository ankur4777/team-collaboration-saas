import base64
import hashlib
import json
from datetime import timedelta
from unittest.mock import patch, Mock
from urllib.parse import urlparse, parse_qs
from cryptography.fernet import Fernet
from django.test import TestCase, Client, override_settings
from django.utils import timezone
from rest_framework.exceptions import ValidationError
from workspace.models import User, Organization, OrganizationMember
from mailbox_app.models import MailAccount, LocalMessage, SendAttempt, OAuthAttempt
from mailbox_app.common import MailError, opaque_id, plain_html
from mailbox_app.local import LocalMailbox
from mailbox_app.providers import RemoteMailbox
from mailbox_app import oauth


class MailTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(email="alice@example.test", password="ValidPassword42!", full_name="Alice", email_verified_at=timezone.now())
        self.bob = User.objects.create_user(email="bob@example.test", password="ValidPassword42!", full_name="Bob")
        self.eve = User.objects.create_user(email="eve@example.test", password="ValidPassword42!", full_name="Eve")
        self.org = Organization.objects.create(name="Company", slug="company", created_by=self.user)
        self.other = Organization.objects.create(name="Other", slug="other", created_by=self.eve)
        OrganizationMember.objects.create(user=self.user, organization=self.org, role="owner")
        OrganizationMember.objects.create(user=self.bob, organization=self.org, role="member")
        OrganizationMember.objects.create(user=self.eve, organization=self.other, role="owner")
        self.a = MailAccount.objects.create(user=self.user, organization=self.org, provider="local", email=self.user.email, display_name="Alice")
        self.b = MailAccount.objects.create(user=self.bob, organization=self.org, provider="local", email=self.bob.email, display_name="Bob")
        self.c = Client(enforce_csrf_checks=True)
        self.login(self.user, self.org)
        self.path = "/api/mail/accounts/" + str(self.a.pk) + "/"

    def login(self, user, organization):
        self.c.force_login(user)
        session = self.c.session
        session["active_organization_id"] = str(organization.pk)
        session.save()
        self.csrf = self.c.get("/api/auth/csrf/").json()["csrf_token"]

    def post(self, path, payload, key=None):
        return self.c.post(path, data=json.dumps(payload), content_type="application/json",
                           HTTP_X_CSRFTOKEN=self.csrf, **({"HTTP_IDEMPOTENCY_KEY": key} if key else {}))

    def payload(self, **kwargs):
        return {"to": [self.bob.email], "cc": [], "bcc": [], "subject": "Quarterly report", "body": "Please review the report.",
                "attachments": [], "draft_id": "", "reply_id": "", "mode": "new", **kwargs}

    def test_delivery_idempotency_and_bcc_privacy(self):
        payload = self.payload(to=[self.user.email], bcc=[self.bob.email])
        first = self.post(self.path + "send/", payload, "send-1")
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(self.post(self.path + "send/", payload, "send-1").status_code, 200)
        self.assertEqual(LocalMessage.objects.filter(account=self.a, folder="sent").count(), 1)
        self.assertEqual(LocalMessage.objects.filter(account=self.b, folder="inbox").count(), 1)
        incoming = LocalMessage.objects.get(account=self.b)
        self.assertEqual(incoming.bcc, [])
        self.assertEqual(self.post(self.path + "send/", self.payload(body="Changed"), "send-1").status_code, 400)

    def test_draft_save_update_attachment_and_discard(self):
        data = self.payload(attachments=[{"name": "report.txt", "content_type": "text/plain", "data": base64.b64encode(b"report contents").decode()}])
        response = self.post(self.path + "drafts/", data)
        self.assertEqual(response.status_code, 201, response.content)
        identity = response.json()["draft_id"]
        data["draft_id"] = identity
        data["body"] = "Updated"
        self.assertEqual(self.post(self.path + "drafts/", data).status_code, 201)
        self.assertEqual(LocalMessage.objects.filter(account=self.a).count(), 1)
        detail = self.c.get(self.path + "messages/" + identity + "/").json()
        self.assertEqual(detail["body"], "Updated")
        file_id = detail["attachments"][0]["id"]
        attachment = self.c.get(self.path + "messages/" + identity + "/attachments/" + file_id + "/")
        self.assertEqual(attachment.content, b"report contents")
        self.assertIn("attachment", attachment["Content-Disposition"])
        result = self.c.delete(self.path + "drafts/" + identity + "/", HTTP_X_CSRFTOKEN=self.csrf)
        self.assertEqual(result.status_code, 204)
        self.assertFalse(LocalMessage.objects.filter(account=self.a).exists())

    def test_read_star_move_restore_and_search(self):
        self.post(self.path + "send/", self.payload(), "send-2")
        self.login(self.bob, self.org)
        path = "/api/mail/accounts/" + str(self.b.pk) + "/"
        results = self.c.get(path + "messages/?folder=inbox&q=Quarterly").json()["results"]
        identity = results[0]["id"]
        for action, field, expected in [("read", "is_read", True), ("star", "is_starred", True), ("trash", "folder", "trash"), ("restore", "folder", "inbox")]:
            r = self.post(path + "messages/" + identity + "/actions/", {"action": action})
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(r.json()[field], expected)
        self.assertEqual(len(self.c.get(path + "messages/?folder=starred").json()["results"]), 1)

    def test_cross_user_cross_organization_and_offboarding(self):
        local = LocalMessage.objects.create(account=self.b, sender="bob@example.test", body="private")
        forbidden_path = "/api/mail/accounts/" + str(self.b.pk) + "/messages/" + opaque_id(local.pk) + "/"
        self.assertEqual(self.c.get(forbidden_path).status_code, 404)
        self.login(self.eve, self.other)
        self.assertEqual(self.c.get(self.path + "messages/").status_code, 404)
        self.login(self.user, self.org)
        OrganizationMember.objects.filter(user=self.user, organization=self.org).delete()
        self.assertEqual(self.c.get(self.path + "messages/").status_code, 403)

    def test_csrf_authentication_and_external_local_delivery(self):
        self.assertEqual(self.c.post(self.path + "send/", data="{}", content_type="application/json").status_code, 403)
        r = self.post(self.path + "send/", self.payload(to=["external@example.net"]), "external")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(LocalMessage.objects.filter(folder="sent").exists())
        self.c.logout()
        self.assertIn(self.c.get("/api/mail/accounts/").status_code, (401, 403))

    def test_validation_and_page_isolation(self):
        invalid = self.post(self.path + "drafts/", self.payload(subject="Injected\r\nBcc: x@y.test"))
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(self.post(self.path + "drafts/", self.payload(attachments=[{"name":"x", "data":"%%%"}])).status_code, 400)
        for i in range(28):
            LocalMessage.objects.create(account=self.a, sender=self.user.email, subject="Item " + str(i))
        first = self.c.get(self.path + "messages/").json()
        self.assertEqual(len(first["results"]), 25)
        second = self.c.get(self.path + "messages/?cursor=" + first["next_cursor"]).json()
        self.assertEqual(len(second["results"]), 3)
        self.assertFalse({r["id"] for r in first["results"]} & {r["id"] for r in second["results"]})

    def test_uncertain_send_is_never_retried(self):
        account = MailAccount.objects.create(user=self.user, organization=self.org, provider="gmail", email="alice@gmail.com")
        fake = Mock()
        fake.draft.return_value = opaque_id("draft123", "draft")
        error = MailError("Uncertain")
        error.uncertain = True
        fake.send_draft.side_effect = error
        path = "/api/mail/accounts/" + str(account.pk) + "/send/"
        with patch("mailbox_app.views.RemoteMailbox", return_value=fake):
            self.assertEqual(self.post(path, self.payload(), "uncertain-1").status_code, 202)
            self.assertEqual(self.post(path, self.payload(), "uncertain-1").status_code, 202)
            self.assertEqual(fake.send_draft.call_count, 1)

    @override_settings(MAIL_TOKEN_ENCRYPTION_KEY=Fernet.generate_key().decode(), MAIL_GOOGLE_CLIENT_ID="client", MAIL_GOOGLE_CLIENT_SECRET="secret")
    def test_oauth_state_is_session_bound_single_use_and_tokens_encrypted(self):
        start = self.post("/api/mail/oauth/gmail/start/", {})
        self.assertEqual(start.status_code, 200, start.content)
        values = parse_qs(urlparse(start.json()["authorization_url"]).query)
        self.assertEqual(values["code_challenge_method"], ["S256"])
        state = values["state"][0]
        profile = Mock(status_code=200)
        profile.json.return_value = {"emailAddress": "alice@gmail.com"}
        with patch("mailbox_app.oauth.token_request", return_value={"access_token": "private-access", "refresh_token": "private-refresh", "expires_in": 3600}), patch("mailbox_app.oauth.httpx.get", return_value=profile):
            callback = self.c.get("/api/mail/oauth/gmail/callback/?state=" + state + "&code=one-time-code")
            self.assertEqual(callback.status_code, 302)
            self.assertIn("mail=connected", callback.url)
            account = MailAccount.objects.get(provider="gmail")
            self.assertNotIn("private-access", account.encrypted_tokens)
            self.assertEqual(oauth.decrypt(account.encrypted_tokens)["refresh_token"], "private-refresh")
            self.assertFalse(OAuthAttempt.objects.exists())
            again = self.c.get("/api/mail/oauth/gmail/callback/?state=" + state + "&code=one-time-code")
            self.assertIn("mail=error", again.url)
        listed = self.c.get("/api/mail/accounts/").content.decode()
        self.assertNotIn("private-access", listed)
        self.assertNotIn("encrypted_tokens", listed)

    @override_settings(MAIL_TOKEN_ENCRYPTION_KEY=Fernet.generate_key().decode(), MAIL_GOOGLE_CLIENT_ID="client", MAIL_GOOGLE_CLIENT_SECRET="secret")
    def test_oauth_other_browser_cannot_consume_state(self):
        url = self.post("/api/mail/oauth/gmail/start/", {}).json()["authorization_url"]
        state = parse_qs(urlparse(url).query)["state"][0]
        other = Client()
        other.force_login(self.user)
        session = other.session
        session["active_organization_id"] = str(self.org.pk)
        session.save()
        result = other.get("/api/mail/oauth/gmail/callback/?state=" + state + "&code=bad")
        self.assertIn("mail=error", result.url)
        self.assertEqual(OAuthAttempt.objects.count(), 1)

    def test_oauth_requires_verified_user(self):
        self.login(self.bob, self.org)
        with override_settings(MAIL_TOKEN_ENCRYPTION_KEY=Fernet.generate_key().decode(), MAIL_GOOGLE_CLIENT_ID="client", MAIL_GOOGLE_CLIENT_SECRET="secret"):
            self.assertEqual(self.post("/api/mail/oauth/gmail/start/", {}).status_code, 400)

    def test_same_user_switching_workspace_cannot_read_other_workspace_mail(self):
        OrganizationMember.objects.create(user=self.user, organization=self.other, role="member")
        session = self.c.session
        session["active_organization_id"] = str(self.other.pk)
        session.save()
        self.assertEqual(self.c.get(self.path + "messages/").status_code, 404)

    def test_plain_html_drops_scripts_and_never_returns_executable_markup(self):
        self.assertEqual(plain_html("<p>Hello</p><script>alert(1)</script><img src=x onerror=evil()>World"), "HelloWorld")


class ProviderTests(TestCase):
    def setUp(self):
        self.account = Mock(pk="account-one", provider="gmail", email="owner@gmail.com")
        with patch("mailbox_app.providers.access_token", return_value="token"):
            self.adapter = RemoteMailbox(self.account)

    def test_gmail_mime_recipients_thread_and_attachment(self):
        captured = {}
        def call(method, path, **kwargs):
            captured.update(method=method, path=path, **kwargs)
            return {"id": "draft-remote"}
        self.adapter.call = call
        self.adapter.detail = Mock(return_value={"internet_id": "<thread@example.test>", "thread_id": "thread1"})
        payload = {"to":["bob@example.test"],"cc":[],"bcc":["hidden@example.test"],"subject":"Re: hello","body":"Reply",
                   "attachments":[{"name":"a.txt","data":base64.b64encode(b"file").decode()}],
                   "draft_id":"","reply_id":opaque_id("message1"),"mode":"reply"}
        result = self.adapter.draft(payload)
        from email import message_from_bytes
        from mailbox_app.common import b64decode
        mime = message_from_bytes(b64decode(captured["data"]["message"]["raw"]))
        self.assertEqual(mime["To"], "bob@example.test")
        self.assertEqual(mime["Bcc"], "hidden@example.test")
        self.assertEqual(mime["In-Reply-To"], "<thread@example.test>")
        self.assertEqual(captured["data"]["message"]["threadId"], "thread1")
        self.assertEqual(result, opaque_id("draft-remote", "draft"))

    def test_gmail_list_tolerates_concurrently_removed_messages_and_drafts(self):
        from rest_framework.exceptions import NotFound
        for folder, resource in (("inbox", "messages"), ("drafts", "drafts")):
            def call(method, path, **kwargs):
                if path == "/" + resource:
                    return {resource: [{"id": "gone"}, {"id": "present"}], "nextPageToken": "next"}
                if path.endswith("/gone"):
                    raise NotFound("Removed by another client")
                message = {"id": "m1", "labelIds": ["INBOX"], "internalDate": "1700000000000"}
                return {"id": "present", "message": message} if resource == "drafts" else message
            self.adapter.call = call
            page = self.adapter.messages(folder)
            expected = opaque_id("present", "draft") if resource == "drafts" else opaque_id("m1")
            self.assertEqual([row["id"] for row in page["results"]], [expected])
            self.assertEqual(self.adapter.uncursor(page["next_cursor"], folder, ""), "next")

    def test_gmail_list_does_not_hide_provider_errors(self):
        def call(method, path, **kwargs):
            if path == "/messages":
                return {"messages": [{"id": "m1"}]}
            raise MailError("Provider unavailable")
        self.adapter.call = call
        with self.assertRaises(MailError):
            self.adapter.messages("inbox")

    def test_provider_page_tokens_bound_to_account_and_query(self):
        cursor = self.adapter.cursor("page", "inbox", "hello")
        self.assertEqual(self.adapter.uncursor(cursor, "inbox", "hello"), "page")
        with self.assertRaises(ValidationError):
            self.adapter.uncursor(cursor, "sent", "hello")

    def test_graph_rejects_non_draft_delete(self):
        self.adapter.account.provider = "outlook"
        self.adapter.call = Mock(return_value={"isDraft": False})
        with self.assertRaises(ValidationError):
            self.adapter.discard(opaque_id("message", "draft"))

    def test_gmail_normalization_plain_text_and_downloads(self):
        raw = {"id":"m1","labelIds":["INBOX","UNREAD"],"internalDate":"1700000000000","payload":{
            "headers":[{"name":"From","value":"Sender <sender@example.test>"},{"name":"Subject","value":"Hi"}],
            "parts":[{"mimeType":"text/html","body":{"data":base64.urlsafe_b64encode(b"<b>Hello</b><script>bad()</script>").decode()}},
                     {"filename":"file.txt","mimeType":"text/plain","body":{"attachmentId":"a1","size":7}}]}}
        result = self.adapter.gmail_normalize(raw, detail=True)
        self.assertEqual(result["body"], "Hello")
        self.assertEqual(result["sender"], "sender@example.test")
        self.assertFalse(result["is_read"])
        self.assertEqual(result["attachments"][0]["id"], opaque_id("a1"))

    def test_graph_large_attachment_uses_signed_url_without_bearer_token(self):
        self.adapter.account.provider = "outlook"
        self.adapter.call = Mock(return_value={"uploadUrl": "https://outlook.office.com/api/upload?authtoken=private"})
        content = b"x" * (3 * 1024 * 1024)
        with patch("mailbox_app.providers.httpx.put") as put:
            put.side_effect = [Mock(status_code=200), Mock(status_code=201)]
            self.adapter.graph_attach("message1", {"name": "large.bin", "data": base64.b64encode(content).decode()})
            self.assertEqual(put.call_count, 2)
            for call in put.call_args_list:
                self.assertNotIn("Authorization", call.kwargs["headers"])
                self.assertFalse(call.kwargs["follow_redirects"])
        self.adapter.call.return_value = {"uploadUrl": "https://attacker.example/upload"}
        with self.assertRaises(MailError):
            self.adapter.graph_attach("message1", {"name":"x", "data":base64.b64encode(content).decode()})

    def test_graph_next_page_cannot_target_another_host(self):
        self.adapter.account.provider = "outlook"
        bad = self.adapter.cursor("https://attacker.example/steal", "inbox", "")
        with self.assertRaises(ValidationError):
            self.adapter.messages("inbox", cursor=bad)

    def test_token_refresh_preserves_rotated_refresh_token(self):
        from mailbox_app.models import MailAccount
        user = User.objects.create_user(email="tokens@example.test", password="Password42!", full_name="Token Test")
        org = Organization.objects.create(name="Tokens", slug="tokens", created_by=user)
        key = Fernet.generate_key().decode()
        with override_settings(MAIL_TOKEN_ENCRYPTION_KEY=key):
            a = MailAccount.objects.create(user=user, organization=org, provider="gmail", email=user.email,
                encrypted_tokens=oauth.encrypt({"access_token":"old","refresh_token":"refresh-old"}), expires_at=timezone.now()-timedelta(seconds=1))
            with patch("mailbox_app.oauth.token_request", return_value={"access_token":"new","refresh_token":"refresh-new","expires_in":3600}):
                self.assertEqual(oauth.access_token(a), "new")
            a.refresh_from_db()
            self.assertEqual(oauth.decrypt(a.encrypted_tokens)["refresh_token"], "refresh-new")
