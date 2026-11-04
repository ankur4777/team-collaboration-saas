"""Email confirmation and password recovery.

Security properties:
- HTTPS deployment required; links use the configured FRONTEND_ORIGIN.
- No plaintext reset token is stored in the database.
- Email confirmation tokens are signed, expire in 24 hours and are single-use.
- Django password reset tokens expire after PASSWORD_RESET_TIMEOUT and become
  invalid after a password change (including existing login sessions).
- Public reset requests do not reveal whether the email has an account.
- CSRF protection and best-effort per-IP/email request throttling are applied.
"""
import hashlib
import logging
from urllib.parse import quote

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.tokens import default_token_generator
from django.core import signing
from django.core.cache import cache
from django.core.exceptions import ValidationError as PasswordValidationError
from django.core.mail import send_mail
from django.db import transaction
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.utils.encoding import force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from django.utils.encoding import force_bytes
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from .auth_views import bad, json_body


logger = logging.getLogger(__name__)
User = get_user_model()
VERIFY_SALT = 'teamworkspace.email-verification.v1'
VERIFY_TTL = 24 * 60 * 60
GENERIC_RESET = 'If an account exists for this email, password reset instructions have been sent.'


def safe_send_mail(subject, message, recipient):
    try:
        send_mail(
            subject=subject,
            message=message,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[recipient],
            fail_silently=False,
        )
    except Exception:
        # Do not expose details or token in an API error.
        logger.exception('Could not send a TeamWorkspace account email')


def verification_link(user):
    token = signing.dumps(
        {'uid': str(user.pk), 'email': user.email},
        salt=VERIFY_SALT,
    )
    return f'{settings.FRONTEND_ORIGIN}/verify-email?token={quote(token, safe="")}'


def send_verification_email(user):
    if user.email_verified_at:
        return
    safe_send_mail(
        'Verify your TeamWorkspace email address',
        'Verify your email to secure your workspace account.\n\n'
        f'Open this link within 24 hours:\n{verification_link(user)}\n\n'
        'If you did not create an account, you can ignore this message.',
        user.email,
    )


def attempt_allowed(request, kind, key, limit, seconds):
    """Per-client and email throttling with hashed identifiers.

    Defaults to Django cache (local memory in development). Configure a shared
    Redis cache behind a trusted reverse proxy for production-wide limits.
    """
    ip = request.META.get('REMOTE_ADDR') or 'unknown'
    digest = hashlib.sha256(f'{kind}:{ip}:{key.strip().lower()}'.encode()).hexdigest()
    cache_key = f'auth-email-rate:{digest}'
    if cache.add(cache_key, 1, timeout=seconds):
        return True
    try:
        return cache.incr(cache_key) <= limit
    except ValueError:
        cache.set(cache_key, 1, timeout=seconds)
        return True


@require_http_methods(['POST'])
@csrf_protect
def resend_verification(request):
    if not request.user.is_authenticated:
        return bad('Sign in first to resend a verification link', 401)
    if request.user.email_verified_at:
        return JsonResponse({'detail': 'This email address is already verified'})
    if not attempt_allowed(request, 'verify-email', str(request.user.pk), 3, 900):
        return bad('Too many requests. Try again later.', 429)
    send_verification_email(request.user)
    return JsonResponse({'detail': 'Verification instructions have been sent'})


@require_http_methods(['POST'])
@csrf_protect
def verify_email(request):
    data = json_body(request)
    token = data.get('token')
    if not isinstance(token, str) or not token or len(token) > 1024:
        return bad('Invalid or expired verification link', 400)
    try:
        payload = signing.loads(token, salt=VERIFY_SALT, max_age=VERIFY_TTL)
    except (signing.BadSignature, signing.SignatureExpired, ValueError, TypeError):
        return bad('Invalid or expired verification link', 400)
    if not isinstance(payload, dict):
        return bad('Invalid or expired verification link', 400)
    if not (isinstance(payload.get('uid'), str) and isinstance(payload.get('email'), str)):
        return bad('Invalid or expired verification link', 400)
    try:
        with transaction.atomic():
            user = User.objects.select_for_update().filter(
                pk=payload['uid'], email=payload['email'],
            ).first()
            if not user or not user.is_active or user.email_verified_at:
                return bad('Verification link has expired or has already been used', 400)
            user.email_verified_at = timezone.now()
            user.save(update_fields=['email_verified_at'])
    except (ValueError, TypeError, PasswordValidationError):
        return bad('Invalid or expired verification link', 400)
    return JsonResponse({'detail': 'Your email is verified. You can now sign in.'})


@require_http_methods(['POST'])
@csrf_protect
def password_reset_request(request):
    data = json_body(request)
    email = data.get('email')
    if not isinstance(email, str) or len(email) > 254:
        return bad('Enter a valid email address')
    email = email.lower().strip()
    if not email or '@' not in email:
        return bad('Enter a valid email address')
    # Limit by both IP and email. The response text is deliberately generic.
    ip_ok = attempt_allowed(request, 'reset-ip', '', 12, 900)
    email_ok = attempt_allowed(request, 'reset-address', email, 3, 900)
    if not ip_ok or not email_ok:
        return bad('Too many requests. Try again later.', 429)

    user = User.objects.filter(email__iexact=email, is_active=True).first()
    if user and user.has_usable_password():
        uid = urlsafe_base64_encode(force_bytes(user.pk))
        token = default_token_generator.make_token(user)
        url = f'{settings.FRONTEND_ORIGIN}/reset-password?uid={quote(uid)}&token={quote(token)}'
        safe_send_mail(
            'Reset your TeamWorkspace password',
            'We received a request to reset your TeamWorkspace password.\n\n'
            f'Open this link to choose a new password:\n{url}\n\n'
            'The link expires automatically. If you did not request this, ignore this email.',
            user.email,
        )
    return JsonResponse({'detail': GENERIC_RESET})


@require_http_methods(['POST'])
@csrf_protect
def password_reset_confirm(request):
    data = json_body(request)
    uid = data.get('uid')
    token = data.get('token')
    password = data.get('password')
    if not all(isinstance(x, str) for x in (uid, token, password)):
        return bad('Invalid or expired password reset link')
    if not 1 <= len(uid) <= 200 or not 1 <= len(token) <= 200:
        return bad('Invalid or expired password reset link')
    try:
        user_id = force_str(urlsafe_base64_decode(uid))
        with transaction.atomic():
            # Recheck token while holding the row lock. Two requests cannot
            # both consume the same recovery token concurrently.
            user = User.objects.select_for_update().filter(
                pk=user_id, is_active=True,
            ).first()
            if user is None or not default_token_generator.check_token(user, token):
                return bad('Invalid or expired password reset link')
            try:
                validate_password(password, user=user)
            except PasswordValidationError as exc:
                return bad(' '.join(exc.messages))
            user.set_password(password)
            user.save(update_fields=['password'])
    except (ValueError, TypeError, UnicodeDecodeError, OverflowError):
        return bad('Invalid or expired password reset link')
    return JsonResponse({'detail': 'Password updated. Sign in using your new password.'})
