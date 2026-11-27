"""Tenant-scoped assignments; employees see only tasks assigned to them."""
from django.db.models import Q
from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView
from .directory import is_manager, is_senior
from .models import EmployeeTask, OrganizationMember
from .permissions import get_active_membership
from .serializers import UserSerializer


class TaskInput(serializers.Serializer):
    title = serializers.CharField(max_length=200)
    description = serializers.CharField(max_length=4000, allow_blank=True, required=False)
    assignee_id = serializers.UUIDField()
    status = serializers.ChoiceField(choices=EmployeeTask.Status.choices, required=False)
    priority = serializers.ChoiceField(choices=['low', 'normal', 'high'], required=False)
    due_date = serializers.DateField(allow_null=True, required=False)


def visible_tasks(actor):
    rows = EmployeeTask.objects.filter(organization_id=actor.organization_id).select_related('assignee', 'assigned_by')
    if is_manager(actor):
        return rows
    if actor.is_senior:
        return rows.filter(Q(assignee_id=actor.user_id) | Q(assigned_by_id=actor.user_id))
    return rows.filter(assignee_id=actor.user_id)


def task_row(row, actor):
    can_manage = is_manager(actor) or (is_senior(actor) and row.assigned_by_id == actor.user_id)
    return {'id': str(row.pk), 'title': row.title, 'description': row.description,
            'assignee': UserSerializer(row.assignee).data, 'assigned_by': UserSerializer(row.assigned_by).data,
            'status': row.status, 'priority': row.priority, 'due_date': row.due_date,
            'created_at': row.created_at, 'updated_at': row.updated_at,
            'can_manage': can_manage, 'can_update_status': can_manage or row.assignee_id == actor.user_id}


def validated_changes(request, actor, partial=False):
    if set(request.data) - set(TaskInput().fields):
        raise ValidationError({'detail': 'Unsupported task field.'})
    payload = TaskInput(data=request.data, partial=partial)
    payload.is_valid(raise_exception=True)
    data = payload.validated_data
    if 'assignee_id' in data:
        if not OrganizationMember.objects.filter(organization_id=actor.organization_id, user_id=data['assignee_id'], user__is_active=True).exists():
            raise ValidationError({'assignee_id': 'Choose an active employee in this workspace.'})
    return data


class EmployeeTasksView(APIView):
    def get(self, request):
        actor = get_active_membership(request)
        rows = visible_tasks(actor)
        status = request.query_params.get('status', '')
        if status:
            if status not in EmployeeTask.Status.values:
                raise ValidationError({'status': 'Use todo, in_progress, or done.'})
            rows = rows.filter(status=status)
        if request.query_params.get('scope') == 'mine':
            rows = rows.filter(assignee_id=actor.user_id)
        return Response({'results': [task_row(row, actor) for row in rows[:200]], 'can_assign': is_senior(actor), 'limit': 200})

    def post(self, request):
        actor = get_active_membership(request)
        if not is_senior(actor):
            raise PermissionDenied('Only Seniors and company admins can assign tasks.')
        data = validated_changes(request, actor)
        row = EmployeeTask.objects.create(organization_id=actor.organization_id, assigned_by=request.user, **data)
        return Response(task_row(row, actor), status=201)


class EmployeeTaskDetailView(APIView):
    @transaction.atomic
    def patch(self, request, task_id):
        actor = get_active_membership(request)
        row = get_object_or_404(visible_tasks(actor).select_for_update(), pk=task_id)
        can_manage = task_row(row, actor)['can_manage']
        if not can_manage and (row.assignee_id != request.user.pk or set(request.data) != {'status'}):
            raise PermissionDenied('Employees can update only the status of their assigned tasks.')
        data = validated_changes(request, actor, partial=True)
        if not data:
            raise ValidationError({'detail': 'Provide a task change.'})
        for key, value in data.items():
            setattr(row, key, value)
        row.save()
        return Response(task_row(row, actor))

    @transaction.atomic
    def delete(self, request, task_id):
        actor = get_active_membership(request)
        row = get_object_or_404(visible_tasks(actor).select_for_update(), pk=task_id)
        if not task_row(row, actor)['can_manage']:
            raise PermissionDenied('Only the assigning Senior, a company admin can delete this task.')
        row.delete()
        return Response(status=204)
