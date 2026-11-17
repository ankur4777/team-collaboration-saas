import base64
import binascii
from rest_framework import serializers


class FileSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    content_type = serializers.CharField(max_length=120, default="application/octet-stream")
    data = serializers.CharField(max_length=7_000_000, trim_whitespace=False)

    def validate(self, data):
        name = data["name"].replace("\\", "/").split("/")[-1]
        if not name or any(ord(c) < 32 for c in name):
            raise serializers.ValidationError("Invalid attachment name.")
        try:
            raw = base64.b64decode(data["data"], validate=True)
        except (ValueError, binascii.Error):
            raise serializers.ValidationError("Invalid attachment encoding.")
        if len(raw) > 5 * 1024 * 1024:
            raise serializers.ValidationError("Each attachment must be 5 MB or smaller.")
        data["name"] = name
        data["size"] = len(raw)
        return data


class ComposeSerializer(serializers.Serializer):
    to = serializers.ListField(child=serializers.EmailField(max_length=254), max_length=50, default=list)
    cc = serializers.ListField(child=serializers.EmailField(max_length=254), max_length=50, default=list)
    bcc = serializers.ListField(child=serializers.EmailField(max_length=254), max_length=50, default=list)
    subject = serializers.CharField(max_length=255, allow_blank=True, default="")
    body = serializers.CharField(max_length=200_000, allow_blank=True, default="", trim_whitespace=False)
    attachments = FileSerializer(many=True, max_length=20, default=list)
    draft_id = serializers.CharField(max_length=1500, allow_blank=True, default="")
    reply_id = serializers.CharField(max_length=1500, allow_blank=True, default="")
    mode = serializers.ChoiceField(choices=["new", "reply", "reply_all", "forward"], default="new")

    def validate(self, data):
        if "\r" in data["subject"] or "\n" in data["subject"]:
            raise serializers.ValidationError("Subject must be a single line.")
        if len(data["to"] + data["cc"] + data["bcc"]) > 100:
            raise serializers.ValidationError("At most 100 recipients per message.")
        if sum(f["size"] for f in data["attachments"]) > 10 * 1024 * 1024:
            raise serializers.ValidationError("Combined attachments must be 10 MB or smaller.")
        return data


class ActionSerializer(serializers.Serializer):
    action = serializers.ChoiceField(choices=["read", "unread", "star", "unstar", "archive", "trash", "restore", "inbox", "junk"])
