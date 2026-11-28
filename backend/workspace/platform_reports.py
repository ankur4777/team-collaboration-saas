"""Aggregate provider reports. No message bodies, filenames or mailbox contents."""
from datetime import timedelta
from decimal import Decimal
from django.db.models import Sum, Count, Q
from django.db.models.functions import TruncMonth
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers
from rest_framework.response import Response
from .platform_admin import PlatformView, companies, company_data
from .models import (Organization, OrganizationMember, Team, Channel, Message, ChatConversation,
                     ChatMessage, Meeting, WorkspaceFile, PrivateAttachment, BillingInvoice, SupportTicket)


class PlatformOverviewView(PlatformView):
    """Operational summary using aggregate tenant metadata only."""
    def get(self, request):
        now = timezone.now()
        today = timezone.localdate(now)
        horizon = today + timedelta(days=30)
        rows = Organization.objects.all()
        current = Q(license__status__in=['active', 'trial'])
        expired = current & Q(license__ends_on__lt=today)
        scheduled = current & Q(license__starts_on__gt=today) & (
            Q(license__ends_on__isnull=True) | Q(license__ends_on__gte=today))
        active = Q(license__status='active') & ~expired & ~scheduled
        trial = Q(license__status='trial') & ~expired & ~scheduled
        expiring = (active | trial) & Q(license__ends_on__range=(today, horizon))
        counts = rows.aggregate(
            companies=Count('pk'), active=Count('pk', filter=active),
            trial=Count('pk', filter=trial), expired=Count('pk', filter=expired),
            scheduled=Count('pk', filter=scheduled),
            suspended=Count('pk', filter=Q(license__status='suspended')),
            cancelled=Count('pk', filter=Q(license__status='cancelled')),
            unassigned=Count('pk', filter=Q(license__isnull=True) | Q(license__status='unassigned')),
            expiring=Count('pk', filter=expiring),
        )
        counts['memberships'] = OrganizationMember.objects.count()
        counts['online_memberships'] = OrganizationMember.objects.filter(
            user__is_active=True, last_seen_at__gte=now-timedelta(seconds=90)).count()
        counts['pending_tickets'] = SupportTicket.objects.filter(status__in=['open','in_progress']).count()
        return Response({
            'as_of': now.isoformat(), 'today': today.isoformat(), 'renewal_window_days': 30,
            'stats': counts,
            'recent_companies': [company_data(org) for org in companies().order_by('-created_at','-pk')[:5]],
            'upcoming_renewals': [
                {'id': str(row.pk), 'name': row.name, 'ends_on': row.license.ends_on.isoformat(),
                 'days_remaining': (row.license.ends_on-today).days}
                for row in rows.filter(expiring).select_related('license').order_by('license__ends_on','pk')[:5]
            ],
        })


class CompanyUsageView(PlatformView):
    def get(self, request, company_id):
        org = get_object_or_404(Organization, pk=company_id)
        now = timezone.now()
        cutoff = now - timedelta(days=30)
        members = OrganizationMember.objects.filter(organization=org)
        channels = Message.objects.filter(channel__team__organization=org, deleted_at__isnull=True)
        chats = ChatMessage.objects.filter(conversation__organization=org, deleted_at__isnull=True)
        files = WorkspaceFile.objects.filter(organization=org)
        attachments = PrivateAttachment.objects.filter(organization=org)
        meetings = Meeting.objects.filter(organization=org)
        return Response({
            'company_id': str(org.pk), 'as_of': now.isoformat(), 'window_days': 30,
            'members': members.count(),
            'recent_members': members.filter(last_seen_at__gte=cutoff).count(),
            'online_members': members.filter(last_seen_at__gte=now-timedelta(seconds=90)).count(),
            'teams': Team.objects.filter(organization=org).count(),
            'channels': Channel.objects.filter(team__organization=org).count(),
            'conversations': ChatConversation.objects.filter(organization=org).count(),
            'channel_messages': channels.count(), 'chat_messages': chats.count(),
            'recent_messages': channels.filter(created_at__gte=cutoff).count()+chats.filter(created_at__gte=cutoff).count(),
            'meetings': meetings.count(), 'recent_meetings': meetings.filter(created_at__gte=cutoff).count(),
            'shared_files': files.count(), 'attachments': attachments.count(),
            'storage_bytes': (files.aggregate(n=Sum('size'))['n'] or 0)+(attachments.aggregate(n=Sum('size'))['n'] or 0),
        })


class RevenueQuery(serializers.Serializer):
    start = serializers.DateField(required=False)
    end = serializers.DateField(required=False)
    company = serializers.UUIDField(required=False)

    def validate(self, data):
        end = data.get('end', timezone.localdate())
        start = data.get('start', end-timedelta(days=364))
        if end < start or (end-start).days > 3660:
            raise serializers.ValidationError('Choose a valid range of at most 10 years')
        data.update(start=start,end=end)
        return data


class RevenueView(PlatformView):
    def get(self, request):
        form = RevenueQuery(data=request.query_params)
        form.is_valid(raise_exception=True)
        start,end = form.validated_data['start'],form.validated_data['end']
        rows = BillingInvoice.objects.exclude(status='void')
        company = form.validated_data.get('company')
        if company:
            get_object_or_404(Organization,pk=company)
            rows = rows.filter(organization_id=company)
        totals = {}
        def group(currency):
            return totals.setdefault(currency, {'currency':currency,'billed':Decimal('0.00'),
                'received':Decimal('0.00'),'outstanding':Decimal('0.00'),'overdue':Decimal('0.00')})
        billed=rows.filter(issued_on__range=(start,end))
        paid=rows.filter(status='paid',payment__paid_on__range=(start,end))
        open_rows=rows.filter(status='unpaid')
        for key,query in [('billed',billed),('received',paid),('outstanding',open_rows),
                          ('overdue',open_rows.filter(due_on__lt=timezone.localdate()))]:
            for row in query.order_by().values('currency').annotate(total=Sum('amount')):
                group(row['currency'])[key]=row['total']
        monthly=[]
        for row in paid.order_by().annotate(month=TruncMonth('payment__paid_on')).values('month','currency').annotate(total=Sum('amount')).order_by('month','currency'):
            monthly.append({'month':row['month'].strftime('%Y-%m'),'currency':row['currency'],'received':str(row['total'])})
        customers=[{'company_id':str(row['organization_id']),'company':row['organization__name'],
                    'currency':row['currency'],'received':str(row['total'])}
                   for row in paid.order_by().values('organization_id','organization__name','currency').annotate(total=Sum('amount')).order_by('organization__name','currency')[:500]]
        return Response({'start':start.isoformat(),'end':end.isoformat(),'as_of':timezone.localdate().isoformat(),
                         'totals':[{k:str(v) for k,v in totals[c].items()} for c in sorted(totals)],
                         'monthly':monthly,'customers':customers,'customers_limit':500})
