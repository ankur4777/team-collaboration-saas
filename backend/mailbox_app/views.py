import hashlib
import json
from urllib.parse import urlencode
from django.conf import settings
from django.db import transaction
from django.http import HttpResponse, HttpResponseRedirect
from django.shortcuts import get_object_or_404
from django.utils.http import content_disposition_header
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.exceptions import APIException, ValidationError
from workspace.permissions import get_active_membership
from .models import MailAccount, SendAttempt
from .local import LocalMailbox
from .providers import RemoteMailbox
from .serializers import ComposeSerializer, ActionSerializer
from .common import FOLDERS, ReconnectRequired
from . import oauth


def account_data(account):
    return {"id": str(account.pk), "provider": account.provider, "email": account.email,
            "display_name": account.display_name, "needs_reconnect": account.needs_reconnect}


class MailView(APIView):
    """Session auth + CSRF for writes; account visibility is always personal AND organization scoped."""
    def account_for(self, request, account_id):
        member = get_active_membership(request)
        self.account = get_object_or_404(MailAccount, pk=account_id, user=request.user, organization=member.organization)
        return self.account

    def mailbox(self, request, account_id):
        account = self.account_for(request, account_id)
        return LocalMailbox(account) if account.provider == "local" else RemoteMailbox(account)

    def handle_exception(self, exc):
        if isinstance(exc, ReconnectRequired) and hasattr(self, "account"):
            MailAccount.objects.filter(pk=self.account.pk).update(needs_reconnect=True)
        return super().handle_exception(exc)


class ConfigurationView(MailView):
    def get(self, request):
        get_active_membership(request)
        return Response({
            "local_enabled": settings.MAIL_LOCAL_ENABLED,
            "gmail_configured": oauth.configured("gmail"),
            "outlook_configured": oauth.configured("outlook"),
            "max_attachment_bytes": 5 * 1024 * 1024,
            "max_total_attachment_bytes": 10 * 1024 * 1024,
        })


class AccountsView(MailView):
    def get(self, request):
        member = get_active_membership(request)
        return Response([account_data(a) for a in MailAccount.objects.filter(
            user=request.user, organization=member.organization).order_by("created_at")])

    def post(self, request):
        member = get_active_membership(request)
        if not settings.MAIL_LOCAL_ENABLED or request.data.get("provider") != "local":
            raise ValidationError("Use the provider connection flow to add this mailbox.")
        account, created = MailAccount.objects.get_or_create(
            user=request.user, organization=member.organization, provider="local",
            email=request.user.email.lower(), defaults={"display_name": request.user.full_name},
        )
        return Response(account_data(account), status=201 if created else 200)


class AccountDetailView(MailView):
    def delete(self, request, account_id):
        account = self.account_for(request, account_id)
        account.delete()
        return Response(status=204)


class OAuthStartView(MailView):
    def post(self, request, provider):
        return Response({"authorization_url": oauth.start(request, get_active_membership(request), provider)})


class OAuthCallbackView(MailView):
    def get(self, request, provider):
        try:
            oauth.finish(request, get_active_membership(request), provider)
            query = {"mail": "connected"}
        except (APIException, ValueError) as exc:
            # User-visible generic message only; never place provider codes/tokens in a URL.
            query = {"mail": "error", "mail_reason": str(exc.detail) if isinstance(exc, APIException) else "Mailbox connection failed."}
        return HttpResponseRedirect(settings.FRONTEND_ORIGIN + "/?" + urlencode(query))


class FoldersView(MailView):
    def get(self, request, account_id):
        return Response(self.mailbox(request, account_id).folders())


class MessagesView(MailView):
    def get(self, request, account_id):
        folder = request.query_params.get("folder", "inbox")
        query = request.query_params.get("q", "").strip()
        cursor = request.query_params.get("cursor", "")
        if folder not in FOLDERS or len(query) > 200 or len(cursor) > 12_000:
            raise ValidationError("Invalid folder, search or page cursor.")
        return Response(self.mailbox(request, account_id).messages(folder, query, cursor))


class MessageDetailView(MailView):
    def get(self, request, account_id, message_id):
        mailbox = self.mailbox(request, account_id)
        if isinstance(mailbox, RemoteMailbox):
            folder = request.query_params.get("folder", "inbox")
            if folder not in FOLDERS:
                raise ValidationError("Invalid folder.")
            return Response(mailbox.detail(message_id, folder))
        return Response(mailbox.detail(message_id))


class MessageActionView(MailView):
    def post(self, request, account_id, message_id):
        serializer = ActionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(self.mailbox(request, account_id).action(message_id, serializer.validated_data["action"]))


class AttachmentView(MailView):
    def get(self, request, account_id, message_id, attachment_id):
        if len(attachment_id) > 1500:
            raise ValidationError("Invalid attachment identifier.")
        name, content = self.mailbox(request, account_id).attachment(message_id, attachment_id)
        response = HttpResponse(content, content_type="application/octet-stream")
        name = name.replace("\\", "/").split("/")[-1]
        response["Content-Disposition"] = content_disposition_header(True, name or "attachment")
        response["X-Content-Type-Options"] = "nosniff"
        response["Cache-Control"] = "no-store"
        return response


class DraftsView(MailView):
    def post(self, request, account_id):
        serializer = ComposeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        identity = self.mailbox(request, account_id).draft(serializer.validated_data)
        return Response({"draft_id": identity}, status=201)


class DraftDetailView(MailView):
    def delete(self, request, account_id, message_id):
        self.mailbox(request, account_id).discard(message_id)
        return Response(status=204)


class SendView(MailView):
    def post(self, request, account_id):
        serializer = ComposeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = serializer.validated_data
        if not (payload["to"] or payload["cc"] or payload["bcc"]):
            raise ValidationError("Add at least one recipient.")
        key = request.headers.get("Idempotency-Key", "")
        if not key or len(key) > 80 or not all(c.isalnum() or c in "-_" for c in key):
            raise ValidationError("A valid Idempotency-Key header is required.")
        account = self.account_for(request, account_id)
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        with transaction.atomic():
            attempt, created = SendAttempt.objects.select_for_update().get_or_create(
                account=account, key=key, defaults={"fingerprint": fingerprint, "status": "sending"},
            )
            if not created:
                if attempt.fingerprint != fingerprint:
                    raise ValidationError("This send key belongs to a different message.")
                if attempt.status == "sent":
                    return Response(attempt.result)
                if attempt.status in ("sending", "uncertain"):
                    return Response({"status": "uncertain", "draft_id": attempt.draft_id,
                                     "detail": "A previous send may have completed. Check Sent in the provider mailbox before creating a new send."}, status=202)
                return Response({"status": "failed", "detail": "The previous send was rejected. Review the message and start a new send request."}, status=409)
        send_started = False
        try:
            mailbox = LocalMailbox(account) if account.provider == "local" else RemoteMailbox(account)
            identity = mailbox.draft(payload)
            SendAttempt.objects.filter(pk=attempt.pk).update(draft_id=identity)
            send_started = True
            result = mailbox.send_draft(identity)
            SendAttempt.objects.filter(pk=attempt.pk).update(status="sent", result=result)
            return Response(result)
        except APIException as exc:
            uncertain = bool(getattr(exc, "uncertain", False))
            SendAttempt.objects.filter(pk=attempt.pk).update(status="uncertain" if uncertain else "failed")
            if isinstance(exc, ReconnectRequired):
                MailAccount.objects.filter(pk=account.pk).update(needs_reconnect=True)
            return Response({"status": "uncertain" if uncertain else "failed",
                             "draft_id": locals().get("identity", ""), "detail": str(exc.detail)},
                            status=202 if uncertain else exc.status_code)
        except Exception:
            SendAttempt.objects.filter(pk=attempt.pk).update(status="uncertain" if send_started else "failed")
            raise
