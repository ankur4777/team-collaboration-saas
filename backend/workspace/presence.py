"""Workspace-scoped presence estimates from recent foreground app heartbeats.

The timestamp belongs to a membership, not the global user or a device.
No IP addresses, page history, or other activity details are exposed.
"""
from datetime import timedelta
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView
from .models import OrganizationMember
from .permissions import get_active_membership

ONLINE_WINDOW_SECONDS = 90


class WorkspacePresenceView(APIView):
    def post(self, request, pk):
        membership = get_active_membership(request)
        if membership.organization_id != pk:
            raise PermissionDenied('Not the active organization')
        now = timezone.now()
        # Never accept a client-provided user ID or timestamp. The update
        # remains scoped even if another tab changes the active workspace.
        OrganizationMember.objects.filter(
            pk=membership.pk, organization_id=pk, user=request.user,
        ).filter(Q(last_seen_at__isnull=True) | Q(last_seen_at__lt=now)).update(last_seen_at=now)
        cutoff = now - timedelta(seconds=ONLINE_WINDOW_SECONDS)
        rows = OrganizationMember.objects.filter(
            organization_id=pk, user__is_active=True,
        ).values_list('user_id', 'last_seen_at')
        return Response({
            'workspace_id': str(pk),
            'members': [
                {'user_id': str(user_id), 'online': bool(seen and seen >= cutoff),
                 'last_seen_at': seen.isoformat() if seen else None}
                for user_id, seen in rows
            ],
        }, headers={'Cache-Control': 'private, no-store'})
