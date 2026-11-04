import hashlib
import json
import logging
import secrets
from urllib.parse import quote
from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.mail import send_mail
from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.utils.text import slugify
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.http import require_http_methods
from .models import Invitation, Organization, OrganizationMember, User
from .ratelimit import login_throttled, record_login_failure

logger = logging.getLogger(__name__)


def json_body(request):
    try:
        data = json.loads(request.body)
        return data if isinstance(data, dict) else {}
    except (ValueError, UnicodeDecodeError):
        return {}


def bad(message, status=400):
    return JsonResponse({'detail': message}, status=status)


def set_active_org(request, user):
    membership = (OrganizationMember.objects.filter(user=user)
                  .order_by('joined_at').first())
    request.session['active_organization_id'] = str(membership.organization_id) if membership else None


def auth_payload(request):
    memberships = list(OrganizationMember.objects.filter(user=request.user).select_related('organization').order_by('joined_at'))
    return {
        'user': {'id': str(request.user.id), 'email': request.user.email, 'full_name': request.user.full_name,
                 'email_verified': request.user.email_verified_at is not None},
        'organizations': [{'id': str(m.organization_id), 'name': m.organization.name,
                           'slug': m.organization.slug, 'role': m.role} for m in memberships],
        'active_organization_id': request.session.get('active_organization_id'),
    }


@require_http_methods(['GET'])
@ensure_csrf_cookie
def csrf(request):
    return JsonResponse({'csrf_token': get_token(request)})


@require_http_methods(['POST'])
@csrf_protect
def register(request):
    if request.user.is_authenticated:
        return bad('Log out before creating another account', 409)
    data = json_body(request)
    email = str(data.get('email', '')).lower().strip()
    password = str(data.get('password', ''))
    full_name = str(data.get('full_name', '')).strip()
    organization_name = str(data.get('organization_name', '')).strip()
    if not email or len(email) > 254 or '@' not in email or not full_name or not organization_name:
        return bad('Email, full name and organization name are required')
    if len(full_name) > 150 or len(organization_name) > 140:
        return bad('Name is too long')
    proposed_user = User(email=email, full_name=full_name)
    try:
        validate_password(password, user=proposed_user)
    except ValidationError as exc:
        return bad(' '.join(exc.messages))
    if User.objects.filter(email__iexact=email).exists():
        return bad('Email is already registered', 409)
    try:
        with transaction.atomic():
            user = User.objects.create_user(email=email, password=password, full_name=full_name)
            slug = f'{slugify(organization_name)[:135] or "workspace"}-{secrets.token_hex(4)}'
            org = Organization.objects.create(name=organization_name, slug=slug, created_by=user)
            OrganizationMember.objects.create(organization=org, user=user, role=OrganizationMember.Role.OWNER)
    except IntegrityError:
        return bad('Could not create account; please try another email', 409)
    login(request, user, backend='django.contrib.auth.backends.ModelBackend')
    request.session['active_organization_id'] = str(org.id)
    from .account_recovery import send_verification_email
    send_verification_email(user)
    return JsonResponse(auth_payload(request), status=201)


@require_http_methods(['POST'])
@csrf_protect
def sign_in(request):
    data = json_body(request)
    email = str(data.get('email', '')).lower().strip()
    password = str(data.get('password', ''))
    if not email or not password:
        return bad('Enter email and password')
    blocked = login_throttled(request, email)
    if blocked:
        return blocked
    user = authenticate(request, username=email, password=password)
    if user is None:
        record_login_failure(request, email)
        return bad('Invalid email or password', 401)
    login(request, user)
    set_active_org(request, user)
    return JsonResponse(auth_payload(request))


@require_http_methods(['POST'])
@csrf_protect
def sign_out(request):
    logout(request)
    return JsonResponse({'detail': 'Signed out'})


@require_http_methods(['GET'])
def me(request):
    if not request.user.is_authenticated:
        return bad('Authentication required', 401)
    return JsonResponse(auth_payload(request))


def find_invitation(raw_token):
    if not raw_token or len(raw_token) > 180:
        return None
    hashed = hashlib.sha256(raw_token.encode()).hexdigest()
    return Invitation.objects.select_related('organization').filter(token_hash=hashed).first()


@require_http_methods(['GET'])
def invitation_preview(request, token):
    invite = find_invitation(token)
    if invite is None or not invite.is_valid:
        return bad('Invitation is invalid or expired', 404)
    return JsonResponse({'email': invite.email, 'organization_name': invite.organization.name, 'role': invite.role})


@require_http_methods(['POST'])
@csrf_protect
def invitation_accept(request, token):
    data = json_body(request)
    try:
        with transaction.atomic():
            invite = find_invitation(token)
            if not invite:
                return bad('Invitation is invalid', 404)
            invite = Invitation.objects.select_for_update().get(pk=invite.pk)
            if not invite.is_valid:
                return bad('Invitation has expired or been used', 410)
            if request.user.is_authenticated:
                user = request.user
                if user.email.lower() != invite.email.lower():
                    return bad('Sign in with the invited email account', 403)
            else:
                if User.objects.filter(email__iexact=invite.email).exists():
                    return bad('This email has an account. Sign in first, then accept the invitation.', 409)
                password = str(data.get('password', ''))
                full_name = str(data.get('full_name', '')).strip()
                if not full_name or len(full_name) > 150:
                    return bad('Full name is required')
                try:
                    validate_password(password, user=User(email=invite.email, full_name=full_name))
                except ValidationError as exc:
                    return bad(' '.join(exc.messages))
                user = User.objects.create_user(email=invite.email, password=password, full_name=full_name,
                                                email_verified_at=timezone.now())
            # A successfully redeemed email invitation proves mailbox ownership.
            if not user.email_verified_at:
                user.email_verified_at = timezone.now()
                user.save(update_fields=['email_verified_at'])
            OrganizationMember.objects.get_or_create(
                organization=invite.organization, user=user, defaults={'role': invite.role})
            invite.accepted_at = timezone.now()
            invite.save(update_fields=['accepted_at'])
    except IntegrityError:
        return bad('Could not accept invitation; sign in and try again', 409)
    if not request.user.is_authenticated:
        login(request, user, backend='django.contrib.auth.backends.ModelBackend')
    request.session['active_organization_id'] = str(invite.organization_id)
    return JsonResponse(auth_payload(request))
