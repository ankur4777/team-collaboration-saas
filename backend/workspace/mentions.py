"""Persistent, authorization-filtered @Full Name mention notifications.

Only current channel/team participants or chat participants are eligible.
Mention names must be unique among eligible users to avoid misrouting alerts.
No message text is sent in the WebSocket notification refresh event.
"""
import re
from collections import Counter

from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    ChatParticipant, MentionNotification, OrganizationMember, TeamMember,
)
from .permissions import get_active_membership


def mentioned_user_ids(body, eligible_users, sender_id):
    """Recognize literal @Full Name mentions; never resolve outside eligible users."""
    users = list(eligible_users)
    counts = Counter(user.full_name.strip().casefold() for user in users)
    candidates = [
        user for user in users
        if user.pk != sender_id and user.full_name.strip()
        and counts[user.full_name.strip().casefold()] == 1
    ]
    # Longest first prevents @Alex from also matching @Alex Smith.
    candidates.sort(key=lambda user: len(user.full_name), reverse=True)
    matches = []
    recipients = set()
    for user in candidates:
        name = user.full_name.strip()
        pattern = r'(?<![\w@])@' + re.escape(name) + r'(?!\w)'
        for match in re.finditer(pattern, body, re.IGNORECASE):
            if any(start < match.end() and match.start() < end for start, end in matches):
                continue
            recipients.add(user.pk)
            matches.append((match.start(), match.end()))
    return recipients


def create_mentions(*, organization_id, sender_id, body, eligible_users,
                    chat_message=None, channel_message=None):
    recipients = mentioned_user_ids(body, eligible_users, sender_id)
    if not recipients:
        return
    MentionNotification.objects.bulk_create([
        MentionNotification(
            organization_id=organization_id,
            recipient_id=user_id,
            chat_message=chat_message,
            channel_message=channel_message,
        )
        for user_id in recipients
    ])


def current_access(request):
    membership = get_active_membership(request)
    org_id = membership.organization_id
    chat_joins = dict(ChatParticipant.objects.filter(
        conversation__organization_id=org_id, user=request.user,
    ).values_list('conversation_id', 'joined_at'))
    team_joins = dict(TeamMember.objects.filter(
        team__organization_id=org_id, user=request.user,
    ).values_list('team_id', 'joined_at'))
    return membership, chat_joins, team_joins


def visible(notification, membership, chat_joins, team_joins):
    if (notification.organization_id != membership.organization_id
            or notification.recipient_id != membership.user_id
            or notification.created_at < membership.joined_at):
        return False
    if notification.chat_message_id:
        message = notification.chat_message
        if message.deleted_at or message.conversation.organization_id != membership.organization_id:
            return False
        joined = chat_joins.get(message.conversation_id)
        return joined is not None and message.created_at >= joined
    if notification.channel_message_id:
        message = notification.channel_message
        if message.channel.team.organization_id != membership.organization_id:
            return False
        joined = team_joins.get(message.channel.team_id)
        return joined is not None and message.created_at >= joined
    return False


def notification_payload(notification):
    if notification.chat_message_id:
        message = notification.chat_message
        conversation = message.conversation
        source_name = conversation.title or 'Direct conversation'
        return {
            'id': str(notification.pk),
            'kind': 'chat',
            'chat_kind': conversation.kind,
            'source_id': str(conversation.pk),
            'team_id': None,
            'source_name': source_name,
            'sender_name': message.sender.full_name,
            'created_at': notification.created_at.isoformat(),
            'read_at': notification.read_at.isoformat() if notification.read_at else None,
        }
    message = notification.channel_message
    return {
        'id': str(notification.pk),
        'kind': 'channel',
        'chat_kind': None,
        'source_id': str(message.channel_id),
        'team_id': str(message.channel.team_id),
        'source_name': message.channel.name,
        'sender_name': message.sender.full_name,
        'created_at': notification.created_at.isoformat(),
        'read_at': notification.read_at.isoformat() if notification.read_at else None,
    }


class MentionsView(APIView):
    def get(self, request):
        membership, chat_joins, team_joins = current_access(request)
        records = MentionNotification.objects.filter(
            organization_id=membership.organization_id, recipient=request.user,
        ).select_related(
            'chat_message__sender', 'chat_message__conversation',
            'channel_message__sender', 'channel_message__channel__team',
        ).order_by('-created_at')[:200]
        rows = [
            notification_payload(row) for row in records
            if visible(row, membership, chat_joins, team_joins)
        ][:50]
        return Response({'results': rows})


class MentionReadView(APIView):
    def post(self, request, mention_id):
        membership, chat_joins, team_joins = current_access(request)
        row = get_object_or_404(
            MentionNotification.objects.select_related(
                'chat_message__conversation',
                'channel_message__channel__team',
            ),
            pk=mention_id, organization_id=membership.organization_id, recipient=request.user,
        )
        if not visible(row, membership, chat_joins, team_joins):
            from rest_framework.exceptions import NotFound
            raise NotFound('Mention not found')
        if row.read_at is None:
            row.read_at = timezone.now()
            row.save(update_fields=['read_at'])
        return Response({'read_at': row.read_at.isoformat()})
