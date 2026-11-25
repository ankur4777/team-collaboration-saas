import hashlib
import logging
from uuid import UUID
from urllib.parse import quote
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.core.mail import send_mail
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView
from .auth_views import auth_payload
from .models import Channel, Invitation, MentionNotification, Message, Organization, OrganizationMember, Team, TeamMember, User
from .permissions import get_active_membership, require_channel_access, require_team_access
from .notification_events import publish_notification_refresh
from .mentions import create_mentions
from .message_replies import resolve_reply_target
from .serializers import OrganizationMemberSerializer, TeamSerializer, ChannelSerializer, MessageSerializer

logger = logging.getLogger(__name__)


class OrganizationListView(APIView):
    def get(self, request):
        return Response(auth_payload(request))


class ActivateOrganizationView(APIView):
    def post(self, request, pk):
        if not OrganizationMember.objects.filter(organization_id=pk, user=request.user).exists():
            raise PermissionDenied('Not a member of this organization')
        request.session['active_organization_id'] = str(pk)
        return Response(auth_payload(request))


class OrganizationMembersView(APIView):
    def get(self, request, pk):
        membership = get_active_membership(request)
        if str(membership.organization_id) != str(pk):
            raise PermissionDenied('Not the active organization')
        members = OrganizationMember.objects.filter(organization_id=pk).select_related('user').order_by('user__full_name')
        return Response(OrganizationMemberSerializer(members, many=True).data)


class OrganizationInvitationsView(APIView):
    def post(self, request, pk):
        membership = get_active_membership(request)
        if str(membership.organization_id) != str(pk):
            raise PermissionDenied('Not the active organization')
        if membership.role not in (OrganizationMember.Role.OWNER, OrganizationMember.Role.ADMIN):
            raise PermissionDenied('Administrator access required')
        email = str(request.data.get('email', '')).lower().strip()
        role = str(request.data.get('role', 'member'))
        if not email or len(email) > 254 or '@' not in email:
            raise ValidationError({'email': 'Enter a valid email address'})
        if role not in (OrganizationMember.Role.ADMIN, OrganizationMember.Role.MEMBER):
            raise ValidationError({'role': 'Invites may grant admin or member access'})
        if role == OrganizationMember.Role.ADMIN and membership.role != OrganizationMember.Role.OWNER:
            raise PermissionDenied('Only the workspace owner can invite administrators')
        if OrganizationMember.objects.filter(organization_id=pk, user__email__iexact=email).exists():
            raise ValidationError({'email': 'This person is already a member'})
        token = Invitation.generate_token()
        inv = Invitation.objects.create(
            organization_id=pk, email=email, role=role,
            token_hash=hashlib.sha256(token.encode()).hexdigest(), invited_by=request.user,
        )
        invite_url = f'{settings.FRONTEND_ORIGIN}/invite?token={quote(token)}'
        send_mail(
            subject=f'Invitation to join {membership.organization.name}',
            message=(f'You are invited to join {membership.organization.name}.\n\n'
                     f'Use this private link before it expires:\n{invite_url}\n\n'
                     'If you did not expect this invitation, ignore this email.'),
            from_email=settings.DEFAULT_FROM_EMAIL, recipient_list=[email],
            fail_silently=False,
        )
        payload = {'id': str(inv.id), 'email': email, 'role': role, 'detail': 'Invitation sent'}
        if settings.DEBUG:
            payload['development_invite_url'] = invite_url  # Never return tokens in production.
        return Response(payload, status=status.HTTP_201_CREATED)


class TeamsView(APIView):
    def get(self, request):
        membership = get_active_membership(request)
        teams = (Team.objects.filter(organization_id=membership.organization_id,
                                     members__user=request.user)
                 .order_by('name'))
        return Response(TeamSerializer(teams, many=True).data)

    def post(self, request):
        membership = get_active_membership(request)
        name = str(request.data.get('name', '')).strip()
        description = str(request.data.get('description', '')).strip()
        if not name or len(name) > 120 or len(description) > 500:
            raise ValidationError({'name': 'Team name is required (max 120 characters)'})
        try:
            with transaction.atomic():
                team = Team.objects.create(organization=membership.organization, name=name,
                                           description=description, created_by=request.user)
                TeamMember.objects.create(team=team, user=request.user, role=TeamMember.Role.OWNER)
                Channel.objects.create(team=team, name='General')
        except IntegrityError:
            raise ValidationError({'name': 'This organization already has a team with that name'})
        return Response(TeamSerializer(team).data, status=status.HTTP_201_CREATED)


def locked_team(request, team_id):
    team = get_object_or_404(Team.objects.select_for_update(), pk=team_id)
    require_team_access(request, team, manage=True)
    return team


def update_name(request, obj, serializer, maximum):
    name = request.data.get('name')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= maximum:
        raise ValidationError({'name': f'Enter a name of 1–{maximum} characters'})
    obj.name = name.strip()
    try:
        with transaction.atomic():
            obj.save(update_fields=['name'])
    except IntegrityError:
        raise ValidationError({'name': 'This name is already in use'})
    return Response(serializer(obj).data)


class TeamDetailView(APIView):
    @transaction.atomic
    def patch(self, request, team_id):
        return update_name(request, locked_team(request, team_id), TeamSerializer, 120)


class ChannelDetailView(APIView):
    @transaction.atomic
    def patch(self, request, team_id, channel_id):
        team = locked_team(request, team_id)
        channel = get_object_or_404(Channel, pk=channel_id, team=team)
        return update_name(request, channel, ChannelSerializer, 100)


class TeamOwnershipView(APIView):
    @transaction.atomic
    def post(self, request, team_id):
        team = locked_team(request, team_id)
        actor = TeamMember.objects.get(team=team, user=request.user)
        if actor.role != TeamMember.Role.OWNER:
            raise PermissionDenied('Only a team owner can transfer ownership')
        try:
            target_id = UUID(str(request.data.get('user_id', '')))
        except (TypeError, ValueError):
            raise ValidationError({'user_id': 'Choose a valid team member'})
        if target_id == request.user.pk:
            raise ValidationError({'user_id': 'Choose another member'})
        target = get_object_or_404(
            TeamMember, team=team, user_id=target_id, user__is_active=True,
            user__organization_memberships__organization_id=team.organization_id,
        )
        target.role = TeamMember.Role.OWNER
        target.save(update_fields=['role'])
        actor.role = TeamMember.Role.MEMBER
        actor.save(update_fields=['role'])
        return Response(status=status.HTTP_204_NO_CONTENT)


class TeamMemberDetailView(APIView):
    @transaction.atomic
    def delete(self, request, team_id, user_id):
        team = locked_team(request, team_id)
        target = get_object_or_404(TeamMember, team=team, user_id=user_id)
        if target.role == TeamMember.Role.OWNER:
            raise PermissionDenied('Transfer ownership before removing a team owner')
        target.delete()
        transaction.on_commit(lambda: publish_notification_refresh(team.organization_id, [user_id]))
        return Response(status=status.HTTP_204_NO_CONTENT)


class TeamChannelsView(APIView):
    def get_team(self, request, team_id, manage=False):
        team = get_object_or_404(Team, pk=team_id)
        require_team_access(request, team, manage=manage)
        return team

    def get(self, request, team_id):
        team = self.get_team(request, team_id)
        return Response(ChannelSerializer(team.channels.order_by('created_at'), many=True).data)

    @transaction.atomic
    def post(self, request, team_id):
        team = locked_team(request, team_id)
        name = str(request.data.get('name', '')).strip()
        if not name or len(name) > 100:
            raise ValidationError({'name': 'Channel name is required (max 100 characters)'})
        try:
            with transaction.atomic():
                channel = Channel.objects.create(team=team, name=name)
        except IntegrityError:
            raise ValidationError({'name': 'This channel already exists'})
        return Response(ChannelSerializer(channel).data, status=status.HTTP_201_CREATED)


class TeamMembersView(APIView):
    def get(self, request, team_id):
        team = get_object_or_404(Team, pk=team_id)
        require_team_access(request, team)
        members = (TeamMember.objects.filter(team=team).select_related('user')
                   .values('user__id', 'user__email', 'user__full_name', 'role'))
        return Response([{'user': {'id': str(m['user__id']), 'email': m['user__email'],
                                    'full_name': m['user__full_name']}, 'role': m['role']} for m in members])

    @transaction.atomic
    def post(self, request, team_id):
        team = locked_team(request, team_id)
        email = str(request.data.get('email', '')).lower().strip()
        member = (OrganizationMember.objects.select_related('user')
                  .filter(organization=team.organization, user__email__iexact=email).first())
        if not member:
            raise ValidationError({'email': 'Invite this employee to the organization first'})
        obj, created = TeamMember.objects.get_or_create(team=team, user=member.user)
        if not created:
            raise ValidationError({'email': 'Employee is already on this team'})
        return Response({'user_id': str(member.user.id), 'role': obj.role}, status=status.HTTP_201_CREATED)


def broadcast_message(channel_id, payload, action='message'):
    try:
        async_to_sync(get_channel_layer().group_send)(f'channel_{channel_id}', {
            'type': 'chat.message', 'message': payload, 'action': action,
        })
    except Exception:
        # Persisted message remains valid; clients can refresh if Redis is unavailable.
        logger.exception('WebSocket broadcast failed for channel %s', channel_id)


class ChannelMessagesView(APIView):
    def get(self, request, channel_id):
        channel = require_channel_access(request, channel_id)
        joined = TeamMember.objects.get(team=channel.team, user=request.user).joined_at
        records = Message.objects.filter(channel=channel, created_at__gte=joined).select_related('sender')
        before = request.query_params.get('before')
        before_id = request.query_params.get('before_id')
        paged = request.query_params.get('page')
        if paged is not None and paged != '1':
            raise ValidationError({'page': 'Use page=1 to request a paginated response'})
        if before_id is not None and not before:
            raise ValidationError({'before_id': 'Provide before with before_id'})
        if before is not None:
            timestamp = parse_datetime(before)
            if timestamp is None or timezone.is_naive(timestamp):
                raise ValidationError({'before': 'Use an ISO 8601 timestamp with timezone'})
            if before_id is not None:
                try:
                    cursor_id = UUID(before_id)
                except (TypeError, ValueError, AttributeError):
                    raise ValidationError({'before_id': 'Provide a valid message UUID'})
                # Composite cursor avoids missing or repeating posts with identical timestamps.
                records = records.filter(
                    Q(created_at__lt=timestamp)
                    | Q(created_at=timestamp, id__lt=cursor_id)
                )
            else:
                # Preserve compatibility with existing timestamp-only clients.
                records = records.filter(created_at__lt=timestamp)
        rows = list(records.order_by('-created_at', '-id')[:51 if paged else 50])
        if paged:
            has_more = len(rows) > 50
            rows = rows[:50]
            oldest = rows[-1] if rows else None
            cursor = ({
                'before': oldest.created_at.isoformat(),
                'before_id': str(oldest.pk),
            } if has_more and oldest else None)
            rows.reverse()
            return Response({
                'items': MessageSerializer(rows, many=True).data,
                'has_more': has_more,
                'next_cursor': cursor,
            })
        rows.reverse()
        return Response(MessageSerializer(rows, many=True).data)

    def post(self, request, channel_id):
        channel = require_channel_access(request, channel_id)
        body = str(request.data.get('body', '')).strip()
        if not body or len(body) > 4000:
            raise ValidationError({'body': 'Message must contain 1–4000 characters'})
        with transaction.atomic():
            joined = TeamMember.objects.get(team=channel.team, user=request.user).joined_at
            reply_id = resolve_reply_target(request, Message.objects.filter(channel=channel, created_at__gte=joined))
            message = Message.objects.create(channel=channel, sender=request.user, body=body, reply_to_id=reply_id)
            eligible_members = list(TeamMember.objects.filter(
                team=channel.team,
                user__organization_memberships__organization_id=channel.team.organization_id,
                user__is_active=True,
            ).select_related('user').distinct())
            create_mentions(
                organization_id=channel.team.organization_id, sender_id=request.user.pk,
                body=body, eligible_users=[member.user for member in eligible_members],
                channel_message=message,
            )
            payload = MessageSerializer(message).data
            transaction.on_commit(lambda: broadcast_message(channel.id, payload))
            recipients = [member.user_id for member in eligible_members]
            transaction.on_commit(
                lambda: publish_notification_refresh(channel.team.organization_id, recipients)
            )
        return Response(payload, status=status.HTTP_201_CREATED)


class ChannelMessageDetailView(APIView):
    """Only an authorized message author can edit or soft-delete their channel post."""

    def patch(self, request, channel_id, message_id):
        channel = require_channel_access(request, channel_id)
        joined = TeamMember.objects.get(team=channel.team, user=request.user).joined_at
        body = request.data.get('body')
        if not isinstance(body, str) or not 1 <= len(body.strip()) <= 4000:
            raise ValidationError({'body': 'Message must contain 1–4000 characters'})
        with transaction.atomic():
            message = get_object_or_404(
                Message.objects.select_for_update().select_related('sender').filter(created_at__gte=joined),
                pk=message_id, channel=channel,
            )
            if message.sender_id != request.user.pk:
                raise PermissionDenied('Only the author can edit this message')
            if message.deleted_at:
                raise ValidationError({'detail': 'Deleted messages cannot be edited'})
            message.body = body.strip()
            message.edited_at = timezone.now()
            message.save(update_fields=['body', 'edited_at'])
            payload = MessageSerializer(message).data
            transaction.on_commit(
                lambda: broadcast_message(channel.pk, payload, action='message.updated')
            )
        return Response(payload)

    def delete(self, request, channel_id, message_id):
        channel = require_channel_access(request, channel_id)
        joined = TeamMember.objects.get(team=channel.team, user=request.user).joined_at
        with transaction.atomic():
            message = get_object_or_404(
                Message.objects.select_for_update().select_related('sender').filter(created_at__gte=joined),
                pk=message_id, channel=channel,
            )
            if message.sender_id != request.user.pk:
                raise PermissionDenied('Only the author can delete this message')
            if message.deleted_at is None:
                recipients = list(MentionNotification.objects.filter(
                    channel_message=message,
                ).values_list('recipient_id', flat=True))
                MentionNotification.objects.filter(channel_message=message).delete()
                message.body = ''
                message.deleted_at = timezone.now()
                message.pinned_at = None
                message.save(update_fields=['body', 'deleted_at', 'pinned_at'])
                payload = MessageSerializer(message).data
                transaction.on_commit(
                    lambda: broadcast_message(channel.pk, payload, action='message.deleted')
                )
                members = list(TeamMember.objects.filter(
                    team=channel.team,
                    user__organization_memberships__organization_id=channel.team.organization_id,
                    user__is_active=True,
                ).values_list('user_id', flat=True))
                transaction.on_commit(
                    lambda: publish_notification_refresh(
                        channel.team.organization_id, set(members + recipients)
                    )
                )
        return Response(status=status.HTTP_204_NO_CONTENT)
