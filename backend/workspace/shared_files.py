"""Private, tenant-scoped workspace Shared Files library."""
from django.db import transaction
from django.http import FileResponse
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import WorkspaceFile
from .permissions import get_active_membership
from .private_attachments import validate_upload


def file_row(row):
    return {
        'id': str(row.pk),
        'name': row.original_name,
        'size': row.size,
        'content_type': row.content_type,
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
        return Response({'results': [file_row(row) for row in rows[:100]], 'limit': 100})

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
        return Response(file_row(row), status=status.HTTP_201_CREATED)


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
