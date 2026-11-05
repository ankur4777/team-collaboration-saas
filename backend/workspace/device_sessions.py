"""Account-wide browser session registry and revocation helpers.

Authentication remains in Django's database-backed django_session table.
The registry stores opaque Django session keys server-side only; API responses
never reveal session keys. IP addresses come from REMOTE_ADDR, not user-supplied
forwarding headers. User-agent labels are informational and untrusted.
"""
from datetime import timedelta
from django.contrib.auth import logout
from django.contrib.sessions.models import Session
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from .models import AccountSession, User

GENERATION_KEY = '_teamworkspace_session_generation'
HEARTBEAT_INTERVAL = timedelta(minutes=2)


def register_activity(request):
    user = request.user
    key = request.session.session_key
    if not user.is_authenticated or not key:
        return
    now = timezone.now()
    record = AccountSession.objects.filter(session_key=key).first()
    if record:
        if record.revoked_at is not None or record.user_id != user.pk:
            logout(request)
            return
        if now - record.last_seen_at >= HEARTBEAT_INTERVAL:
            record.last_seen_at = now
            record.save(update_fields=['last_seen_at'])
        return
    agent = (request.META.get('HTTP_USER_AGENT') or '').strip()[:255]
    ip_address = request.META.get('REMOTE_ADDR')
    try:
        AccountSession.objects.get_or_create(
            session_key=key,
            defaults={'user': user, 'user_agent': agent, 'ip_address': ip_address},
        )
    except (ValueError, TypeError):
        # A malformed proxy IP must not block an otherwise valid login.
        AccountSession.objects.get_or_create(
            session_key=key, defaults={'user': user, 'user_agent': agent},
        )


def signed_out(request):
    key = request.session.session_key
    if key and request.user.is_authenticated:
        AccountSession.objects.filter(
            user=request.user, session_key=key, revoked_at__isnull=True,
        ).update(revoked_at=timezone.now())


def revoke_other_sessions(request):
    """Invalidate tracked sessions plus *all* pre-upgrade sessions by generation."""
    user = request.user
    key = request.session.session_key
    with transaction.atomic():
        User.objects.filter(pk=user.pk).update(session_generation=F('session_generation') + 1)
        user.refresh_from_db(fields=['session_generation'])
        request.session[GENERATION_KEY] = user.session_generation
        others = AccountSession.objects.filter(user=user, revoked_at__isnull=True)
        if key:
            others = others.exclude(session_key=key)
        other_keys = list(others.values_list('session_key', flat=True))
        others.update(revoked_at=timezone.now())
        if other_keys:
            Session.objects.filter(session_key__in=other_keys).delete()


def after_password_change(request):
    """Keep the new session from update_session_auth_hash; revoke tracked old keys."""
    key = request.session.session_key
    user = request.user
    others = AccountSession.objects.filter(user=user, revoked_at__isnull=True)
    if key:
        others = others.exclude(session_key=key)
    other_keys = list(others.values_list('session_key', flat=True))
    others.update(revoked_at=timezone.now())
    if other_keys:
        Session.objects.filter(session_key__in=other_keys).delete()


class SessionSecurityMiddleware:
    """Reject old-generation sessions before reaching APIs or workspace views.

    This middleware runs immediately after AuthenticationMiddleware.
    Sessions authenticated before this migration start at generation 0.
    An explicit 'sign out other devices' increments the user's generation,
    immediately invalidating even sessions without a registry entry.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.user.is_authenticated:
            expected = request.user.session_generation
            actual = request.session.get(GENERATION_KEY)
            if actual is None and expected == 0:
                request.session[GENERATION_KEY] = 0
            elif actual != expected:
                logout(request)
        response = self.get_response(request)
        if request.user.is_authenticated and request.session.session_key:
            request.session[GENERATION_KEY] = request.user.session_generation
            register_activity(request)
        return response


def live_websocket_session(user_id, session_key, generation):
    """Recheck session validity before publishing messages to a socket.

    The ASGI auth scope persists after handshake; revoked sessions must not
    continue receiving channel/chat events merely because membership remains.
    """
    if not session_key:
        return False
    if not Session.objects.filter(
        session_key=session_key, expire_date__gt=timezone.now(),
    ).exists():
        return False
    effective_generation = 0 if generation is None else generation
    return User.objects.filter(
        pk=user_id, is_active=True,
        session_generation=effective_generation,
    ).exists()
