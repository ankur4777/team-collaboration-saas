"""Private file upload/list/download APIs for active workspace members.

V1 file types: PNG/JPEG/WebP/PDF/TXT; limit 5 MiB; never serve via /media/.
External malware scanning is required before production-facing deployment.
"""
import ntpath
import os
from pathlib import Path

from django.db import transaction
from django.http import FileResponse
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .chat_views import accessible_chat, visible_chat_messages, publish_chat_message
from .models import ChatConversation, ChatMessage, ChatParticipant, PrivateAttachment, TeamMember
from .serializers import ChatMessageSerializer
from .message_replies import resolve_reply_target
from .mentions import create_mentions
from .notification_events import publish_notification_refresh
from django.utils import timezone
from .permissions import get_active_membership, require_channel_access, channel_joined_at

MAX_BYTES = 5 * 1024 * 1024
ALLOWED = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
}


def validate_upload(upload):
    if upload is None or not hasattr(upload, 'read'):
        raise ValidationError({'file': 'Please choose a file to upload'})
    if upload.size <= 0 or upload.size > MAX_BYTES:
        raise ValidationError({'file': 'File must be between 1 byte and 5 MB'})
    name = ntpath.basename(str(upload.name)).strip()
    name = os.path.basename(name)
    if not name or any(ord(char) < 32 for char in name):
        raise ValidationError({'file': 'Invalid file name'})
    name = name[:120]
    extension = Path(name).suffix.lower()
    if extension not in ALLOWED:
        raise ValidationError({'file': 'Allowed formats: PNG, JPEG, WebP, PDF, TXT'})
    beginning = upload.read(min(upload.size, 4096))
    upload.seek(0)
    valid = {
        '.png': beginning.startswith(b'\x89PNG\r\n\x1a\n'),
        '.jpg': beginning.startswith(b'\xff\xd8\xff'),
        '.jpeg': beginning.startswith(b'\xff\xd8\xff'),
        '.webp': beginning.startswith(b'RIFF') and beginning[8:12] == b'WEBP',
        '.pdf': beginning.startswith(b'%PDF-'),
    }
    if extension == '.txt':
        try:
            beginning.decode('utf-8')
            valid['.txt'] = b'\x00' not in beginning
        except UnicodeDecodeError:
            valid['.txt'] = False
    if not valid.get(extension, False):
        raise ValidationError({'file': 'File content does not match its extension'})
    return name, ALLOWED[extension]


def response_row(attachment):
    return {
        'id': str(attachment.pk),
        'name': attachment.original_name,
        'size': attachment.size,
        'content_type': attachment.content_type,
        'created_at': attachment.created_at.isoformat(),
        'uploaded_by': {
            'id': str(attachment.uploaded_by_id),
            'full_name': attachment.uploaded_by.full_name,
            'email': attachment.uploaded_by.email,
        },
    }


def visible_chat_attachments(request, chat):
    query = PrivateAttachment.objects.filter(
        organization_id=chat.organization_id, chat=chat, chat_message__deleted_at__isnull=True,
    ).select_related('uploaded_by')
    if chat.kind == ChatConversation.Kind.GROUP:
        participant = ChatParticipant.objects.get(conversation=chat, user=request.user)
        query = query.filter(created_at__gte=participant.joined_at)
    return query


def visible_channel_attachments(request, channel):
    joined = channel_joined_at(channel, request.user.pk)
    return PrivateAttachment.objects.filter(
        organization_id=channel.team.organization_id, channel=channel,
        created_at__gte=joined,
    ).select_related('uploaded_by')


class ChatAttachmentsView(APIView):
    def get(self, request, chat_id):
        chat = accessible_chat(request, chat_id)
        rows = list(visible_chat_attachments(request, chat).order_by('-created_at')[:50])
        return Response([response_row(row) for row in rows])

    def post(self, request, chat_id):
        chat = accessible_chat(request, chat_id)
        upload = request.FILES.get('file')
        name, kind = validate_upload(upload)
        caption = str(request.data.get('caption', '')).strip()
        if len(caption) > 4000:
            raise ValidationError({'caption': 'Caption must contain at most 4000 characters'})
        attachment = None
        try:
            with transaction.atomic():
                reply_id = resolve_reply_target(request, visible_chat_messages(request, chat))
                message = ChatMessage.objects.create(conversation=chat, sender=request.user,
                                                     body=caption or name, reply_to_id=reply_id)
                attachment = PrivateAttachment.objects.create(
                    organization_id=chat.organization_id, chat=chat, chat_message=message,
                    uploaded_by=request.user, file=upload, original_name=name,
                    content_type=kind, size=upload.size,
                )
                ChatConversation.objects.filter(pk=chat.pk).update(updated_at=timezone.now())
                payload = ChatMessageSerializer(message).data
                transaction.on_commit(lambda: publish_chat_message(chat.pk, payload), robust=True)
                participants = list(ChatParticipant.objects.filter(conversation=chat, user__is_active=True,
                    user__organization_memberships__organization_id=chat.organization_id).select_related('user').distinct())
                create_mentions(organization_id=chat.organization_id, sender_id=request.user.pk, body=caption,
                                eligible_users=[p.user for p in participants], chat_message=message)
                recipients = [p.user_id for p in participants]
                transaction.on_commit(lambda: publish_notification_refresh(chat.organization_id, recipients), robust=True)
        except Exception:
            if attachment and attachment.file:
                attachment.file.storage.delete(attachment.file.name)
            raise
        return Response({**response_row(attachment), 'message': payload}, status=status.HTTP_201_CREATED)


class ChannelAttachmentsView(APIView):
    def get(self, request, channel_id):
        channel = require_channel_access(request, channel_id)
        rows = list(visible_channel_attachments(request, channel).order_by('-created_at')[:50])
        return Response([response_row(row) for row in rows])

    def post(self, request, channel_id):
        channel = require_channel_access(request, channel_id, write=True)
        upload = request.FILES.get('file')
        name, kind = validate_upload(upload)
        with transaction.atomic():
            attachment = PrivateAttachment.objects.create(
                organization_id=channel.team.organization_id, channel=channel,
                uploaded_by=request.user, file=upload, original_name=name,
                content_type=kind, size=upload.size,
            )
        return Response(response_row(attachment), status=status.HTTP_201_CREATED)


class AttachmentDownloadView(APIView):
    def get(self, request, attachment_id):
        membership = get_active_membership(request)
        attachment = get_object_or_404(
            PrivateAttachment.objects.select_related('chat', 'channel__team'),
            pk=attachment_id, organization_id=membership.organization_id,
        )
        if attachment.chat_id:
            chat = accessible_chat(request, attachment.chat_id)
            if not visible_chat_attachments(request, chat).filter(pk=attachment.pk).exists():
                raise PermissionDenied('You cannot access this attachment')
        else:
            channel = require_channel_access(request, attachment.channel_id)
            if not visible_channel_attachments(request, channel).filter(pk=attachment.pk).exists():
                raise PermissionDenied('You cannot access this attachment')
        try:
            stream = attachment.file.open('rb')
        except (FileNotFoundError, OSError):
            from rest_framework.exceptions import NotFound
            raise NotFound('File is no longer stored')
        preview = request.query_params.get('preview') == '1' and attachment.content_type in ('image/png', 'image/jpeg', 'image/webp')
        response = FileResponse(stream, as_attachment=not preview, filename=attachment.original_name,
                                content_type=attachment.content_type if preview else 'application/octet-stream')
        response['Cache-Control'] = 'private, no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        response['Content-Security-Policy'] = "default-src 'none'; sandbox"
        return response

