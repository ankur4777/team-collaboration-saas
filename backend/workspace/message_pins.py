"""Shared message pins, bounded by the caller's current membership and history."""
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .chat_views import accessible_chat, visible_chat_messages, publish_chat_message
from .models import Message, TeamMember
from .permissions import require_channel_access, channel_joined_at
from .serializers import MessageSerializer, ChatMessageSerializer
from .views import broadcast_message


def channel_history(request, channel_id, *, write=False):
    channel = require_channel_access(request, channel_id, write=write)
    return Message.objects.filter(channel=channel, created_at__gte=channel_joined_at(channel, request.user.pk))


def chat_history(request, chat_id):
    return visible_chat_messages(request, accessible_chat(request, chat_id))


def list_pins(rows, serializer):
    rows = rows.filter(pinned_at__isnull=False, deleted_at__isnull=True).select_related('sender').order_by('-pinned_at', '-pk')
    # Return a bounded page; older pins remain accessible through conversation history.
    return Response({'items': serializer(rows[:100], many=True).data, 'has_more': rows.count() > 100})


def set_pin(request, rows, message_id, serializer, publish):
    desired = request.data.get('pinned')
    if type(desired) is not bool:
        raise ValidationError({'pinned': 'Provide true or false'})
    message = get_object_or_404(rows.select_for_update(), pk=message_id, deleted_at__isnull=True)
    if desired != bool(message.pinned_at):
        message.pinned_at = timezone.now() if desired else None
        message.save(update_fields=['pinned_at'])
        payload = serializer(message).data
        transaction.on_commit(lambda: publish(payload))
    else:
        payload = serializer(message).data
    return Response(payload)


class ChannelPinsView(APIView):
    def get(self, request, channel_id):
        return list_pins(channel_history(request, channel_id), MessageSerializer)


class ChatPinsView(APIView):
    def get(self, request, chat_id):
        return list_pins(chat_history(request, chat_id).prefetch_related('reactions'), ChatMessageSerializer)


class ChannelPinView(APIView):
    @transaction.atomic
    def post(self, request, channel_id, message_id):
        return set_pin(request, channel_history(request, channel_id, write=True), message_id, MessageSerializer,
                       lambda payload: broadcast_message(channel_id, payload, action='message.updated'))


class ChatPinView(APIView):
    @transaction.atomic
    def post(self, request, chat_id, message_id):
        return set_pin(request, chat_history(request, chat_id), message_id, ChatMessageSerializer,
                       lambda payload: publish_chat_message(chat_id, payload, action='message.updated'))
