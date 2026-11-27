"""Workspace employee hierarchy and explicitly assigned Senior capabilities."""
from uuid import UUID
from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView
from .models import Department, OrganizationMember, Team, TeamMember
from .permissions import get_active_membership


def is_manager(member):
    return member.role == OrganizationMember.Role.ADMIN


def is_senior(member):
    return is_manager(member) or member.is_senior


def can_delete_group(member, chat):
    return chat.kind == 'group' and (is_manager(member) or (member.is_senior and chat.created_by_id == member.user_id))


def uuid_value(value, field):
    try:
        return UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        raise ValidationError({field: 'Choose a valid workspace record.'})


def member_row(member):
    return {'id': str(member.pk), 'role': member.role, 'job_title': member.job_title,
            'position_rank': member.position_rank, 'is_senior': member.is_senior,
            'user': {'id': str(member.user_id), 'full_name': member.user.full_name, 'email': member.user.email}}


class ChatDirectoryView(APIView):
    def get(self, request):
        actor = get_active_membership(request)
        members = list(OrganizationMember.objects.filter(organization_id=actor.organization_id, user__is_active=True)
                       .select_related('user').order_by('position_rank', 'user__full_name', 'id'))
        rows = {member.user_id: member_row(member) for member in members}
        teams = []
        for team in Team.objects.filter(organization_id=actor.organization_id, archived_at__isnull=True).prefetch_related('members').order_by('name'):
            ids = {link.user_id for link in team.members.all()}
            teams.append({'id': str(team.pk), 'name': team.name,
                          'department_id': str(team.department_id) if team.department_id else None,
                          'members': [rows[member.user_id] for member in members if member.user_id in ids]})
        return Response({'departments': list(Department.objects.filter(organization_id=actor.organization_id).values('id', 'name')),
                         'teams': teams, 'members': list(rows.values()),
                         'can_manage': is_manager(actor), 'can_create_groups': is_senior(actor), 'can_assign_tasks': is_senior(actor)})


class DepartmentsView(APIView):
    def post(self, request):
        actor = get_active_membership(request)
        if not is_manager(actor):
            raise PermissionDenied('Only company admins can create departments.')
        name = request.data.get('name')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
            raise ValidationError({'name': 'Enter a department name up to 120 characters.'})
        try:
            with transaction.atomic():
                if Department.objects.filter(organization_id=actor.organization_id, name__iexact=name.strip()).exists():
                    raise ValidationError({'name': 'This department already exists.'})
                row = Department.objects.create(organization_id=actor.organization_id, name=name.strip())
        except IntegrityError:
            raise ValidationError({'name': 'This department already exists.'})
        return Response({'id': str(row.pk), 'name': row.name}, status=201)


class DirectoryTeamView(APIView):
    def patch(self, request, team_id):
        actor = get_active_membership(request)
        if not is_manager(actor):
            raise PermissionDenied('Only company admins can organize departments.')
        if set(request.data) != {'department_id'}:
            raise ValidationError({'department_id': 'Provide the department to assign, or null for Unassigned.'})
        team = get_object_or_404(Team, pk=team_id, organization_id=actor.organization_id)
        value = request.data['department_id']
        department = get_object_or_404(Department, pk=uuid_value(value, 'department_id'), organization_id=actor.organization_id) if value else None
        team.department = department
        team.save(update_fields=['department'])
        return Response({'id': str(team.pk), 'department_id': str(department.pk) if department else None})


class DirectoryMemberView(APIView):
    def patch(self, request, member_id):
        actor = get_active_membership(request)
        if not is_manager(actor):
            raise PermissionDenied('Only company admins can set positions and Senior roles.')
        row = get_object_or_404(OrganizationMember.objects.select_related('user'), pk=member_id, organization_id=actor.organization_id)
        data = request.data
        if not data or set(data) - {'job_title', 'position_rank', 'is_senior'}:
            raise ValidationError({'detail': 'Update position title, display order, or Senior role only.'})
        if 'job_title' in data:
            if not isinstance(data['job_title'], str) or len(data['job_title'].strip()) > 100:
                raise ValidationError({'job_title': 'Use a position title up to 100 characters.'})
            row.job_title = data['job_title'].strip()
        if 'position_rank' in data:
            if type(data['position_rank']) is not int or not 1 <= data['position_rank'] <= 10000:
                raise ValidationError({'position_rank': 'Use an order from 1 to 10000. Lower numbers appear first.'})
            row.position_rank = data['position_rank']
        if 'is_senior' in data:
            if type(data['is_senior']) is not bool:
                raise ValidationError({'is_senior': 'Use true or false.'})
            row.is_senior = data['is_senior']
        row.save(update_fields=list(data))
        return Response(member_row(row))


class DirectoryTeamMembersView(APIView):
    def post(self, request, team_id):
        actor = get_active_membership(request)
        if not is_manager(actor):
            raise PermissionDenied('Only company admins can organize team membership.')
        team = get_object_or_404(Team, pk=team_id, organization_id=actor.organization_id, archived_at__isnull=True)
        user_id = uuid_value(request.data.get('user_id'), 'user_id')
        member = get_object_or_404(OrganizationMember, organization_id=actor.organization_id, user_id=user_id, user__is_active=True)
        link, created = TeamMember.objects.get_or_create(team=team, user_id=member.user_id)
        return Response({'id': str(link.pk)}, status=201 if created else 200)
