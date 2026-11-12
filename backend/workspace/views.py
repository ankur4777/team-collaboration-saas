import hashlib
import logging
from urllib.parse import quote
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.core.mail import send_mail
from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView
from .auth_views import auth_payload
from .models import Channel, Invitation, Message, Organization, OrganizationMember, Team, TeamMember, User
from .permissions import get_active_membership, require_channel_access, require_team_access
from .notification_events import publish_notification_refresh
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


class TeamChannelsView(APIView):
    def get_team(self, request, team_id, manage=False):
        team = get_object_or_404(Team, pk=team_id)
        require_team_access(request, team, manage=manage)
        return team

    def get(self, request, team_id):
        team = self.get_team(request, team_id)
        return Response(ChannelSerializer(team.channels.order_by('created_at'), many=True).data)

    def post(self, request, team_id):
        team = self.get_team(request, team_id, manage=True)
        name = str(request.data.get('name', '')).strip()
        if not name or len(name) > 100:
            raise ValidationError({'name': 'Channel name is required (max 100 characters)'})
        try:
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

    def post(self, request, team_id):
        team = get_object_or_404(Team, pk=team_id)
        require_team_access(request, team, manage=True)
        email = str(request.data.get('email', '')).lower().strip()
        member = (OrganizationMember.objects.select_related('user')
                  .filter(organization=team.organization, user__email__iexact=email).first())
        if not member:
            raise ValidationError({'email': 'Invite this employee to the organization first'})
        obj, created = TeamMember.objects.get_or_create(team=team, user=member.user)
        if not created:
            raise ValidationError({'email': 'Employee is already on this team'})
        return Response({'user_id': str(member.user.id), 'role': obj.role}, status=status.HTTP_201_CREATED)


def broadcast_message(channel_id, payload):
    try:
        async_to_sync(get_channel_layer().group_send)(f'channel_{channel_id}', {
            'type': 'chat.message', 'message': payload,
        })
    except Exception:
        # Persisted message remains valid; clients can refresh if Redis is unavailable.
        logger.exception('WebSocket broadcast failed for channel %s', channel_id)


class ChannelMessagesView(APIView):
    def get(self, request, channel_id):
        channel = require_channel_access(request, channel_id)
        records = Message.objects.filter(channel=channel).select_related('sender')
        before = request.query_params.get('before')
        if before:
            timestamp = parse_datetime(before)
            if timestamp is None or timezone.is_naive(timestamp):
                raise ValidationError({'before': 'Use an ISO 8601 timestamp with timezone'})
            records = records.filter(created_at__lt=timestamp)
        records = list(records.order_by('-created_at', '-id')[:50])
        records.reverse()
        return Response(MessageSerializer(records, many=True).data)

    def post(self, request, channel_id):
        channel = require_channel_access(request, channel_id)
        body = str(request.data.get('body', '')).strip()
        if not body or len(body) > 4000:
            raise ValidationError({'body': 'Message must contain 1–4000 characters'})
        message = Message.objects.create(channel=channel, sender=request.user, body=body)
        payload = MessageSerializer(message).data
        transaction.on_commit(lambda: broadcast_message(channel.id, payload))
        recipients = list(TeamMember.objects.filter(
            team=channel.team,
            user__organization_memberships__organization_id=channel.team.organization_id,
            user__is_active=True,
        ).values_list('user_id', flat=True).distinct())
        transaction.on_commit(
            lambda: publish_notification_refresh(channel.team.organization_id, recipients)
        )
        return Response(payload, status=status.HTTP_201_CREATED)
