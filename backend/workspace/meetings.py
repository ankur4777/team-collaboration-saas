"""Workspace-private meeting scheduling; external call links are never fetched."""
from datetime import timedelta
from django.conf import settings
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.db import transaction
from django.db.models import Q, F, Prefetch
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import serializers
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Meeting, MeetingAttendee, MeetingActionItem, OrganizationMember, TeamMember, Channel
from .permissions import get_active_membership, require_channel_access
from .notification_events import publish_notification_refresh


def active_users(org_id):
    return OrganizationMember.objects.filter(organization_id=org_id, user__is_active=True).values_list('user_id', flat=True)


def visible(request):
    membership = get_active_membership(request)
    org = membership.organization_id
    # A channel-linked meeting also requires current membership of that team.
    return Meeting.objects.filter(organization_id=org, attendees__user=request.user, attendees__invited_at__gte=membership.joined_at).filter(
        Q(channel__isnull=True) | Q(channel__team__members__user=request.user, channel__team__members__joined_at__lte=F('attendees__invited_at'))
    ).distinct().select_related('organizer', 'channel__team').prefetch_related(
        Prefetch('attendees', queryset=MeetingAttendee.objects.filter(user_id__in=active_users(org)).select_related('user')),
        'action_items',
    )


def get_meeting(request, meeting_id, *, lock=False, organizer=False):
    row = visible(request).filter(pk=meeting_id).first()
    if row is None:
        raise NotFound('Meeting not found')
    if lock:
        Meeting.objects.select_for_update().get(pk=row.pk)
        # Re-read after the lock so revisions and cancellation status are current.
        row = visible(request).filter(pk=meeting_id).first()
        if row is None:
            raise NotFound('Meeting not found')
    if organizer and row.organizer_id != request.user.pk:
        raise PermissionDenied('Only the organizer can change this meeting')
    return row


def person(user):
    return {'id': str(user.pk), 'full_name': user.full_name, 'email': user.email}


def serialize(row, user):
    attendees = list(row.attendees.all())
    allowed = {a.user_id for a in attendees}
    return {
        'id': str(row.pk), 'title': row.title, 'agenda': row.agenda,
        'starts_at': row.starts_at.isoformat(), 'ends_at': row.ends_at.isoformat(),
        'time_zone': row.time_zone, 'meeting_url': settings.FRONTEND_ORIGIN+'/?meeting='+str(row.pk), 'notes': row.notes, 'call_ended': bool(row.call_ended_at),
        'cancelled': row.cancelled, 'revision': row.revision, 'organizer': person(row.organizer),
        'channel': {'id': str(row.channel_id), 'name': row.channel.name, 'team_id': str(row.channel.team_id), 'team_name': row.channel.team.name} if row.channel_id else None,
        'my_response': next((a.response for a in attendees if a.user_id == user.pk), 'pending'),
        'attendees': [{'user': person(a.user), 'response': a.response} for a in attendees],
        'action_items': [{'id': str(t.pk), 'title': t.title, 'assignee_id': str(t.assignee_id) if t.assignee_id in allowed else None,
                          'due_date': t.due_date.isoformat() if t.due_date else None, 'done': t.done} for t in row.action_items.all()],
    }


def broadcast(row):
    org, users = row.organization_id, list(row.attendees.values_list('user_id', flat=True))
    transaction.on_commit(lambda: publish_notification_refresh(org, users))


class AwareDateTime(serializers.DateTimeField):
    def to_internal_value(self, value):
        try:
            parsed = parse_datetime(value) if isinstance(value, str) else value
            if parsed is None or timezone.is_naive(parsed):
                raise ValueError()
        except (TypeError, ValueError, AttributeError):
            raise serializers.ValidationError('Include an explicit time-zone offset in this date/time.')
        return super().to_internal_value(value)


class MeetingInput(serializers.Serializer):
    title = serializers.CharField(max_length=180)
    agenda = serializers.CharField(max_length=10000, allow_blank=True, default='')
    starts_at = AwareDateTime()
    ends_at = AwareDateTime()
    time_zone = serializers.CharField(max_length=64, default='UTC')
    attendee_ids = serializers.ListField(child=serializers.UUIDField(), default=list)
    channel_id = serializers.UUIDField(allow_null=True, default=None)
    invite_channel = serializers.BooleanField(default=False)
    notes = serializers.CharField(max_length=20000, allow_blank=True, required=False)
    revision = serializers.IntegerField(min_value=1, required=False)

    def validate_time_zone(self, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise serializers.ValidationError('Choose a valid IANA time zone.')
        return value

    def validate(self, data):
        if self.initial_data.get('meeting_url'):
            raise serializers.ValidationError({'meeting_url': 'Meetings now use internal TeamWorkspace call rooms. Leave this field empty.'})
        if data['ends_at'] <= data['starts_at']:
            raise serializers.ValidationError({'ends_at': 'End time must be after start time.'})
        if data['ends_at'] - data['starts_at'] > timedelta(days=1):
            raise serializers.ValidationError({'ends_at': 'A meeting can last up to 24 hours.'})
        old = self.context.get('meeting')
        if (not old or data['starts_at'] != old.starts_at) and data['starts_at'] < timezone.now() - timedelta(minutes=5):
            raise serializers.ValidationError({'starts_at': 'Choose a current or future start time.'})
        request = self.context['request']
        org = get_active_membership(request).organization_id
        ids = set(data['attendee_ids']) | {request.user.pk}
        if not ids.issubset(set(active_users(org))):
            raise serializers.ValidationError({'attendee_ids': 'Invite active members of this workspace only.'})
        channel = None
        if data['channel_id']:
            channel = require_channel_access(request, data['channel_id'])
            team_ids = set(TeamMember.objects.filter(team=channel.team, user_id__in=active_users(org)).values_list('user_id', flat=True))
            if not ids.issubset(team_ids):
                raise serializers.ValidationError({'attendee_ids': 'Channel meetings can invite current members of that team only.'})
            if data['invite_channel']:
                ids |= team_ids
        elif data['invite_channel']:
            raise serializers.ValidationError({'channel_id': 'Choose a channel to invite its team.'})
        data['_ids'] = ids
        data['_channel'] = channel
        return data


def save_input(request, data, row=None):
    ids, channel = data.pop('_ids'), data.pop('_channel')
    for key in ('attendee_ids', 'channel_id', 'invite_channel', 'revision'):
        data.pop(key, None)
    changed_schedule = row and (row.starts_at != data['starts_at'] or row.ends_at != data['ends_at'])
    if row:
        for name, value in data.items():
            setattr(row, name, value)
        row.channel = channel
        if changed_schedule:
            row.call_ended_at = None
        row.revision += 1
        row.save()
    else:
        row = Meeting.objects.create(organization_id=get_active_membership(request).organization_id, organizer=request.user, channel=channel, **data)
    row.attendees.exclude(user_id__in=ids).delete()
    # Remove assignments to people who are no longer invited.
    row.action_items.exclude(assignee_id__in=ids).update(assignee=None)
    for uid in ids:
        own = uid == request.user.pk
        attendee, created = MeetingAttendee.objects.get_or_create(meeting=row, user_id=uid)
        membership = OrganizationMember.objects.get(organization_id=row.organization_id, user_id=uid)
        joined_at = membership.joined_at
        if channel:
            joined_at = max(joined_at, TeamMember.objects.get(team=channel.team, user_id=uid).joined_at)
        if attendee.invited_at < joined_at:
            attendee.invited_at = timezone.now()
            attendee.response = 'pending'
            created = True
        attendee.invited_at = timezone.now()
        attendee.notice_kind = 'invited' if created else 'updated'
        attendee.notice_read = own
        if own:
            attendee.response = 'accepted'
        elif changed_schedule:
            attendee.response = 'pending'
        attendee.save()
    broadcast(row)
    return visible(request).get(pk=row.pk)


def revision_error(row, data):
    if data.get('revision') != row.revision:
        return Response({'detail': 'This meeting changed. Refresh it before saving.'}, status=409)
    return None


class MeetingsView(APIView):
    def get(self, request):
        rows = visible(request)
        channel_id = request.query_params.get('channel_id')
        if channel_id:
            channel_id = serializers.UUIDField().run_validation(channel_id)
            require_channel_access(request, channel_id)
            rows = rows.filter(channel_id=channel_id, cancelled=False)
        start = request.query_params.get('from')
        end = request.query_params.get('to')
        if start or end:
            # Validate offsets explicitly instead of silently assuming server time.
            a, b = AwareDateTime().run_validation(start), AwareDateTime().run_validation(end)
            if b <= a or b - a > timedelta(days=370):
                raise ValidationError('Choose a date range of up to one year.')
            rows = rows.filter(starts_at__lt=b, ends_at__gt=a)
        return Response({'results': [serialize(row, request.user) for row in rows[:500]], 'limit': 500})

    def post(self, request):
        with transaction.atomic():
            s = MeetingInput(data=request.data, context={'request': request})
            s.is_valid(raise_exception=True)
            row = save_input(request, s.validated_data)
        return Response(serialize(row, request.user), status=201)


class MeetingDetailView(APIView):
    def get(self, request, meeting_id):
        return Response(serialize(get_meeting(request, meeting_id), request.user))

    def delete(self, request, meeting_id):
        with transaction.atomic():
            row = get_meeting(request, meeting_id, lock=True, organizer=True)
            conflict = revision_error(row, request.data)
            if conflict is not None:
                return conflict
            if not (row.cancelled or row.call_ended_at or row.ends_at <= timezone.now()):
                raise ValidationError('Only ended or cancelled meetings can be deleted. Cancel an upcoming meeting first.')
            # Capture notification recipients before deleting related invitation rows.
            broadcast(row)
            row.delete()
        return Response({'status': 'deleted'})

    def patch(self, request, meeting_id):
        with transaction.atomic():
            row = get_meeting(request, meeting_id, lock=True, organizer=True)
            conflict = revision_error(row, request.data)
            if conflict is not None:
                return conflict
            if row.cancelled:
                raise ValidationError('Cancelled meetings cannot be edited.')
            s = MeetingInput(data=request.data, context={'request': request, 'meeting': row})
            s.is_valid(raise_exception=True)
            row = save_input(request, s.validated_data, row)
        return Response(serialize(row, request.user))


class MeetingCancelView(APIView):
    def post(self, request, meeting_id):
        with transaction.atomic():
            row = get_meeting(request, meeting_id, lock=True, organizer=True)
            conflict = revision_error(row, request.data)
            if conflict is not None:
                return conflict
            if not row.cancelled and (row.call_ended_at or row.ends_at <= timezone.now()):
                raise ValidationError('This meeting has ended. Delete it instead of cancelling it.')
            if not row.cancelled:
                row.cancelled = True
                row.revision += 1
                row.save()
                row.attendees.exclude(user=request.user).update(notice_kind='cancelled', notice_read=False)
                broadcast(row)
        return Response(serialize(get_meeting(request, meeting_id), request.user))


class MeetingRSVPView(APIView):
    def post(self, request, meeting_id):
        value = request.data.get('response')
        if value not in ('accepted', 'tentative', 'declined'):
            raise ValidationError({'response': 'Choose accepted, tentative or declined.'})
        with transaction.atomic():
            row = get_meeting(request, meeting_id, lock=True)
            if row.cancelled or row.ends_at <= timezone.now():
                raise ValidationError('This meeting is cancelled or has ended.')
            if row.organizer_id == request.user.pk:
                raise ValidationError('The organizer is already attending.')
            row.attendees.filter(user=request.user).update(response=value, notice_read=True)
            row.attendees.filter(user_id=row.organizer_id).update(notice_kind='response', notice_read=False)
            broadcast(row)
        return Response(serialize(get_meeting(request, meeting_id), request.user))


def reminder_due(row, attendee, now):
    return (not row.cancelled and attendee.response != 'declined' and
            now <= row.starts_at <= now + timedelta(minutes=15) and
            attendee.reminder_read_start != row.starts_at)


class MeetingNotificationsView(APIView):
    def get(self, request):
        now, result = timezone.now(), []
        rows = visible(request).filter(Q(attendees__user=request.user, attendees__notice_read=False) | Q(starts_at__gte=now, starts_at__lte=now+timedelta(minutes=15))).order_by('-updated_at')
        for row in rows[:500]:
            attendee = next(a for a in row.attendees.all() if a.user_id == request.user.pk)
            due = reminder_due(row, attendee, now)
            if not attendee.notice_read or due:
                result.append({'id': str(row.pk), 'title': row.title, 'starts_at': row.starts_at.isoformat(), 'kind': 'reminder' if due else attendee.notice_kind})
        return Response({'results': result})


class MeetingReadView(APIView):
    def post(self, request, meeting_id):
        with transaction.atomic():
            row = get_meeting(request, meeting_id, lock=True)
            attendee = row.attendees.get(user=request.user)
            updates = {'notice_read': True}
            if reminder_due(row, attendee, timezone.now()):
                updates['reminder_read_start'] = row.starts_at
            row.attendees.filter(user=request.user).update(**updates)
        return Response({'status': 'read'})


class MeetingActionItemsView(APIView):
    def post(self, request, meeting_id):
        with transaction.atomic():
            row = get_meeting(request, meeting_id, lock=True, organizer=True)
            if row.action_items.count() >= 100:
                raise ValidationError('Maximum 100 action items.')
            class Input(serializers.Serializer):
                title = serializers.CharField(max_length=300)
                assignee_id = serializers.UUIDField(allow_null=True, default=None)
                due_date = serializers.DateField(allow_null=True, default=None)
            s = Input(data=request.data)
            s.is_valid(raise_exception=True)
            data = s.validated_data
            if data['assignee_id'] and not row.attendees.filter(user_id=data['assignee_id'], user_id__in=active_users(row.organization_id)).exists():
                raise ValidationError({'assignee_id': 'Assign an invited workspace member.'})
            MeetingActionItem.objects.create(meeting=row, **data)
            broadcast(row)
        return Response(serialize(get_meeting(request, meeting_id), request.user), status=201)


class MeetingActionItemView(APIView):
    def patch(self, request, meeting_id, item_id):
        with transaction.atomic():
            row = get_meeting(request, meeting_id, lock=True)
            task = row.action_items.filter(pk=item_id).first()
            if task is None:
                raise NotFound('Action item not found')
            if request.user.pk not in (row.organizer_id, task.assignee_id):
                raise PermissionDenied('Only the organizer or assignee can complete this action item')
            field = serializers.BooleanField()
            task.done = field.run_validation(request.data.get('done'))
            task.save(update_fields=['done'])
            broadcast(row)
        return Response(serialize(get_meeting(request, meeting_id), request.user))


class MeetingCalendarFileView(APIView):
    def get(self, request, meeting_id):
        row = get_meeting(request, meeting_id)
        def escape(value):
            return value.replace('\\', '\\\\').replace('\r', '').replace('\n', '\\n').replace(';', '\\;').replace(',', '\\,')
        def stamp(value):
            from datetime import timezone as tz
            return value.astimezone(tz.utc).strftime('%Y%m%dT%H%M%SZ')
        lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TeamWorkspace//Meetings//EN', 'BEGIN:VEVENT',
                 f'UID:{row.pk}@teamworkspace', f'DTSTAMP:{stamp(timezone.now())}', f'DTSTART:{stamp(row.starts_at)}',
                 f'DTEND:{stamp(row.ends_at)}', f'SUMMARY:{escape(row.title)}', f'DESCRIPTION:{escape(row.agenda)}',
                 f'URL:{settings.FRONTEND_ORIGIN}/?meeting={row.pk}', f'SEQUENCE:{row.revision}', f'STATUS:{"CANCELLED" if row.cancelled else "CONFIRMED"}',
                 'END:VEVENT', 'END:VCALENDAR']
        # Fold UTF-8 lines at <=75 octets, including continuation whitespace.
        folded = []
        for line in lines:
            chunk = ''
            for char in line:
                if len((chunk+char).encode('utf-8')) > 75:
                    folded.append(chunk)
                    chunk = ' '
                chunk += char
            folded.append(chunk)
        response = HttpResponse('\r\n'.join(folded)+'\r\n', content_type='text/calendar; charset=utf-8')
        response['Content-Disposition'] = f'attachment; filename="meeting-{row.pk}.ics"'
        response['Cache-Control'] = 'no-store'
        return response
