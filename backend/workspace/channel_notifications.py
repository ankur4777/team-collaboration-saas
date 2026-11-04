"""Organization-scoped team channel notifications and explicit read receipts.

Read cursors are not permissions: every endpoint independently verifies
current organization membership and team membership.
"""
from uuid import UUID

from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Channel, ChannelReadCursor, Message, TeamMember
from .permissions import get_active_membership, require_channel_access


class ChannelNotificationsView(APIView):
    def get(self, request):
        membership = get_active_membership(request)
        joined_teams = {
            row.team_id: row.joined_at
            for row in TeamMember.objects.filter(
                team__organization_id=membership.organization_id,
                user=request.user,
            ).only('team_id', 'joined_at')
        }
        channels = list(
            Channel.objects.filter(team_id__in=joined_teams)
            .select_related('team').order_by('team__name', 'name')[:500]
        )
        read_times = {
            state.channel_id: state.last_read_at
            for state in ChannelReadCursor.objects.filter(
                channel_id__in=[channel.pk for channel in channels],
                user=request.user,
            )
        }
        result = []
        for channel in channels:
            last_read = read_times.get(channel.pk)
            baseline = joined_teams[channel.team_id]
            if last_read and last_read > baseline:
                baseline = last_read
            count = (Message.objects.filter(channel=channel, created_at__gt=baseline)
                     .exclude(sender_id=request.user.pk).count())
            result.append({
                'channel_id': str(channel.id),
                'channel_name': channel.name,
                'team_id': str(channel.team_id),
                'team_name': channel.team.name,
                'unread_count': count,
                'last_read_at': last_read.isoformat() if last_read else None,
            })
        return Response(result)


class ChannelReadView(APIView):
    def post(self, request, channel_id):
        channel = require_channel_access(request, channel_id)
        raw_id = request.data.get('message_id')
        try:
            message_id = UUID(str(raw_id))
        except (TypeError, ValueError, AttributeError):
            raise ValidationError({'message_id': 'Provide a valid message ID'})
        message = get_object_or_404(Message, pk=message_id, channel=channel)
        team_member = TeamMember.objects.get(team=channel.team, user=request.user)
        if message.created_at < team_member.joined_at:
            raise ValidationError({'message_id': 'Message predates your team membership'})

        with transaction.atomic():
            cursor, _ = ChannelReadCursor.objects.get_or_create(
                channel=channel, user=request.user,
            )
            cursor = ChannelReadCursor.objects.select_for_update().get(pk=cursor.pk)
            if cursor.last_read_at is None or message.created_at > cursor.last_read_at:
                cursor.last_read_at = message.created_at
                cursor.save(update_fields=['last_read_at'])
        return Response({'last_read_at': cursor.last_read_at.isoformat()})
