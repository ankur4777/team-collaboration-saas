import hashlib
import json
import secrets
import re
from datetime import timedelta
from urllib.parse import urlencode
import httpx
from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import salted_hmac
from rest_framework.exceptions import ValidationError
from .common import MailError, ReconnectRequired, b64encode
from .models import MailAccount, OAuthAttempt

GOOGLE_SCOPE = "https://www.googleapis.com/auth/gmail.modify"
MICROSOFT_SCOPE = "offline_access User.Read Mail.ReadWrite Mail.Send"


def cipher():
    try:
        return Fernet(settings.MAIL_TOKEN_ENCRYPTION_KEY.encode())
    except (ValueError, AttributeError):
        raise MailError("Configure a valid MAIL_TOKEN_ENCRYPTION_KEY on the backend.")


def encrypt(value):
    return cipher().encrypt(json.dumps(value).encode()).decode()


def decrypt(value):
    try:
        return json.loads(cipher().decrypt(value.encode()))
    except (InvalidToken, ValueError, TypeError):
        raise ReconnectRequired("Mailbox credentials could not be decrypted. Check the server encryption key or reconnect.")


def provider_config(provider):
    if provider == "gmail":
        return {
            "client_id": settings.MAIL_GOOGLE_CLIENT_ID, "client_secret": settings.MAIL_GOOGLE_CLIENT_SECRET,
            "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
            "token": "https://oauth2.googleapis.com/token", "scope": GOOGLE_SCOPE,
        }
    if provider == "outlook":
        tenant = settings.MAIL_MICROSOFT_TENANT
        if not re.fullmatch(r"(common|organizations|consumers|[0-9a-fA-F-]{36})", tenant):
            raise MailError("Invalid Microsoft tenant configuration.")
        base = "https://login.microsoftonline.com/" + tenant + "/oauth2/v2.0/"
        return {"client_id": settings.MAIL_MICROSOFT_CLIENT_ID, "client_secret": settings.MAIL_MICROSOFT_CLIENT_SECRET,
                "authorize": base + "authorize", "token": base + "token", "scope": MICROSOFT_SCOPE}
    raise ValidationError("Unknown mailbox provider.")


def redirect_uri(provider):
    return settings.MAIL_CALLBACK_ORIGIN.rstrip("/") + "/api/mail/oauth/" + provider + "/callback/"


def configured(provider):
    c = provider_config(provider)
    if not c["client_id"] or not c["client_secret"] or not settings.MAIL_TOKEN_ENCRYPTION_KEY:
        return False
    cipher()
    return True


def session_hash(request):
    return salted_hmac("mail-oauth-session", request.session.session_key or "").hexdigest()


def start(request, membership, provider):
    if not configured(provider):
        raise ValidationError("This mail provider has not been enabled. Ask your administrator to configure the connection.")
    if not request.user.email_verified_at:
        raise ValidationError("Verify your TeamWorkspace email address before connecting a mailbox.")
    state, verifier = secrets.token_urlsafe(40), secrets.token_urlsafe(64)
    OAuthAttempt.objects.filter(created_at__lt=timezone.now() - timedelta(minutes=10)).delete()
    OAuthAttempt.objects.create(
        state_hash=hashlib.sha256(state.encode()).hexdigest(), user=request.user,
        organization=membership.organization, provider=provider, session_hash=session_hash(request),
        encrypted_verifier=encrypt({"verifier": verifier}),
    )
    cfg = provider_config(provider)
    params = {
        "client_id": cfg["client_id"], "redirect_uri": redirect_uri(provider), "response_type": "code",
        "scope": cfg["scope"], "state": state, "code_challenge_method": "S256",
        "code_challenge": b64encode(hashlib.sha256(verifier.encode()).digest()),
    }
    if provider == "gmail":
        params.update(access_type="offline", prompt="consent")
    return cfg["authorize"] + "?" + urlencode(params)


def token_request(provider, data):
    cfg = provider_config(provider)
    try:
        response = httpx.post(cfg["token"], data={
            "client_id": cfg["client_id"], "client_secret": cfg["client_secret"], **data
        }, timeout=20, follow_redirects=False)
    except httpx.HTTPError:
        raise MailError("The authorization server is unavailable. Try connecting again.")
    if response.status_code != 200:
        # Do not forward token responses, request headers, secrets or authorization codes.
        raise ReconnectRequired("The provider rejected authorization. Reconnect the mailbox.")
    result = response.json()
    if not result.get("access_token"):
        raise MailError("The provider returned no access token.")
    return result


def finish(request, membership, provider):
    state = request.GET.get("state", "")
    if not state or len(state) > 200:
        raise ValidationError("Missing OAuth state.")
    with transaction.atomic():
        attempt = OAuthAttempt.objects.select_for_update().filter(
            state_hash=hashlib.sha256(state.encode()).hexdigest()
        ).first()
        if (attempt is None or attempt.provider != provider or attempt.user_id != request.user.pk
                or attempt.organization_id != membership.organization_id
                or attempt.session_hash != session_hash(request)
                or attempt.created_at < timezone.now() - timedelta(minutes=10)):
            raise ValidationError("The connection request expired or belongs to a different browser/workspace.")
        verifier = decrypt(attempt.encrypted_verifier)["verifier"]
        attempt.delete()  # One use, including consent denial and exchange failure.
    if request.GET.get("error"):
        raise ValidationError("Mailbox connection was cancelled or denied.")
    code = request.GET.get("code", "")
    if not code or len(code) > 4096:
        raise ValidationError("Missing authorization code.")
    tokens = token_request(provider, {"grant_type": "authorization_code", "code": code,
                                     "redirect_uri": redirect_uri(provider), "code_verifier": verifier})
    granted = {s.rsplit("/", 1)[-1].lower() for s in tokens.get("scope", "").split()}
    expected = {"gmail.modify"} if provider == "gmail" else {"mail.readwrite", "mail.send", "user.read"}
    if granted and not expected.issubset(granted):
        raise ValidationError("Required mailbox permissions were not granted.")
    profile_url = ("https://gmail.googleapis.com/gmail/v1/users/me/profile" if provider == "gmail"
                   else "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName")
    try:
        result = httpx.get(profile_url, headers={"Authorization": "Bearer " + tokens["access_token"]},
                           timeout=20, follow_redirects=False)
        if result.status_code != 200:
            raise MailError("Unable to read the connected mailbox identity.")
        profile = result.json()
    except httpx.HTTPError:
        raise MailError("Unable to read the connected mailbox identity.")
    email = profile.get("emailAddress") if provider == "gmail" else profile.get("mail") or profile.get("userPrincipalName")
    from django.core.validators import validate_email
    validate_email(email or "")
    with transaction.atomic():
        account, _ = MailAccount.objects.select_for_update().get_or_create(
            user=request.user, organization=membership.organization, provider=provider, email=email.lower(),
        )
        if not tokens.get("refresh_token") and account.encrypted_tokens:
            tokens["refresh_token"] = decrypt(account.encrypted_tokens).get("refresh_token", "")
        if not tokens.get("refresh_token"):
            raise ValidationError("No offline access token was issued. Reconnect and grant offline access.")
        account.encrypted_tokens = encrypt(tokens)
        account.expires_at = timezone.now() + timedelta(seconds=int(tokens.get("expires_in", 3600)))
        account.display_name = profile.get("displayName", "") or email
        account.needs_reconnect = False
        account.save()
    return account


def access_token(account):
    with transaction.atomic():
        locked = MailAccount.objects.select_for_update().get(pk=account.pk)
        if locked.needs_reconnect:
            raise ReconnectRequired()
        tokens = decrypt(locked.encrypted_tokens)
        if locked.expires_at and locked.expires_at > timezone.now() + timedelta(seconds=90):
            return tokens["access_token"]
        if not tokens.get("refresh_token"):
            raise ReconnectRequired()
        try:
            renewed = token_request(locked.provider, {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
        except ReconnectRequired:
            # Mark outside this transaction in the request error handler.
            raise
        renewed["refresh_token"] = renewed.get("refresh_token") or tokens["refresh_token"]
        locked.encrypted_tokens = encrypt(renewed)
        locked.expires_at = timezone.now() + timedelta(seconds=int(renewed.get("expires_in", 3600)))
        locked.save(update_fields=["encrypted_tokens", "expires_at"])
        return renewed["access_token"]
