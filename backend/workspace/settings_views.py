"""Authenticated account-security and tenant-scoped notification settings."""
from django.contrib.auth import update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as PasswordValidationError
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods
from django.db import transaction
from django.http import JsonResponse
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .auth_views import bad, json_body
from .models import NotificationPreference
from .permissions import get_active_membership


PREFERENCE_FIELDS = ('direct_chats', 'group_chats', 'team_channels')
DEFAULTS = {field: True for field in PREFERENCE_FIELDS}


class NotificationPreferencesView(APIView):
    """Only the signed-in user may read or change their active company's settings."""

    def get(self, request):
        membership = get_active_membership(request)
        record = NotificationPreference.objects.filter(
            organization_id=membership.organization_id, user=request.user,
        ).first()
        values = {field: getattr(record, field) if record else True
                  for field in PREFERENCE_FIELDS}
        return Response(values)

    def patch(self, request):
        membership = get_active_membership(request)
        payload = request.data
        if not isinstance(payload, dict) or not payload or any(
            key not in PREFERENCE_FIELDS or type(value) is not bool
            for key, value in payload.items()
        ):
            raise ValidationError({
                'detail': 'Only direct_chats, group_chats, team_channels boolean values are allowed',
            })
        with transaction.atomic():
            record, _ = NotificationPreference.objects.get_or_create(
                organization_id=membership.organization_id,
                user=request.user,
                defaults=DEFAULTS,
            )
            record = NotificationPreference.objects.select_for_update().get(pk=record.pk)
            for key, value in payload.items():
                setattr(record, key, value)
            record.save(update_fields=[*payload.keys(), 'updated_at'])
            values = {field: getattr(record, field) for field in PREFERENCE_FIELDS}
        return Response(values)


@require_http_methods(['POST'])
@csrf_protect
def change_password(request):
    """Keep the current browser signed in, invalidate other old-hash sessions."""
    if not request.user.is_authenticated:
        return bad('Authentication required', 401)

    data = json_body(request)
    current = data.get('current_password')
    new = data.get('new_password')
    if not isinstance(current, str) or not isinstance(new, str):
        return bad('Current password and new password are required')
    if not request.user.check_password(current):
        return bad('Current password is incorrect', 400)
    if current == new:
        return bad('Choose a new password different from your current password')
    try:
        validate_password(new, user=request.user)
    except PasswordValidationError as exc:
        return bad(' '.join(exc.messages))
    request.user.set_password(new)
    request.user.save(update_fields=['password'])
    update_session_auth_hash(request, request.user)
    return JsonResponse({'detail': 'Password changed. Other sessions must sign in again.'})
