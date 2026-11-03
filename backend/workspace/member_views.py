"""Authenticated workspace membership administration.

Every mutation is scoped to the current session's active organization.
The organization owner alone may change role assignments; admins may remove
ordinary members, but not other admins or team owners.
"""
from django.db import transaction
from rest_framework import status
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import OrganizationMember, TeamMember
from .permissions import get_active_membership
from .serializers import OrganizationMemberSerializer


class OrganizationMemberDetailView(APIView):
    def _authorize(self, request, org_id, member_id, *, role_change=False):
        actor = get_active_membership(request)
        if actor.organization_id != org_id:
            raise PermissionDenied('Not the active organization')

        target = (OrganizationMember.objects.select_related('user')
                  .filter(pk=member_id, organization_id=org_id).first())
        if not target:
            raise NotFound('Workspace member not found')

        if target.user_id == request.user.pk:
            raise PermissionDenied('You cannot change or remove your own membership')
        if target.role == OrganizationMember.Role.OWNER:
            raise PermissionDenied('Workspace ownership cannot be changed here')

        if role_change:
            if actor.role != OrganizationMember.Role.OWNER:
                raise PermissionDenied('Only the workspace owner may change roles')
        elif actor.role != OrganizationMember.Role.OWNER and not (
            actor.role == OrganizationMember.Role.ADMIN
            and target.role == OrganizationMember.Role.MEMBER
        ):
            raise PermissionDenied('You cannot remove this workspace member')
        return target

    def patch(self, request, pk, member_id):
        role = request.data.get('role')
        if role not in (OrganizationMember.Role.ADMIN, OrganizationMember.Role.MEMBER):
            raise ValidationError({'role': 'Role must be admin or member'})
        with transaction.atomic():
            target = self._authorize(request, pk, member_id, role_change=True)
            # Lock the row and reauthorize against its current role.
            target = (OrganizationMember.objects.select_for_update()
                      .get(pk=target.pk))
            if target.role == OrganizationMember.Role.OWNER:
                raise PermissionDenied('Workspace ownership cannot be changed here')
            target.role = role
            target.save(update_fields=['role'])
        return Response(OrganizationMemberSerializer(target).data)

    def delete(self, request, pk, member_id):
        with transaction.atomic():
            target = self._authorize(request, pk, member_id)
            target = (OrganizationMember.objects.select_for_update()
                      .get(pk=target.pk))
            # An admin can never remove another admin, including after a
            # concurrent role change before we acquired the row lock.
            actor = get_active_membership(request)
            if target.role == OrganizationMember.Role.OWNER or (
                actor.role != OrganizationMember.Role.OWNER
                and target.role != OrganizationMember.Role.MEMBER
            ):
                raise PermissionDenied('You cannot remove this workspace member')
            if TeamMember.objects.filter(
                team__organization_id=pk,
                user_id=target.user_id,
                role=TeamMember.Role.OWNER,
            ).exists():
                return Response(
                    {'detail': 'Transfer this employee’s team ownership before removing them'},
                    status=status.HTTP_409_CONFLICT,
                )

            # Do not delete the global user account: it may belong to other
            # companies. Remove access only in this organization.
            TeamMember.objects.filter(
                team__organization_id=pk, user_id=target.user_id,
            ).delete()
            target.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
