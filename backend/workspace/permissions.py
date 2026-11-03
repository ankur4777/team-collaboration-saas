from rest_framework.exceptions import PermissionDenied
from .models import OrganizationMember, TeamMember, Channel


def get_active_membership(request):
    active_id = request.session.get('active_organization_id')
    membership = (OrganizationMember.objects.select_related('organization')
                  .filter(organization_id=active_id, user=request.user).first()) if active_id else None
    if membership is None:
        raise PermissionDenied('Choose an organization you belong to')
    return membership


def require_team_access(request, team, *, manage=False):
    member = get_active_membership(request)
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


def require_channel_access(request, channel_id):
    channel = Channel.objects.select_related('team').filter(id=channel_id).first()
    if not channel:
        from rest_framework.exceptions import NotFound
        raise NotFound('Channel not found')
    require_team_access(request, channel.team)
    return channel
