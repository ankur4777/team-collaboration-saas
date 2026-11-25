from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView
from .models import ChatParticipant, ChannelReadCursor
from .chat_views import accessible_chat
from .message_pins import chat_history, channel_history
from .permissions import require_channel_access
from .serializers import ChatMessageSerializer, MessageSerializer


def preferences(request, row):
    fields = {}
    for key in ('is_muted', 'is_pinned'):
        if key in request.data:
            if type(request.data[key]) is not bool:
                raise ValidationError({key: 'Provide true or false'})
            fields[key] = request.data[key]
    if not fields:
        raise ValidationError({'detail': 'Provide a conversation preference'})
    for key, value in fields.items():
        setattr(row, key, value)
    row.save(update_fields=list(fields))
    return Response({key: getattr(row, key) for key in ('is_muted', 'is_pinned')})


class ChatPreferencesView(APIView):
    @transaction.atomic
    def post(self, request, chat_id):
        chat = accessible_chat(request, chat_id)
        row = get_object_or_404(ChatParticipant.objects.select_for_update(), conversation=chat, user=request.user)
        return preferences(request, row)


class ChannelPreferencesView(APIView):
    @transaction.atomic
    def post(self, request, channel_id):
        channel = require_channel_access(request, channel_id)
        row, _ = ChannelReadCursor.objects.get_or_create(channel=channel, user=request.user)
        row = ChannelReadCursor.objects.select_for_update().get(pk=row.pk)
        return preferences(request, row)


def context(rows, message_id, serializer):
    rows = rows.select_related('sender')
    target = get_object_or_404(rows, pk=message_id, deleted_at__isnull=True)
    before = Q(created_at__lt=target.created_at) | Q(created_at=target.created_at, pk__lt=target.pk)
    after = Q(created_at__gt=target.created_at) | Q(created_at=target.created_at, pk__gt=target.pk)
    older = list(rows.filter(before).order_by('-created_at', '-pk')[:10])
    newer = list(rows.filter(after).order_by('created_at', 'pk')[:10])
    return Response({'items': serializer(list(reversed(older))+[target]+newer, many=True).data})


class ChatContextView(APIView):
    def get(self, request, chat_id, message_id):
        return context(chat_history(request, chat_id).prefetch_related('reactions'), message_id, ChatMessageSerializer)


class ChannelContextView(APIView):
    def get(self, request, channel_id, message_id):
        return context(channel_history(request, channel_id), message_id, MessageSerializer)
