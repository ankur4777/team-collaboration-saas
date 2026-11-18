"""Configure real mail locally. Run through setup-mail.ps1 or with Python 3.10+."""
import argparse
import base64
import getpass
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile
from urllib.parse import urlsplit
from uuid import UUID
import warnings

from dotenv.parser import parse_stream


class SetupError(Exception):
    pass


PROVIDERS = {
    "gmail": ("MAIL_GOOGLE_CLIENT_ID", "MAIL_GOOGLE_CLIENT_SECRET"),
    "outlook": ("MAIL_MICROSOFT_CLIENT_ID", "MAIL_MICROSOFT_CLIENT_SECRET"),
}


def valid_origin(value):
    try:
        url = urlsplit(value)
        if (value != value.strip() or not url.hostname or url.username or url.password
                or url.query or url.fragment or url.path not in ("", "/")):
            return False
        _ = url.port
        local = url.hostname == "localhost"
        try:
            local = local or ipaddress.ip_address(url.hostname).is_loopback
        except ValueError:
            pass
        return url.scheme == "https" or (url.scheme == "http" and local)
    except ValueError:
        return False


def validate_key(value):
    try:
        if len(value) != 44 or len(base64.b64decode(value, altchars=b"-_", validate=True)) != 32:
            raise ValueError()
    except (ValueError, TypeError):
        raise SetupError("Existing MAIL_TOKEN_ENCRYPTION_KEY is invalid. It was not replaced; check it before continuing.") from None


def literal(value, label):
    if not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise SetupError(label + " is required and must be a single-line value.")
    # Compose and python-dotenv both support escaped quotes/backslashes in single quotes.
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def load_env(path):
    if path.is_symlink() or not path.is_file():
        raise SetupError("An existing regular .env file is required in the project root.")
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeError:
        raise SetupError("Save .env as UTF-8 before running mail setup.") from None
    bindings = list(parse_stream(io.StringIO(text)))
    if any(binding.error for binding in bindings):
        raise SetupError("The .env file contains invalid syntax. No settings were changed.")
    values = {b.key: b.value or "" for b in bindings if b.key is not None}
    return raw, bindings, values


def save_env(path, raw, bindings, updates):
    # Keep unrelated lines (including multiline values/comments) byte-for-byte.
    newline = "\r\n" if b"\r\n" in raw else "\n"
    text = "".join(b.original.string for b in bindings if b.key not in updates)
    if text and not text.endswith(("\r", "\n")):
        text += newline
    text += "".join(key + "=" + literal(value, key) + newline for key, value in updates.items() if value is not None)
    if raw.startswith(b"\xef\xbb\xbf"):
        text = "\ufeff" + text
    original_stat = path.stat()
    fd, name = tempfile.mkstemp(prefix=".env.mail-", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            if hasattr(os, "fchown") and hasattr(os, "geteuid") and os.geteuid() == 0:
                os.fchown(stream.fileno(), original_stat.st_uid, original_stat.st_gid)
            os.chmod(temp, stat.S_IMODE(original_stat.st_mode) & 0o600 or 0o600)
            stream.write(text.encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        if path.is_symlink() or path.read_bytes() != raw:
            raise SetupError("The .env file changed during setup. Run setup again; your changes were preserved.")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def configure(root, provider, read=input, read_secret=getpass.getpass, client_json=None):
    path = Path(root) / ".env"
    raw, bindings, existing = load_env(path)
    current_key = existing.get("MAIL_TOKEN_ENCRYPTION_KEY", "")
    if current_key:
        validate_key(current_key)
    default_origin = existing.get("MAIL_CALLBACK_ORIGIN") or existing.get("FRONTEND_ORIGIN") or "http://localhost:5173"
    if not valid_origin(default_origin):
        raise SetupError("The existing callback/browser origin is invalid. Correct it in .env before running setup.")
    origin = (read("TeamWorkspace browser address [" + default_origin + "]: ").strip() or default_origin).rstrip("/")
    if not valid_origin(origin):
        raise SetupError("Use an HTTPS origin, or HTTP localhost for local testing, without a path/query.")
    frontend = existing.get("FRONTEND_ORIGIN", "").rstrip("/")
    if frontend and (not valid_origin(frontend) or
                     (urlsplit(frontend).scheme, urlsplit(frontend).hostname) !=
                     (urlsplit(origin).scheme, urlsplit(origin).hostname)):
        raise SetupError("The callback must use the same host and scheme as FRONTEND_ORIGIN for browser session cookies.")
    redirect = origin + "/api/mail/oauth/" + provider + "/callback/"
    print("Register this exact Web redirect URI with the provider: " + redirect)
    id_key, secret_key = PROVIDERS[provider]
    imported = {}
    if client_json:
        if provider != "gmail":
            raise SetupError("Credential JSON import is supported for Google's Web application client only.")
        try:
            imported = json.loads(Path(client_json).read_text(encoding="utf-8-sig"))["web"]
            if not isinstance(imported, dict):
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError):
            raise SetupError("Select the Google OAuth Web application client JSON downloaded from Google Cloud.") from None
        if not isinstance(imported.get("redirect_uris"), list) or redirect not in imported["redirect_uris"]:
            raise SetupError("The imported client does not list the redirect URI shown above. Update the client and download it again.")
        if any(not isinstance(imported.get(name), str) or not imported[name] for name in ("client_id", "client_secret")):
            raise SetupError("The Google Web-client JSON must contain its client ID and client secret.")
    client_id = imported.get("client_id") if imported else read("Provider client ID (Enter keeps existing): ").strip() or existing.get(id_key, "")
    client_secret = imported.get("client_secret") if imported else read_secret("Provider client secret (hidden; Enter keeps existing): ")
    write_secret = bool(client_secret)
    if not client_secret:
        encoded = existing.get(secret_key + "_BASE64", "")
        if encoded:
            try:
                client_secret = base64.b64decode(encoded, validate=True).decode("utf-8")
            except (ValueError, UnicodeError):
                raise SetupError("The saved provider secret is invalid. Enter its original value to replace it.") from None
        else:
            client_secret = existing.get(secret_key, "")
    if not isinstance(client_id, str) or not isinstance(client_secret, str):
        raise SetupError("The provider credentials are not valid strings.")
    literal(client_id, id_key)
    literal(client_secret, secret_key)
    if client_secret.upper().startswith(("YOUR_", "PASTE_", "REPLACE_")):
        raise SetupError("Enter the provider's client secret value, rather than a placeholder.")
    if provider == "gmail" and not re.fullmatch(r"[A-Za-z0-9._-]+\.apps\.googleusercontent\.com", client_id):
        raise SetupError("Use the Google Web application client ID ending in .apps.googleusercontent.com.")
    tenant = existing.get("MAIL_MICROSOFT_TENANT", "common") or "common"
    if provider == "outlook":
        try:
            UUID(client_id)
        except ValueError:
            raise SetupError("Use Microsoft's Application (client) ID, rather than the object ID or secret ID.") from None
        tenant = read("Microsoft tenant [" + tenant + "]: ").strip() or tenant
        if tenant not in ("common", "organizations", "consumers"):
            try:
                UUID(tenant)
            except ValueError:
                raise SetupError("Microsoft tenant must be common, organizations, consumers or a tenant UUID.") from None
    # Use a parser-safe encoded form: Compose and python-dotenv have different
    # escaping rules for literal backslashes. This is encoding, not encryption.
    updates = {id_key: client_id,
               "MAIL_TOKEN_ENCRYPTION_KEY": current_key or base64.urlsafe_b64encode(secrets.token_bytes(32)).decode(),
               "MAIL_CALLBACK_ORIGIN": origin}
    if write_secret:
        updates[secret_key] = None
        updates[secret_key + "_BASE64"] = base64.b64encode(client_secret.encode("utf-8")).decode()
    if provider == "outlook":
        updates["MAIL_MICROSOFT_TENANT"] = tenant
    save_env(path, raw, bindings, updates)
    print("Mail settings saved locally. Existing application/database settings were preserved.")
    print("Google/Microsoft still needs the matching OAuth app, permissions and user consent.")
    return redirect


def main(argv=None):
    parser = argparse.ArgumentParser(description="Configure local Gmail/Outlook provider settings without displaying secrets.")
    parser.add_argument("--provider", choices=PROVIDERS, required=True)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--google-client-json", type=Path)
    args = parser.parse_args(argv)
    if not sys.stdin.isatty():
        print("Run mail setup in an interactive terminal. Credentials must not be passed on the command line.", file=sys.stderr)
        return 1
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            configure(args.root, args.provider, client_json=args.google_client_json)
    except (EOFError, KeyboardInterrupt):
        print("\nMail setup cancelled before saving.", file=sys.stderr)
        return 1
    except (SetupError, getpass.GetPassWarning) as exc:
        print("Mail setup stopped: " + str(exc), file=sys.stderr)
        return 1
    except OSError:
        print("Unable to read/write the local setup files. Check file permissions and retry.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
