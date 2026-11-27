"""Private, tenant-scoped workspace Shared Files library."""
from django.db import transaction
from django.http import FileResponse
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import OrganizationMember, WorkspaceFile
from .permissions import get_active_membership
from .private_attachments import validate_upload


def can_delete_file(row, membership):
    return row.uploaded_by_id == membership.user_id or membership.role in (
        OrganizationMember.Role.ADMIN,
    )


def file_row(row, membership):
    return {
        'id': str(row.pk),
        'name': row.original_name,
        'size': row.size,
        'content_type': row.content_type,
        'can_delete': can_delete_file(row, membership),
        'created_at': row.created_at.isoformat(),
        'uploaded_by': {
            'id': str(row.uploaded_by_id),
            'full_name': row.uploaded_by.full_name,
            'email': row.uploaded_by.email,
        },
    }


class WorkspaceFilesView(APIView):
    def get(self, request):
        membership = get_active_membership(request)
        rows = WorkspaceFile.objects.filter(
            organization_id=membership.organization_id,
        ).select_related('uploaded_by')
        query = str(request.query_params.get('q', '')).strip()
        if query:
            rows = rows.filter(original_name__icontains=query)
        category = str(request.query_params.get('category', 'all'))
        if category == 'images':
            rows = rows.filter(content_type__startswith='image/')
        elif category == 'documents':
            rows = rows.exclude(content_type__startswith='image/')
        elif category != 'all':
            return Response({'category': 'Use all, images, or documents.'}, status=400)
        return Response({'results': [file_row(row, membership) for row in rows[:100]], 'limit': 100})

    def post(self, request):
        membership = get_active_membership(request)
        upload = request.FILES.get('file')
        name, content_type = validate_upload(upload)
        with transaction.atomic():
            row = WorkspaceFile.objects.create(
                organization_id=membership.organization_id,
                uploaded_by=request.user,
                file=upload,
                original_name=name,
                content_type=content_type,
                size=upload.size,
            )
        return Response(file_row(row, membership), status=status.HTTP_201_CREATED)


class WorkspaceFileDetailView(APIView):
    def delete(self, request, file_id):
        membership = get_active_membership(request)
        with transaction.atomic():
            row = get_object_or_404(
                WorkspaceFile.objects.select_for_update(),
                pk=file_id, organization_id=membership.organization_id,
            )
            if not can_delete_file(row, membership):
                raise PermissionDenied('Only the uploader or a workspace administrator can delete this file.')
            storage, name = row.file.storage, row.file.name
            row.delete()
            # Remove stored bytes only after the database deletion commits.
            # Django logs storage errors without undoing a committed deletion.
            if name:
                transaction.on_commit(lambda: storage.delete(name), robust=True)
        return Response(status=status.HTTP_204_NO_CONTENT)


class WorkspaceFileDownloadView(APIView):
    def get(self, request, file_id):
        membership = get_active_membership(request)
        row = get_object_or_404(
            WorkspaceFile.objects.select_related('uploaded_by'),
            pk=file_id, organization_id=membership.organization_id,
        )
        try:
            stream = row.file.open('rb')
        except (FileNotFoundError, OSError):
            from rest_framework.exceptions import NotFound
            raise NotFound('File is no longer stored')
        response = FileResponse(
            stream, as_attachment=True, filename=row.original_name,
            content_type='application/octet-stream',
        )
        response['Cache-Control'] = 'private, no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        return response

