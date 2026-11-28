"""Explicit customer support conversations; accessible even when a license is blocked."""
from django.db import transaction
from django.db.models import Count, Q, Case, When, Value, IntegerField
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated
from .models import OrganizationMember, SupportTicket, SupportReply
from .platform_admin import PlatformView, audit, PAGE_SIZE

STATUSES=('open','in_progress','resolved','closed')


def member(request):
    row=OrganizationMember.objects.filter(user=request.user,organization_id=request.session.get('active_organization_id')).first()
    if not row:
        raise PermissionDenied('Choose a company you belong to')
    return row


def customer_rows(request):
    membership=member(request)
    rows=SupportTicket.objects.filter(organization_id=membership.organization_id)
    if membership.role != 'admin':
        rows=rows.filter(requester=request.user)
    return rows


def ticket_data(row):
    return {'id':str(row.pk),'company_id':str(row.organization_id),'company':row.organization.name,
            'subject':row.subject,'priority':row.priority,'status':row.status,
            'requester':row.requester.email,'created_at':row.created_at.isoformat(),'updated_at':row.updated_at.isoformat()}


def detail(row):
    return {**ticket_data(row),'replies':[{'id':str(r.pk),'author': 'TeamWorkspace Support' if r.from_provider else r.author.full_name,
        'from_provider':r.from_provider,'body':r.body,'created_at':r.created_at.isoformat()} for r in row.replies.select_related('author').all()]}


def listing(request,rows):
    status=request.query_params.get('status','')
    if status and status not in STATUSES:
        raise ValidationError({'status':'Invalid status'})
    try:
        page=int(request.query_params.get('page','1'))
    except ValueError:
        raise ValidationError({'page':'Invalid page'})
    if not 1<=page<=100000:
        raise ValidationError({'page':'Invalid page'})
    q=request.query_params.get('q','').strip()
    priority=request.query_params.get('priority','')
    sort=request.query_params.get('sort','updated')
    if len(q)>160 or priority not in ('','normal','high') or sort not in ('updated','oldest','priority'):
        raise ValidationError({'detail':'Invalid ticket filters'})
    counts=rows.aggregate(all=Count('pk'),open=Count('pk',filter=Q(status='open')),
        in_progress=Count('pk',filter=Q(status='in_progress')),
        resolved=Count('pk',filter=Q(status='resolved')),closed=Count('pk',filter=Q(status='closed')),
        high_pending=Count('pk',filter=Q(priority='high',status__in=('open','in_progress'))))
    if status:
        rows=rows.filter(status=status)
    if priority:
        rows=rows.filter(priority=priority)
    if q:
        rows=rows.filter(Q(subject__icontains=q)|Q(organization__name__icontains=q)|Q(requester__email__icontains=q))
    if sort=='oldest':
        rows=rows.order_by('created_at','pk')
    elif sort=='priority':
        rows=rows.order_by(Case(When(status__in=('open','in_progress'),then=Value(0)),default=Value(1),output_field=IntegerField()),
                           Case(When(priority='high',then=Value(0)),default=Value(1),output_field=IntegerField()),'created_at','pk')
    else:
        rows=rows.order_by('-updated_at','-pk')
    offset=(page-1)*PAGE_SIZE
    return Response({'items':[ticket_data(r) for r in rows.select_related('organization','requester')[offset:offset+PAGE_SIZE]],
                     'total':rows.count(),'page':page,'page_size':PAGE_SIZE,'counts':counts})


class NewTicket(serializers.Serializer):
    subject=serializers.CharField(max_length=160)
    priority=serializers.ChoiceField(choices=('normal','high'),default='normal')
    body=serializers.CharField(max_length=4000)


class ReplyInput(serializers.Serializer):
    body=serializers.CharField(max_length=4000,required=False)
    status=serializers.ChoiceField(choices=STATUSES,required=False)


class ProviderReplyInput(ReplyInput):
    priority=serializers.ChoiceField(choices=('normal','high'),required=False)


class CustomerTicketsView(APIView):
    permission_classes=[IsAuthenticated]

    def get(self,request):
        return listing(request,customer_rows(request))

    @transaction.atomic
    def post(self,request):
        membership=member(request)
        form=NewTicket(data=request.data)
        form.is_valid(raise_exception=True)
        data=dict(form.validated_data)
        body=data.pop('body')
        row=SupportTicket.objects.create(organization_id=membership.organization_id,requester=request.user,**data)
        SupportReply.objects.create(ticket=row,author=request.user,body=body)
        return Response(detail(row),status=201)


class CustomerTicketView(APIView):
    permission_classes=[IsAuthenticated]

    def get(self,request,ticket_id):
        return Response(detail(get_object_or_404(customer_rows(request),pk=ticket_id)))

    @transaction.atomic
    def post(self,request,ticket_id):
        row=get_object_or_404(customer_rows(request).select_for_update(),pk=ticket_id)
        form=ReplyInput(data=request.data)
        form.is_valid(raise_exception=True)
        if not form.validated_data.get('body') or 'status' in form.validated_data or 'priority' in request.data:
            raise ValidationError({'body':'Provide a reply; status is managed by support'})
        if row.status=='closed':
            raise ValidationError({'detail':'This ticket is closed. Create a new ticket.'})
        SupportReply.objects.create(ticket=row,author=request.user,body=form.validated_data['body'])
        if row.status=='resolved':
            row.status='open'
        row.save(update_fields=['status','updated_at'])
        return Response(detail(row))


class PlatformTicketsView(PlatformView):
    def get(self,request):
        rows=SupportTicket.objects.all()
        company=request.query_params.get('company')
        if company:
            company_id=serializers.UUIDField().run_validation(company)
            rows=rows.filter(organization_id=company_id)
        return listing(request,rows)


class PlatformTicketView(PlatformView):
    def get(self,request,ticket_id):
        return Response(detail(get_object_or_404(SupportTicket,pk=ticket_id)))

    @transaction.atomic
    def post(self,request,ticket_id):
        row=get_object_or_404(SupportTicket.objects.select_for_update(),pk=ticket_id)
        form=ProviderReplyInput(data=request.data)
        form.is_valid(raise_exception=True)
        data=form.validated_data
        if not data:
            raise ValidationError({'detail':'Provide a reply, status or priority'})
        previous=row.status
        previous_priority=row.priority
        if 'body' in data:
            SupportReply.objects.create(ticket=row,author=request.user,from_provider=True,body=data['body'])
        if 'status' in data:
            row.status=data['status']
        if 'priority' in data:
            row.priority=data['priority']
        row.save(update_fields=['status','priority','updated_at'])
        audit(row.organization,request.user,'support_updated',{'ticket':str(row.pk),'from':previous,'to':row.status,'priority_from':previous_priority,'priority_to':row.priority,'reply_added':'body' in data})
        return Response(detail(row))
