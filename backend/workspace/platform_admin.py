"""Provider-only commercial administration. No tenant message/content access."""
from datetime import timedelta
import hashlib
import logging
import secrets
from urllib.parse import quote
from django.conf import settings
from django.core.mail import send_mail
from django.db import transaction
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.text import slugify
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from .models import CompanyLicense, Invitation, Organization, OrganizationMember, PlatformAuditEntry, SubscriptionRenewal

from .license_access import effective_status, expiry_summary, MODULES
from .seat_limits import seat_available, seat_usage, SEAT_LIMIT_MESSAGE

logger = logging.getLogger(__name__)
PAGE_SIZE = 25


class PlatformAdminPermission(BasePermission):
    def has_permission(self, request, view):
        user = request.user
        return bool(user.is_authenticated and user.is_active and user.is_staff and user.is_superuser)


class PlatformView(APIView):
    permission_classes = [IsAuthenticated, PlatformAdminPermission]

    def finalize_response(self, request, response, *args, **kwargs):
        result = super().finalize_response(request, response, *args, **kwargs)
        result['Cache-Control'] = 'private, no-store'
        return result


class LicenseInput(serializers.Serializer):
    contact_email = serializers.EmailField(required=False, allow_blank=True, max_length=254)
    country = serializers.CharField(required=False, allow_blank=True, max_length=80)
    country_code = serializers.RegexField(r'^\+[1-9][0-9]{0,2}$', required=False, allow_blank=True, max_length=5)
    phone = serializers.RegexField(r'^[0-9]{4,15}$', required=False, allow_blank=True, max_length=15)
    website = serializers.URLField(required=False, allow_blank=True, max_length=250)
    tax_number = serializers.CharField(required=False, allow_blank=True, max_length=60)
    address = serializers.CharField(required=False, allow_blank=True, max_length=500)
    plan = serializers.CharField(required=False, allow_blank=True, max_length=80)
    status = serializers.ChoiceField(choices=CompanyLicense.Status.choices, required=False)
    seat_limit = serializers.IntegerField(required=False, allow_null=True, min_value=1, max_value=1000000)
    starts_on = serializers.DateField(required=False, allow_null=True)
    ends_on = serializers.DateField(required=False, allow_null=True)
    enforce_modules = serializers.BooleanField(required=False)
    modules = serializers.ListField(child=serializers.ChoiceField(choices=MODULES), required=False, max_length=len(MODULES))

    def validate_modules(self, value):
        if len(set(value)) != len(value):
            raise serializers.ValidationError('Duplicate modules are not allowed')
        return value

    def validate(self, data):
        instance = self.instance
        code = data.get('country_code', instance.country_code if instance else '')
        phone = data.get('phone', instance.phone if instance else '')
        if phone and (not code or len(code)-1+len(phone)>15):
            raise serializers.ValidationError({'phone':'Enter a dialing code and a number of at most 15 digits combined'})
        if code and not phone:
            raise serializers.ValidationError({'phone':'Enter the phone number or clear the dialing code'})
        start = data.get('starts_on', instance.starts_on if instance else None)
        end = data.get('ends_on', instance.ends_on if instance else None)
        if start and end and end < start:
            raise serializers.ValidationError({'ends_on': 'End date must be on or after start date'})
        return data


class CompanyUpdateInput(LicenseInput):
    name = serializers.CharField(max_length=140, required=False)


class CompanyInput(LicenseInput):
    name = serializers.CharField(max_length=140)
    owner_email = serializers.EmailField(max_length=254)


def license_data(row):
    return LicenseInput(row).data


def companies():
    return Organization.objects.select_related('license').annotate(
        employee_count=Count('members', distinct=True),
        team_count=Count('teams', distinct=True),
    )


def company_data(org):
    license_row = getattr(org, 'license', None) or CompanyLicense(organization=org)
    data = license_data(license_row)
    owner_rows = list(org.members.filter(role=OrganizationMember.Role.OWNER).values('user__email','user__full_name'))
    owners = [r['user__email'] for r in owner_rows]
    pending = org.invitations.filter(role=OrganizationMember.Role.OWNER, accepted_at__isnull=True, expires_at__gt=timezone.now()).order_by('-created_at').first()
    effective = effective_status(license_row)
    return {
        'id': str(org.pk), 'name': org.name, 'slug': org.slug,
        'created_at': org.created_at.isoformat(), 'employee_count': org.employee_count,
        'team_count': org.team_count, 'owner_emails': owners, 'owner_names': [r['user__full_name'] for r in owner_rows],
        'pending_owner_email': pending.email if pending else None,
        'effective_status': effective, **data, **expiry_summary(license_row),
        'seats_remaining': None if license_row.seat_limit is None else max(0, license_row.seat_limit-org.employee_count),
    }


def audit(org, actor, action, changes):
    PlatformAuditEntry.objects.create(organization=org, actor=actor, action=action, changes=changes)


def invite_owner(org, actor, email):
    if not seat_available(org.pk):
        raise ValidationError({'owner_email': SEAT_LIMIT_MESSAGE})
    # Lock prior pending invites so a resend cannot race an acceptance.
    prior = list(Invitation.objects.select_for_update().filter(organization=org, role=OrganizationMember.Role.OWNER, accepted_at__isnull=True).order_by('pk'))
    if org.members.filter(role=OrganizationMember.Role.OWNER).exists():
        raise ValidationError({'owner_email': 'This company already has an owner'})
    Invitation.objects.filter(pk__in=[row.pk for row in prior]).update(expires_at=timezone.now())
    token = Invitation.generate_token()
    Invitation.objects.create(organization=org, invited_by=actor, role=OrganizationMember.Role.OWNER,
                              email=email, token_hash=hashlib.sha256(token.encode()).hexdigest())
    return token


def deliver_owner_invite(org, email, token):
    try:
        count = send_mail(
            subject='Set up your TeamWorkspace company',
            message=f'You have been invited to manage {org.name} as its company owner.\n\n'
                    f'Accept this private invitation within 7 days:\n{settings.FRONTEND_ORIGIN}/invite?token={quote(token, safe="")}\n\n'
                    'If you already have a TeamWorkspace account, sign in with the invited email first.',
            from_email=settings.DEFAULT_FROM_EMAIL, recipient_list=[email], fail_silently=False,
        )
        return bool(count)
    except Exception:
        logger.exception('Company owner invitation delivery failed for company %s', org.pk)
        return False


class CompanyListView(PlatformView):
    def get(self, request):
        q = request.query_params.get('q','').strip()
        status = request.query_params.get('status','')
        try:
            page = int(request.query_params.get('page','1'))
            page_size = int(request.query_params.get('page_size', PAGE_SIZE))
        except ValueError:
            raise ValidationError({'page':'Invalid page'})
        if page_size not in (10,25,50,100) or not 1 <= page <= 100000 or len(q) > 140 or status not in ('', *CompanyLicense.Status.values, 'expired', 'scheduled'):
            raise ValidationError({'detail':'Invalid company filters'})
        rows = companies()
        if q:
            rows = rows.filter(Q(name__icontains=q) | Q(license__contact_email__icontains=q) | Q(license__phone__icontains=q) | Q(license__tax_number__icontains=q) | Q(pk__in=OrganizationMember.objects.filter(Q(user__email__icontains=q)|Q(user__full_name__icontains=q),role='owner').values('organization_id')))
        today = timezone.localdate()
        current = Q(license__status__in=['active','trial'])
        expired = current & Q(license__ends_on__lt=today)
        scheduled = current & Q(license__starts_on__gt=today) & (Q(license__ends_on__isnull=True) | Q(license__ends_on__gte=today))
        if status == 'expired':
            rows = rows.filter(expired)
        elif status == 'scheduled':
            rows = rows.filter(scheduled)
        elif status == 'unassigned':
            rows = rows.filter(Q(license__isnull=True) | Q(license__status='unassigned'))
        elif status:
            rows = rows.filter(license__status=status)
            if status in ('active','trial'):
                rows = rows.exclude(expired | scheduled)
        total = rows.count()
        sort = request.query_params.get('sort','newest')
        ordering = {'newest':('-created_at','-pk'),'name':('name','pk'),'name_desc':('-name','pk'),'expiry':('license__ends_on','pk')}
        if sort not in ordering:
            raise ValidationError({'sort':'Invalid sort order'})
        offset = (page-1)*page_size
        all_rows = Organization.objects.all()
        stats = {
            'companies': all_rows.count(),
            'active': all_rows.filter(license__status='active').exclude(expired | scheduled).count(),
            'trial': all_rows.filter(license__status='trial').exclude(expired | scheduled).count(),
            'expired': all_rows.filter(expired).count(),
            'suspended': all_rows.filter(license__status='suspended').count(),
            'memberships': OrganizationMember.objects.count(),
        }
        return Response({'items':[company_data(org) for org in rows.order_by(*ordering[sort])[offset:offset+page_size]],
                         'total':total,'page':page,'page_size':page_size,'stats':stats})

    def post(self, request):
        serializer = CompanyInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        name = data.pop('name')
        email = data.pop('owner_email').lower()
        data.setdefault('contact_email',email)
        with transaction.atomic():
            org = Organization.objects.create(name=name, slug=f'{slugify(name)[:135] or "workspace"}-{secrets.token_hex(4)}', created_by=request.user)
            row = CompanyLicense.objects.create(organization=org, **data)
            token = invite_owner(org, request.user, email)
            audit(org,request.user,'company_created',license_data(row))
        delivered = deliver_owner_invite(org,email,token)
        return Response({'company':company_data(companies().get(pk=org.pk)), 'invitation_sent':delivered},status=201)


class CompanyDetailView(PlatformView):
    def get(self, request, company_id):
        org = get_object_or_404(companies(),pk=company_id)
        events = [{'action':row.action,'actor':row.actor.email,'created_at':row.created_at.isoformat(),'changes':row.changes}
                  for row in org.platform_audit_entries.select_related('actor')[:30]]
        return Response({'company':company_data(org),'audit':events})

    @transaction.atomic
    def patch(self, request, company_id):
        org = get_object_or_404(Organization.objects.select_for_update(),pk=company_id)
        row,_ = CompanyLicense.objects.get_or_create(organization=org)
        serializer = CompanyUpdateInput(row,data=request.data,partial=True)
        serializer.is_valid(raise_exception=True)
        old = license_data(row)
        new_limit = serializer.validated_data.get('seat_limit', row.seat_limit)
        if new_limit is not None and new_limit != row.seat_limit:
            used = seat_usage(org.pk, locked=True)['seats_used']
            if new_limit < used:
                raise ValidationError({'seat_limit': f'Cannot allocate fewer than {used} existing memberships. Remove members first.'})
        name = serializer.validated_data.get('name',org.name)
        old_name = org.name
        if name != old_name:
            org.name = name
            org.save(update_fields=['name'])
        for key,value in serializer.validated_data.items():
            if key != 'name':
                setattr(row,key,value)
        row.save()
        new = license_data(row)
        changes = {key:{'from':old[key],'to':new[key]} for key in new if old[key]!=new[key]}
        if name != old_name:
            changes['name'] = {'from':old_name,'to':name}
        if changes:
            audit(org,request.user,'license_updated',changes)
        return Response(company_data(companies().get(pk=org.pk)))


class OwnerInviteView(PlatformView):
    def post(self, request, company_id):
        field = serializers.EmailField(max_length=254)
        email = field.run_validation(request.data.get('email')).lower()
        with transaction.atomic():
            org = get_object_or_404(Organization.objects.select_for_update(),pk=company_id)
            token = invite_owner(org,request.user,email)
            audit(org,request.user,'owner_invited',{'email':email})
        return Response({'invitation_sent':deliver_owner_invite(org,email,token)})


class RenewalInput(serializers.Serializer):
    request_id = serializers.UUIDField()
    days = serializers.IntegerField(min_value=1, max_value=3650)
    reactivate = serializers.BooleanField(default=False)
    note = serializers.CharField(max_length=500, required=False, allow_blank=True, default='')


def renewal_data(row):
    return {
        'id': str(row.pk), 'days': row.days,
        'previous_start': row.previous_start.isoformat() if row.previous_start else None,
        'previous_end': row.previous_end.isoformat() if row.previous_end else None,
        'previous_status': row.previous_status,
        'new_start': row.new_start.isoformat(), 'new_end': row.new_end.isoformat(),
        'new_status': row.new_status, 'reactivate': row.reactivate, 'note': row.note,
        'actor': row.actor.email, 'created_at': row.created_at.isoformat(),
    }


class CompanyRenewalView(PlatformView):
    def get(self, request, company_id):
        org = get_object_or_404(Organization, pk=company_id)
        try:
            page = int(request.query_params.get('page', '1'))
        except (ValueError, TypeError):
            raise ValidationError({'page': 'Invalid page'})
        if not 1 <= page <= 100000:
            raise ValidationError({'page': 'Invalid page'})
        rows = org.subscription_renewals.select_related('actor')
        offset = (page-1)*PAGE_SIZE
        return Response({'items': [renewal_data(row) for row in rows[offset:offset+PAGE_SIZE]],
                         'total': rows.count(), 'page': page, 'page_size': PAGE_SIZE})

    @transaction.atomic
    def post(self, request, company_id):
        serializer = RenewalInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        org = get_object_or_404(Organization.objects.select_for_update(), pk=company_id)
        prior = SubscriptionRenewal.objects.select_related('actor').filter(
            organization=org, request_id=data['request_id']).first()
        if prior:
            if (prior.days != data['days'] or prior.reactivate != data['reactivate'] or prior.note != data['note']):
                raise ValidationError({'request_id': 'This renewal request has already been used with different details'})
            return Response({'company': company_data(companies().get(pk=org.pk)),
                             'renewal': renewal_data(prior), 'replayed': True})
        row, _ = CompanyLicense.objects.get_or_create(organization=org)
        today = timezone.localdate()
        previous = license_data(row)
        try:
            if row.ends_on and row.ends_on >= today:
                # Keep the remaining paid period and add exactly N days.
                start = row.starts_on or today
                end = row.ends_on + timedelta(days=data['days'])
            else:
                # Lapsed or undated licenses receive a fresh term.
                start = max(today, row.starts_on or today)
                end = start + timedelta(days=data['days']-1)
        except OverflowError:
            raise ValidationError({'days': 'Renewal end date is out of range'})
        if end < start:
            raise ValidationError({'days': 'Renewal end date precedes the start date'})
        status = row.status
        if status not in ('suspended', 'cancelled') or data['reactivate']:
            status = 'active'
        record = SubscriptionRenewal.objects.create(
            organization=org, actor=request.user, request_id=data['request_id'],
            days=data['days'], previous_start=row.starts_on, previous_end=row.ends_on,
            previous_status=row.status, new_start=start, new_end=end,
            new_status=status, reactivate=data['reactivate'], note=data['note'],
        )
        row.starts_on, row.ends_on, row.status = start, end, status
        row.save(update_fields=['starts_on','ends_on','status','updated_at'])
        updated = license_data(row)
        audit(org, request.user, 'subscription_renewed', {
            'renewal_id': str(record.pk), 'days': data['days'],
            'starts_on': {'from': previous['starts_on'], 'to': updated['starts_on']},
            'ends_on': {'from': previous['ends_on'], 'to': updated['ends_on']},
            'status': {'from': previous['status'], 'to': updated['status']},
        })
        return Response({'company': company_data(companies().get(pk=org.pk)),
                         'renewal': renewal_data(record), 'replayed': False}, status=201)
