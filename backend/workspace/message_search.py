"""Tenant-safe keyword search across accessible direct chats, groups and channels.

Search is intentionally bounded to the most recent 50 matches. It uses the
existing MySQL database and no new search infrastructure. Membership filters
are applied in SQL before any text is returned.
"""
from django.db.models import F
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ChatMessage, Message
from .permissions import get_active_membership

MAX_RESULTS = 50
MAX_QUERY_LENGTH = 100


class MessageSearchView(APIView):
    def get(self, request):
        member = get_active_membership(request)
        raw = request.query_params.get('q', '')
        scope = request.query_params.get('scope', 'all')
        if not isinstance(raw, str):
            raise ValidationError({'q': 'Provide a search phrase'})
        query = raw.strip()
        if not 2 <= len(query) <= MAX_QUERY_LENGTH:
            raise ValidationError({'q': 'Search text must be 2–100 characters'})
        if scope not in ('all', 'chats', 'channels'):
            raise ValidationError({'scope': 'Choose all, chats or channels'})

        results = []
        if scope in ('all', 'chats'):
            # Filtering the participant join and created_at in the same query
            # enforces the calling user's join time, including group history.
            chats = (
                ChatMessage.objects.filter(
                    conversation__organization_id=member.organization_id,
                    conversation__participants__user=request.user,
                    created_at__gte=F('conversation__participants__joined_at'),
                    deleted_at__isnull=True,
                    body__icontains=query,
                )
                .select_related('sender', 'conversation')
                .order_by('-created_at', '-id')[:MAX_RESULTS]
            )
            for message in chats:
                results.append({
                    'id': str(message.pk),
                    'source': 'chat',
                    'source_id': str(message.conversation_id),
                    'source_name': message.conversation.title or 'Direct conversation',
                    'chat_kind': message.conversation.kind,
                    'team_id': None,
                    'sender_name': message.sender.full_name,
                    'created_at': message.created_at.isoformat(),
                    'excerpt': message.body[:300],
                })

        if scope in ('all', 'channels'):
            # Unlike a channel's normal message-history API, search never
            # returns messages predating the employee's latest team admission.
            channels = (
                Message.objects.filter(
                    channel__team__organization_id=member.organization_id,
                    channel__team__members__user=request.user,
                    created_at__gte=F('channel__team__members__joined_at'),
                    body__icontains=query,
                )
                .select_related('sender', 'channel__team')
                .order_by('-created_at', '-id')[:MAX_RESULTS]
            )
            for message in channels:
                results.append({
                    'id': str(message.pk),
                    'source': 'channel',
                    'source_id': str(message.channel_id),
                    'source_name': message.channel.name,
                    'chat_kind': None,
                    'team_id': str(message.channel.team_id),
                    'team_name': message.channel.team.name,
                    'sender_name': message.sender.full_name,
                    'created_at': message.created_at.isoformat(),
                    'excerpt': message.body[:300],
                })

        results.sort(key=lambda result: (result['created_at'], result['id']), reverse=True)
        return Response({'results': results[:MAX_RESULTS], 'limit': MAX_RESULTS})
