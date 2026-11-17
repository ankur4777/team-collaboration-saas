import uuid
from django.conf import settings
from django.db import models


class MailAccount(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey("workspace.Organization", on_delete=models.CASCADE)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    provider = models.CharField(max_length=12, choices=[("local", "Workspace"), ("gmail", "Gmail"), ("outlook", "Outlook")])
    email = models.EmailField()
    display_name = models.CharField(max_length=150, blank=True)
    encrypted_tokens = models.TextField(blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    needs_reconnect = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["organization", "user", "provider", "email"], name="unique_personal_mail_account")]


class LocalMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    account = models.ForeignKey(MailAccount, related_name="local_messages", on_delete=models.CASCADE)
    folder = models.CharField(max_length=12, default="inbox")
    previous_folder = models.CharField(max_length=12, default="inbox")
    subject = models.CharField(max_length=255, blank=True)
    sender = models.EmailField()
    sender_name = models.CharField(max_length=150, blank=True)
    to = models.JSONField(default=list)
    cc = models.JSONField(default=list)
    bcc = models.JSONField(default=list)
    body = models.TextField(blank=True)
    is_read = models.BooleanField(default=False)
    is_starred = models.BooleanField(default=False)
    internet_id = models.CharField(max_length=255, blank=True)
    thread_id = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["account", "folder", "-created_at"])]


class LocalAttachment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(LocalMessage, related_name="files", on_delete=models.CASCADE)
    name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=120, default="application/octet-stream")
    content = models.BinaryField()
    size = models.PositiveIntegerField()


class OAuthAttempt(models.Model):
    state_hash = models.CharField(primary_key=True, max_length=64)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    organization = models.ForeignKey("workspace.Organization", on_delete=models.CASCADE)
    provider = models.CharField(max_length=12)
    session_hash = models.CharField(max_length=64)
    encrypted_verifier = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)


class SendAttempt(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    account = models.ForeignKey(MailAccount, on_delete=models.CASCADE)
    key = models.CharField(max_length=80)
    fingerprint = models.CharField(max_length=64)
    status = models.CharField(max_length=12, default="sending")
    draft_id = models.TextField(blank=True)
    result = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["account", "key"], name="unique_mail_send_request")]
