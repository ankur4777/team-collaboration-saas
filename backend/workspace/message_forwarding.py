"""Explicit text forwarding within a single active workspace."""
from uuid import UUID
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView
from .models import Channel, ChatConversation, ChatMessage, ChatParticipant, Message, TeamMember
from .permissions import get_active_membership
from .chat_views import publish_chat_message
from .views import broadcast_message
from .notification_events import publish_notification_refresh
from .serializers import ChatMessageSerializer, MessageSerializer


def chat_rows(org, user):
    return ChatConversation.objects.filter(organization_id=org, participants__user=user)


def channel_rows(org, user):
    return Channel.objects.filter(team__organization_id=org, team__members__user=user)


def parse_location(data, prefix):
    kind = data.get(prefix + '_kind')
    if kind not in ('chat', 'channel'):
        raise ValidationError({prefix: 'Choose a chat or channel'})
    try:
        return kind, UUID(str(data.get(prefix + '_id')))
    except (ValueError, TypeError):
        raise ValidationError({prefix: 'Invalid conversation identifier'})


class ForwardDestinationsView(APIView):
    def get(self, request):
        org = get_active_membership(request).organization_id
        user = request.user
        chats = chat_rows(org, user).prefetch_related('participants__user').order_by('-updated_at')[:200]
        channels = channel_rows(org, user).select_related('team').order_by('team__name', 'name')[:200]
        results = []
        for chat in chats:
            name = chat.title if chat.kind == ChatConversation.Kind.GROUP else next(
                (p.user.full_name for p in chat.participants.all() if p.user_id != user.pk), 'Direct conversation')
            results.append({'kind': 'chat', 'id': str(chat.pk), 'label': name})
        results.extend({'kind': 'channel', 'id': str(ch.pk), 'label': f'{ch.team.name} / #{ch.name}'} for ch in channels)
        return Response(results)


class ForwardMessageView(APIView):
    @transaction.atomic
    def post(self, request):
        org = get_active_membership(request).organization_id
        user = request.user
        source_kind, source_id = parse_location(request.data, 'source')
        dest_kind, dest_id = parse_location(request.data, 'destination')
        try:
            message_id = UUID(str(request.data.get('message_id')))
        except (ValueError, TypeError):
            raise ValidationError({'message_id': 'Invalid message identifier'})
        if source_kind == 'chat':
            source = get_object_or_404(chat_rows(org, user), pk=source_id)
            joined = get_object_or_404(ChatParticipant, conversation=source, user=user).joined_at
            original = get_object_or_404(ChatMessage.objects.select_for_update(), pk=message_id,
                                         conversation=source, deleted_at__isnull=True, created_at__gte=joined)
        else:
            source = get_object_or_404(channel_rows(org, user), pk=source_id)
            joined = get_object_or_404(TeamMember, team_id=source.team_id, user=user).joined_at
            original = get_object_or_404(Message.objects.select_for_update(), pk=message_id,
                                         channel=source, deleted_at__isnull=True, created_at__gte=joined)
        if not original.body.strip():
            raise ValidationError({'message_id': 'Only nonempty text messages can be forwarded'})
        # A new, explicit copy; never expose source IDs, author, or reply metadata.
        if dest_kind == 'chat':
            dest = get_object_or_404(chat_rows(org, user), pk=dest_id)
            message = ChatMessage.objects.create(conversation=dest, sender=user, body=original.body, is_forwarded=True)
            ChatConversation.objects.filter(pk=dest.pk).update(updated_at=timezone.now())
            payload = ChatMessageSerializer(message).data
            recipients = list(ChatParticipant.objects.filter(
                conversation=dest, user__is_active=True,
                user__organization_memberships__organization_id=org,
            ).values_list('user_id', flat=True).distinct())
            transaction.on_commit(lambda: publish_chat_message(dest.pk, payload))
        else:
            dest = get_object_or_404(channel_rows(org, user), pk=dest_id)
            message = Message.objects.create(channel=dest, sender=user, body=original.body, is_forwarded=True)
            payload = MessageSerializer(message).data
            recipients = list(TeamMember.objects.filter(
                team_id=dest.team_id, user__is_active=True,
                user__organization_memberships__organization_id=org,
            ).values_list('user_id', flat=True).distinct())
            transaction.on_commit(lambda: broadcast_message(dest.pk, payload))
        # Mentions in forwarded text are not re-triggered.
        transaction.on_commit(lambda: publish_notification_refresh(org, recipients))
        return Response({'kind': dest_kind, 'destination_id': str(dest.pk), 'message': payload}, status=201)
