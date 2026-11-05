"""Manage login devices for the signed-in account (across all organizations)."""
from django.contrib.sessions.models import Session
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .device_sessions import register_activity, revoke_other_sessions
from .models import AccountSession


def session_response(record, current=False):
    """Never return the bearer session key or any raw credential."""
    return {
        'id': str(record.pk),
        'user_agent': record.user_agent,
        'ip_address': record.ip_address,
        'created_at': record.created_at.isoformat(),
        'last_seen_at': record.last_seen_at.isoformat(),
        'current': current,
    }


class AccountSessionsView(APIView):
    def get(self, request):
        register_activity(request)
        current_key = request.session.session_key
        now = timezone.now()
        sessions = list(
            AccountSession.objects.filter(
                user=request.user, revoked_at__isnull=True,
            ).order_by('-last_seen_at')[:100]
        )
        keys = [item.session_key for item in sessions]
        valid = set(Session.objects.filter(
            session_key__in=keys, expire_date__gt=now,
        ).values_list('session_key', flat=True))
        return Response([
            session_response(item, current=item.session_key == current_key)
            for item in sessions if item.session_key in valid
        ])


class AccountSessionDetailView(APIView):
    def delete(self, request, session_id):
        current_key = request.session.session_key
        with transaction.atomic():
            record = get_object_or_404(
                AccountSession.objects.select_for_update(),
                pk=session_id, user=request.user, revoked_at__isnull=True,
            )
            if record.session_key == current_key:
                raise ValidationError({
                    'detail': 'Use the Log out button to end your current device session',
                })
            record.revoked_at = timezone.now()
            record.save(update_fields=['revoked_at'])
            Session.objects.filter(session_key=record.session_key).delete()
        return Response(status=204)


class SignOutOtherDevicesView(APIView):
    def post(self, request):
        revoke_other_sessions(request)
        return Response({'detail': 'Other sessions were signed out. This device remains signed in.'})
