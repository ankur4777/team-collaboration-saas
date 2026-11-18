"""Non-secret provider configuration diagnostics; never include credential values."""
import ipaddress
from urllib.parse import urlsplit
from uuid import UUID
from cryptography.fernet import Fernet
from django.conf import settings


def valid_callback_origin(value):
    try:
        url = urlsplit(value)
        if (value != value.strip() or not url.hostname or url.username or url.password
                or url.path not in ("", "/") or url.query or url.fragment):
            return False
        _ = url.port
        local = url.hostname == "localhost"
        try:
            local = local or ipaddress.ip_address(url.hostname).is_loopback
        except ValueError:
            pass
        return url.scheme == "https" or (url.scheme == "http" and local)
    except (ValueError, TypeError, AttributeError):
        return False


def valid_tenant(value):
    if value in ("common", "organizations", "consumers"):
        return True
    try:
        return str(UUID(value)).lower() == value.lower()
    except (ValueError, TypeError, AttributeError):
        return False


def provider_status(provider):
    names = {"gmail": ("MAIL_GOOGLE_CLIENT_ID", "MAIL_GOOGLE_CLIENT_SECRET"),
             "outlook": ("MAIL_MICROSOFT_CLIENT_ID", "MAIL_MICROSOFT_CLIENT_SECRET")}
    if provider not in names:
        raise ValueError("Unknown mail provider.")
    issues = []
    for name in names[provider]:
        value = getattr(settings, name, "")
        if not isinstance(value, str) or not value.strip() or value.upper().startswith(("YOUR_", "PASTE_", "REPLACE_")):
            issues.append(name + " is missing or still contains a placeholder.")
    key = getattr(settings, "MAIL_TOKEN_ENCRYPTION_KEY", "")
    if not key:
        issues.append("MAIL_TOKEN_ENCRYPTION_KEY is missing.")
    else:
        try:
            Fernet(key.encode())
        except (ValueError, TypeError, AttributeError, UnicodeError):
            issues.append("MAIL_TOKEN_ENCRYPTION_KEY is invalid. Preserve the existing valid key for connected mailboxes.")
    origin = getattr(settings, "MAIL_CALLBACK_ORIGIN", "")
    valid_origin = valid_callback_origin(origin)
    if not valid_origin:
        issues.append("MAIL_CALLBACK_ORIGIN must be an HTTPS origin, or HTTP localhost, without a path/query.")
    frontend = getattr(settings, "FRONTEND_ORIGIN", "")
    if valid_origin and (not valid_callback_origin(frontend) or
                         (urlsplit(frontend).scheme, urlsplit(frontend).hostname) !=
                         (urlsplit(origin).scheme, urlsplit(origin).hostname)):
        issues.append("MAIL_CALLBACK_ORIGIN must use the same host and scheme as FRONTEND_ORIGIN for browser session cookies.")
    if provider == "outlook" and not valid_tenant(getattr(settings, "MAIL_MICROSOFT_TENANT", "")):
        issues.append("MAIL_MICROSOFT_TENANT must be common, organizations, consumers or a tenant UUID.")
    return {"provider": provider, "ready": not issues, "issues": issues,
            "redirect_uri": origin.rstrip("/") + "/api/mail/oauth/" + provider + "/callback/" if valid_origin else ""}
