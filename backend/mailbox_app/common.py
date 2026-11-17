import base64
import json
from html.parser import HTMLParser
from rest_framework.exceptions import APIException, ValidationError

FOLDERS = ["inbox", "sent", "drafts", "archive", "junk", "trash", "starred"]


class MailError(APIException):
    status_code = 502
    default_detail = "The mail provider could not complete this request. Try refreshing the mailbox."


class ReconnectRequired(APIException):
    status_code = 409
    default_detail = "Reconnect this mailbox to continue."


class HtmlText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.suppressed = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.suppressed += 1
        if tag in ("p", "div", "br", "li", "tr"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self.suppressed = max(0, self.suppressed - 1)

    def handle_data(self, data):
        if not self.suppressed:
            self.parts.append(data)


def plain_html(value):
    parser = HtmlText()
    parser.feed(value or "")
    return "".join(parser.parts).strip()


def b64encode(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def b64decode(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def opaque_id(value, kind="message"):
    return b64encode(json.dumps({"id": str(value), "kind": kind}, separators=(",", ":")).encode())


def decode_id(value):
    try:
        if len(value) > 1500:
            raise ValueError()
        data = json.loads(b64decode(value))
        if data["kind"] not in ("message", "draft") or not isinstance(data["id"], str) or not data["id"] or len(data["id"]) > 1000:
            raise ValueError()
        return data["id"], data["kind"]
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise ValidationError("Invalid message identifier.")
