import base64
import uuid
from django.db import transaction
from django.db.models import Q, Count
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import ValidationError
from .models import LocalMessage, LocalAttachment, MailAccount
from .common import FOLDERS, opaque_id, decode_id


class LocalMailbox:
    def __init__(self, account):
        self.account = account

    def get(self, identity):
        raw, _ = decode_id(identity)
        try:
            return get_object_or_404(LocalMessage, pk=uuid.UUID(raw), account=self.account)
        except ValueError:
            raise ValidationError("Invalid message identifier.")

    def normalize(self, message, detail=False):
        data = {
            "id": opaque_id(message.pk, "draft" if message.folder == "drafts" else "message"),
            "subject": message.subject, "sender": message.sender, "sender_name": message.sender_name,
            "to": message.to, "cc": message.cc, "bcc": message.bcc if message.folder in ("drafts", "sent") else [],
            "preview": message.body[:180], "date": message.created_at.isoformat(),
            "is_read": message.is_read, "is_starred": message.is_starred, "folder": message.folder,
            "has_attachments": message.files.exists(), "thread_id": message.thread_id,
            "reply_to": [message.sender], "internet_id": message.internet_id,
        }
        if detail:
            data.update(body=message.body, attachments=[
                {"id": str(a.pk), "name": a.name, "size": a.size, "content_type": a.content_type}
                for a in message.files.all()
            ])
        return data

    def folders(self):
        rows = self.account.local_messages.values("folder").annotate(total=Count("id"), unread=Count("id", filter=Q(is_read=False)))
        counts = {r["folder"]: r for r in rows}
        starred = self.account.local_messages.filter(is_starred=True).exclude(folder__in=["trash", "drafts"])
        counts["starred"] = {"total": starred.count(), "unread": starred.filter(is_read=False).count()}
        return [{"id": f, "name": f.title(), "total": counts.get(f, {}).get("total", 0),
                 "unread": counts.get(f, {}).get("unread", 0)} for f in FOLDERS]

    def messages(self, folder, query="", cursor=""):
        rows = self.account.local_messages.prefetch_related("files")
        rows = rows.filter(is_starred=True).exclude(folder__in=["trash", "drafts"]) if folder == "starred" else rows.filter(folder=folder)
        if query:
            rows = rows.filter(Q(subject__icontains=query) | Q(body__icontains=query) | Q(sender__icontains=query))
        try:
            offset = int(cursor or "0")
            if offset < 0 or offset > 100_000:
                raise ValueError()
        except ValueError:
            raise ValidationError("Invalid page cursor.")
        page = list(rows[offset:offset + 26])
        return {"results": [self.normalize(m) for m in page[:25]], "next_cursor": str(offset + 25) if len(page) > 25 else ""}

    def detail(self, identity):
        return self.normalize(self.get(identity), True)

    def action(self, identity, action):
        m = self.get(identity)
        if action in ("read", "unread"):
            m.is_read = action == "read"
        elif action in ("star", "unstar"):
            m.is_starred = action == "star"
        else:
            if m.folder == "drafts":
                raise ValidationError("Discard this draft using the draft delete action.")
            if action == "trash":
                m.previous_folder, m.folder = m.folder, "trash"
            else:
                m.folder = m.previous_folder if action == "restore" else action
        m.save()
        return self.normalize(m, True)

    def attachment(self, identity, attachment_id):
        m = self.get(identity)
        try:
            a = get_object_or_404(LocalAttachment, pk=uuid.UUID(attachment_id), message=m)
        except ValueError:
            raise ValidationError("Invalid attachment identifier.")
        return a.name, bytes(a.content)

    @transaction.atomic
    def draft(self, payload):
        if payload.get("draft_id"):
            m = self.get(payload["draft_id"])
            if m.folder != "drafts":
                raise ValidationError("Only drafts can be edited.")
        else:
            m = LocalMessage(account=self.account, folder="drafts", sender=self.account.email,
                             sender_name=self.account.display_name, is_read=True)
        for field in ("to", "cc", "bcc", "subject", "body"):
            setattr(m, field, payload[field])
        m.thread_id = self.get(payload["reply_id"]).thread_id if payload.get("reply_id") else m.thread_id or str(uuid.uuid4())
        m.save()
        m.files.all().delete()
        for f in payload["attachments"]:
            LocalAttachment.objects.create(message=m, name=f["name"], content_type=f["content_type"],
                                           content=base64.b64decode(f["data"]), size=f["size"])
        return opaque_id(m.pk, "draft")

    def discard(self, identity):
        m = self.get(identity)
        if m.folder != "drafts":
            raise ValidationError("Only drafts may be permanently discarded.")
        m.delete()

    @transaction.atomic
    def send_draft(self, identity):
        m = self.get(identity)
        if m.folder != "drafts":
            raise ValidationError("This draft was already sent.")
        recipients = set(e.lower() for e in m.to + m.cc + m.bcc)
        targets = list(MailAccount.objects.filter(
            provider="local", organization=self.account.organization, email__in=recipients,
            user__is_active=True,
        ))
        # Membership is checked separately to avoid depending on a reverse relation name.
        from workspace.models import OrganizationMember
        targets = [a for a in targets if OrganizationMember.objects.filter(
            user=a.user, organization=self.account.organization).exists()]
        known = {a.email.lower() for a in targets}
        if recipients - known:
            raise ValidationError("Local mail delivers only to connected local mailboxes in this workspace. Connect Gmail/Outlook for external recipients.")
        m.folder = "sent"
        m.internet_id = "<" + str(uuid.uuid4()) + "@teamworkspace.local>"
        m.save()
        files = list(m.files.all())
        for target in targets:
            copy = LocalMessage.objects.create(
                account=target, folder="inbox", sender=m.sender, sender_name=m.sender_name,
                to=m.to, cc=m.cc, bcc=[], subject=m.subject, body=m.body, is_read=False,
                internet_id=m.internet_id, thread_id=m.thread_id,
            )
            LocalAttachment.objects.bulk_create([LocalAttachment(
                message=copy, name=f.name, content_type=f.content_type, content=f.content, size=f.size
            ) for f in files])
        return {"status": "sent", "message_id": opaque_id(m.pk)}
