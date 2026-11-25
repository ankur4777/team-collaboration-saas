from rest_framework.exceptions import PermissionDenied
from django.db.models import Q
from .models import OrganizationMember, TeamMember, Channel, PrivateChannelMember
from .license_access import effective_status, enabled_modules, workspace_license, BLOCKED, route_modules, require_module


def get_active_membership(request):
    active_id = request.session.get('active_organization_id')
    membership = (OrganizationMember.objects.select_related('organization')
                  .filter(organization_id=active_id, user=request.user).first()) if active_id else None
    if membership is None:
        raise PermissionDenied('Choose an organization you belong to')
    license_row = workspace_license(membership.organization_id)
    if effective_status(license_row) in BLOCKED:
        raise PermissionDenied('Workspace subscription is not active. Contact your company administrator.', code='subscription_inactive')
    required = route_modules(request.path_info)
    if required and not enabled_modules(license_row).intersection(required):
        raise PermissionDenied('This module is not included in your company subscription.', code='module_disabled')
    return membership


def require_team_access(request, team, *, manage=False):
    member = get_active_membership(request)
    require_module(member.organization_id, 'teams')
    if team.organization_id != member.organization_id:
        raise PermissionDenied('No access to this team')
    team_member = TeamMember.objects.filter(team=team, user=request.user).first()
    if not team_member:
        raise PermissionDenied('No access to this team')
    if manage and team_member.role != TeamMember.Role.OWNER and member.role not in (
        OrganizationMember.Role.OWNER, OrganizationMember.Role.ADMIN
    ):
        raise PermissionDenied('Only team owners and organization administrators can manage this team')
    return team_member


def channel_access_filter(user_id):
    return Q(is_private=False) | Q(private_members__team_member__user_id=user_id)


def channel_joined_at(channel, user_id):
    member = TeamMember.objects.filter(team_id=channel.team_id, user_id=user_id).first()
    if not member:
        raise PermissionDenied('No access to this channel')
    if not channel.is_private:
        return member.joined_at
    private = PrivateChannelMember.objects.filter(channel=channel, team_member=member).first()
    if not private:
        raise PermissionDenied('No access to this private channel')
    return max(member.joined_at, private.joined_at)


def channel_team_members(channel):
    rows = TeamMember.objects.filter(team_id=channel.team_id)
    if channel.is_private:
        rows = rows.filter(private_channel_memberships__channel=channel)
    return rows


def require_channel_access(request, channel_id, *, write=False):
    channel = Channel.objects.select_related('team').filter(id=channel_id).first()
    if not channel:
        from rest_framework.exceptions import NotFound
        raise NotFound('Channel not found')
    require_team_access(request, channel.team)
    channel_joined_at(channel, request.user.pk)
    if write:
        require_channel_writable(channel)
    return channel


def require_channel_writable(channel):
    if channel.archived_at or channel.team.archived_at:
        raise PermissionDenied('This channel is archived and read-only. Restore it to make changes.')
