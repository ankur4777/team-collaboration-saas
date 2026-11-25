"""Provider directory; membership role changes do not alter global user privileges."""
import hashlib
import logging
from urllib.parse import quote
from django.conf import settings
from django.core.mail import send_mail
from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from .models import Organization, OrganizationMember, Invitation
from .platform_admin import PlatformView, audit
from .seat_limits import seat_available, SEAT_LIMIT_MESSAGE
from .license_access import access_allowed

logger = logging.getLogger(__name__)


def member_data(row):
    return {'id':str(row.pk),'user_id':str(row.user_id),'company_id':str(row.organization_id),
            'company':row.organization.name,'full_name':row.user.full_name,'email':row.user.email,
            'role':row.role,'contact_phone':row.contact_phone,'editable':row.role!='owner' and not row.user.is_staff and not row.user.is_superuser,'active':row.user.is_active,'email_verified':bool(row.user.email_verified_at),
            'joined_at':row.joined_at.isoformat(),'last_seen_at':row.last_seen_at.isoformat() if row.last_seen_at else None}


class UserDirectoryView(PlatformView):
    def get(self,request):
        q=request.query_params.get('q','').strip()
        role=request.query_params.get('role','')
        try:
            page=int(request.query_params.get('page','1'))
            size=int(request.query_params.get('page_size','10'))
        except ValueError:
            raise ValidationError({'page':'Invalid pagination'})
        if len(q)>150 or role not in ('','owner','admin','member') or not 1<=page<=100000 or size not in (10,25,50,100):
            raise ValidationError({'detail':'Invalid directory filters'})
        rows=OrganizationMember.objects.select_related('organization','user')
        if q:
            rows=rows.filter(Q(organization__name__icontains=q)|Q(user__full_name__icontains=q)|Q(user__email__icontains=q))
        if role:
            rows=rows.filter(role=role)
        offset=(page-1)*size
        return Response({'items':[member_data(r) for r in rows.order_by('organization__name','user__full_name','pk')[offset:offset+size]],
                         'total':rows.count(),'page':page,'page_size':size})


class MembershipUpdateInput(serializers.Serializer):
    role=serializers.ChoiceField(choices=('member','admin'),required=False)
    contact_phone=serializers.RegexField(r'^\+[1-9][0-9]{3,14}
    @transaction.atomic
    def patch(self,request,member_id):
        form=MembershipUpdateInput(data=request.data,partial=True)
        form.is_valid(raise_exception=True)
        if not form.validated_data:
            raise ValidationError({'detail':'No membership changes supplied'})
        initial=get_object_or_404(OrganizationMember,pk=member_id)
        org=get_object_or_404(Organization.objects.select_for_update(),pk=initial.organization_id)
        row=get_object_or_404(OrganizationMember.objects.select_for_update().select_related('organization','user'),pk=member_id,organization=org)
        if row.role=='owner' or row.user.is_superuser or row.user.is_staff:
            raise ValidationError({'role':'Protected owner or platform account'})
        changes={}
        for key,value in form.validated_data.items():
            old=getattr(row,key)
            if old!=value:
                setattr(row,key,value)
                changes[key]={'from':old,'to':value}
        if changes:
            row.save(update_fields=list(changes))
            audit(org,request.user,'membership_updated',{'member_id':str(row.pk),**changes})
        return Response(member_data(row))


class InviteInput(serializers.Serializer):
    email=serializers.EmailField(max_length=254)
    role=serializers.ChoiceField(choices=('admin','member'),default='member')


class InviteUserView(PlatformView):
    def post(self,request,company_id):
        form=InviteInput(data=request.data)
        form.is_valid(raise_exception=True)
        email=form.validated_data['email'].lower()
        role=form.validated_data['role']
        with transaction.atomic():
            org=get_object_or_404(Organization.objects.select_for_update(),pk=company_id)
            if not access_allowed(org.pk):
                raise ValidationError({'detail':'Reactivate the company before inviting new employees'})
            if not org.members.filter(role='owner').exists():
                raise ValidationError({'detail':'The company owner must accept their invitation first'})
            if org.members.filter(user__email__iexact=email).exists():
                raise ValidationError({'email':'This person is already a member'})
            if not seat_available(org.pk):
                return Response({'detail':SEAT_LIMIT_MESSAGE},status=409)
            prior=list(Invitation.objects.select_for_update().filter(organization=org,email__iexact=email,accepted_at__isnull=True).exclude(role='owner'))
            Invitation.objects.filter(pk__in=[r.pk for r in prior]).update(expires_at=timezone.now())
            token=Invitation.generate_token()
            inv=Invitation.objects.create(organization=org,email=email,role=role,token_hash=hashlib.sha256(token.encode()).hexdigest(),invited_by=request.user)
            audit(org,request.user,'employee_invited',{'email':email,'role':role})
        try:
            delivered=bool(send_mail(subject=f'Invitation to join {org.name}',message=f'You have been invited to {org.name}. Accept within 7 days:\n{settings.FRONTEND_ORIGIN}/invite?token={quote(token,safe="")}',
                  from_email=settings.DEFAULT_FROM_EMAIL,recipient_list=[email],fail_silently=False))
        except Exception:
            logger.exception('Employee invitation delivery failed for company %s',org.pk)
            delivered=False
        return Response({'id':str(inv.pk),'invitation_sent':delivered},status=201)
,required=False,allow_blank=True,max_length=16)


class UserMembershipView(PlatformView):
    @transaction.atomic
    def patch(self,request,member_id):
        form=MembershipUpdateInput(data=request.data,partial=True)
        form.is_valid(raise_exception=True)
        if not form.validated_data:
            raise ValidationError({'detail':'No membership changes supplied'})
        initial=get_object_or_404(OrganizationMember,pk=member_id)
        org=get_object_or_404(Organization.objects.select_for_update(),pk=initial.organization_id)
        row=get_object_or_404(OrganizationMember.objects.select_for_update().select_related('organization','user'),pk=member_id,organization=org)
        if row.role=='owner' or row.user.is_superuser or row.user.is_staff:
            raise ValidationError({'role':'Protected owner or platform account'})
        changes={}
        for key,value in form.validated_data.items():
            old=getattr(row,key)
            if old!=value:
                setattr(row,key,value)
                changes[key]={'from':old,'to':value}
        if changes:
            row.save(update_fields=list(changes))
            audit(org,request.user,'membership_updated',{'member_id':str(row.pk),**changes})
        return Response(member_data(row))


class InviteInput(serializers.Serializer):
    email=serializers.EmailField(max_length=254)
    role=serializers.ChoiceField(choices=('admin','member'),default='member')


class InviteUserView(PlatformView):
    def post(self,request,company_id):
        form=InviteInput(data=request.data)
        form.is_valid(raise_exception=True)
        email=form.validated_data['email'].lower()
        role=form.validated_data['role']
        with transaction.atomic():
            org=get_object_or_404(Organization.objects.select_for_update(),pk=company_id)
            if not access_allowed(org.pk):
                raise ValidationError({'detail':'Reactivate the company before inviting new employees'})
            if not org.members.filter(role='owner').exists():
                raise ValidationError({'detail':'The company owner must accept their invitation first'})
            if org.members.filter(user__email__iexact=email).exists():
                raise ValidationError({'email':'This person is already a member'})
            if not seat_available(org.pk):
                return Response({'detail':SEAT_LIMIT_MESSAGE},status=409)
            prior=list(Invitation.objects.select_for_update().filter(organization=org,email__iexact=email,accepted_at__isnull=True).exclude(role='owner'))
            Invitation.objects.filter(pk__in=[r.pk for r in prior]).update(expires_at=timezone.now())
            token=Invitation.generate_token()
            inv=Invitation.objects.create(organization=org,email=email,role=role,token_hash=hashlib.sha256(token.encode()).hexdigest(),invited_by=request.user)
            audit(org,request.user,'employee_invited',{'email':email,'role':role})
        try:
            delivered=bool(send_mail(subject=f'Invitation to join {org.name}',message=f'You have been invited to {org.name}. Accept within 7 days:\n{settings.FRONTEND_ORIGIN}/invite?token={quote(token,safe="")}',
                  from_email=settings.DEFAULT_FROM_EMAIL,recipient_list=[email],fail_silently=False))
        except Exception:
            logger.exception('Employee invitation delivery failed for company %s',org.pk)
            delivered=False
        return Response({'id':str(inv.pk),'invitation_sent':delivered},status=201)
