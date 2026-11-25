"""Tenant-safe keyword search across accessible direct chats, groups and channels.

Each page is bounded to 50 matches, with signed continuation cursors. It uses the
existing MySQL database and no new search infrastructure. Membership filters
are applied in SQL before any text is returned.
"""
from datetime import date, datetime, time, timedelta, timezone
from uuid import UUID
from django.core import signing
from django.db.models import F, Q, OuterRef, Exists
from django.utils.dateparse import parse_datetime
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ChatMessage, Message, PrivateChannelMember
from .permissions import get_active_membership
from .license_access import enabled_modules, workspace_license

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

        sender = request.query_params.get('sender', '').strip()
        start = request.query_params.get('start', '')
        end = request.query_params.get('end', '')
        cursor = request.query_params.get('cursor', '')
        paged = request.query_params.get('page')
        if paged not in (None, '1') or (cursor and paged != '1'):
            raise ValidationError({'page': 'Use page=1 for paginated search'})
        if len(sender) > 100 or len(cursor) > 4096:
            raise ValidationError({'detail': 'Invalid sender or search cursor'})
        try:
            start_date = date.fromisoformat(start) if start else None
            end_date = date.fromisoformat(end) if end else None
            lower = datetime.combine(start_date, time.min, tzinfo=timezone.utc) if start_date else None
            upper = datetime.combine(end_date + timedelta(days=1), time.min, tzinfo=timezone.utc) if end_date else None
        except (ValueError, OverflowError):
            raise ValidationError({'date': 'Use valid YYYY-MM-DD dates'})
        if lower and upper and lower >= upper:
            raise ValidationError({'date': 'Start date must not be after end date'})
        filters = [str(member.organization_id), str(request.user.pk), query, scope, sender, start, end]
        anchor = None
        if cursor:
            try:
                data = signing.loads(cursor, salt='workspace-message-search', max_age=3600)
                if data['filters'] != filters or data['source'] not in ('chat', 'channel'):
                    raise ValueError()
                timestamp = parse_datetime(data['created_at'])
                if timestamp is None or timestamp.tzinfo is None:
                    raise ValueError()
                anchor = (timestamp, UUID(data['id']), data['source'])
            except (signing.BadSignature, ValueError, KeyError, TypeError):
                raise ValidationError({'cursor': 'Search page expired or filters changed. Search again.'})

        def constrain(rows, source):
            if sender:
                rows = rows.filter(Q(sender__full_name__icontains=sender) | Q(sender__email__icontains=sender))
            if lower:
                rows = rows.filter(created_at__gte=lower)
            if upper:
                rows = rows.filter(created_at__lt=upper)
            if anchor:
                timestamp, identity, previous_source = anchor
                condition = Q(created_at__lt=timestamp) | Q(created_at=timestamp, id__lt=identity)
                if source < previous_source:
                    condition |= Q(created_at=timestamp, id=identity)
                rows = rows.filter(condition)
            return rows.order_by('-created_at', '-id')[:MAX_RESULTS + (1 if paged else 0)]

        modules = enabled_modules(workspace_license(member.organization_id))
        results = []
        if scope in ('all', 'chats') and 'chats' in modules:
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
            )
            for message in constrain(chats, 'chat'):
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

        if scope in ('all', 'channels') and 'teams' in modules:
            # Unlike a channel's normal message-history API, search never
            # returns messages predating the employee's latest team admission.
            channels = (
                Message.objects.filter(
                    channel__team__organization_id=member.organization_id,
                    channel__team__members__user=request.user,
                    created_at__gte=F('channel__team__members__joined_at'),
                    body__icontains=query,
                    deleted_at__isnull=True,
                )
                .filter(Q(channel__is_private=False) | Exists(PrivateChannelMember.objects.filter(
                    channel_id=OuterRef('channel_id'), team_member__user=request.user,
                    joined_at__lte=OuterRef('created_at'),
                )))
                .select_related('sender', 'channel__team')
            )
            for message in constrain(channels, 'channel'):
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

        results.sort(key=lambda result: (parse_datetime(result['created_at']), result['id'], result['source']), reverse=True)
        response = {'results': results[:MAX_RESULTS], 'limit': MAX_RESULTS}
        if paged:
            has_more = len(results) > MAX_RESULTS
            last = response['results'][-1] if has_more else None
            response['has_more'] = has_more
            response['next_cursor'] = signing.dumps({
                'filters': filters, 'id': last['id'], 'source': last['source'], 'created_at': last['created_at'],
            }, salt='workspace-message-search') if last else None
        return Response(response)
