"""Manual provider-only invoice and payment records; never collects money."""
from decimal import Decimal
from io import BytesIO
from xml.sax.saxutils import escape
from django.conf import settings
from django.db import transaction
from django.db.models import Sum
from django.http import FileResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from .models import Organization, BillingInvoice, BillingPayment
from .platform_admin import PlatformView, audit, PAGE_SIZE

CURRENCIES = ('INR','CAD','AUD','USD','GBP','EUR')
METHODS = ('bank_transfer','card','upi','cash','other')


class InvoiceInput(serializers.Serializer):
    request_id = serializers.UUIDField()
    description = serializers.CharField(max_length=300)
    currency = serializers.ChoiceField(choices=CURRENCIES)
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal('0.01'))
    due_on = serializers.DateField(required=False, allow_null=True, default=None)


class PaymentInput(serializers.Serializer):
    paid_on = serializers.DateField()
    method = serializers.ChoiceField(choices=METHODS)
    reference = serializers.CharField(max_length=120)
    note = serializers.CharField(max_length=300, required=False, allow_blank=True, default='')

    def validate_paid_on(self, value):
        if value > timezone.localdate():
            raise serializers.ValidationError('Payment date cannot be in the future')
        return value


def invoice_data(row):
    payment = getattr(row, 'payment', None)
    return {'id': str(row.pk), 'number': row.number, 'company_name': row.company_name,
            'issuer_name': row.issuer_name, 'contact_email': row.contact_email,
            'description': row.description, 'amount': str(row.amount), 'currency': row.currency,
            'issued_on': row.issued_on.isoformat(), 'due_on': row.due_on.isoformat() if row.due_on else None,
            'status': row.status, 'overdue': row.status == 'unpaid' and bool(row.due_on and row.due_on < timezone.localdate()),
            'created_at': row.created_at.isoformat(),
            'payment': {'paid_on': payment.paid_on.isoformat(), 'method': payment.method,
                        'reference': payment.reference, 'note': payment.note} if payment else None}


def locked_invoice(company_id, invoice_id):
    org = get_object_or_404(Organization.objects.select_for_update(), pk=company_id)
    return get_object_or_404(BillingInvoice.objects.select_for_update(), organization=org, pk=invoice_id)


class InvoiceListView(PlatformView):
    def get(self, request, company_id):
        org = get_object_or_404(Organization, pk=company_id)
        try:
            page = int(request.query_params.get('page', '1'))
        except (TypeError, ValueError):
            raise ValidationError({'page':'Invalid page'})
        if not 1 <= page <= 100000:
            raise ValidationError({'page':'Invalid page'})
        rows = org.billing_invoices.select_related('payment')
        offset = (page-1)*PAGE_SIZE
        summary = {}
        for item in org.billing_invoices.exclude(status='void').values('currency','status').annotate(total=Sum('amount')):
            group = summary.setdefault(item['currency'], {'currency':item['currency'],'paid':'0.00','unpaid':'0.00'})
            group[item['status']] = str(item['total'])
        return Response({'items':[invoice_data(row) for row in rows[offset:offset+PAGE_SIZE]],
                         'total':rows.count(),'page':page,'page_size':PAGE_SIZE,
                         'totals':list(summary.values())})

    @transaction.atomic
    def post(self, request, company_id):
        form = InvoiceInput(data=request.data)
        form.is_valid(raise_exception=True)
        data = dict(form.validated_data)
        org = get_object_or_404(Organization.objects.select_for_update(), pk=company_id)
        old = org.billing_invoices.filter(request_id=data['request_id']).first()
        if old:
            if any(getattr(old, key) != value for key,value in data.items()):
                raise ValidationError({'request_id':'Invoice request already used with different details'})
            return Response(invoice_data(old))
        today = timezone.localdate()
        if data['due_on'] and data['due_on'] < today:
            raise ValidationError({'due_on':'Due date cannot precede the issue date'})
        license_row = getattr(org,'license',None)
        row = BillingInvoice.objects.create(organization=org, actor=request.user,
            company_name=org.name, issuer_name=settings.BILLING_ISSUER_NAME,
            contact_email=(license_row.contact_email if license_row else '') or '',
            issued_on=today, **data)
        audit(org,request.user,'invoice_issued',{'invoice':row.number,'amount':str(row.amount),'currency':row.currency})
        return Response(invoice_data(row),status=201)


class InvoicePaymentView(PlatformView):
    @transaction.atomic
    def post(self, request, company_id, invoice_id):
        form=PaymentInput(data=request.data)
        form.is_valid(raise_exception=True)
        data=dict(form.validated_data)
        row=locked_invoice(company_id,invoice_id)
        if row.status == 'paid':
            payment=row.payment
            if all(getattr(payment,key)==value for key,value in data.items()):
                return Response(invoice_data(row))
            raise ValidationError({'detail':'Payment already recorded; duplicate or conflicting payment is not allowed'})
        if row.status != 'unpaid':
            raise ValidationError({'detail':'Only unpaid invoices can be settled'})
        if data['paid_on'] < row.issued_on:
            raise ValidationError({'paid_on':'Payment date cannot precede invoice issue date'})
        BillingPayment.objects.create(invoice=row,actor=request.user,**data)
        row.status='paid'
        row.save(update_fields=['status'])
        audit(row.organization,request.user,'payment_recorded',{'invoice':row.number,'amount':str(row.amount),'currency':row.currency})
        return Response(invoice_data(BillingInvoice.objects.select_related('payment').get(pk=row.pk)),status=201)


class InvoiceVoidView(PlatformView):
    @transaction.atomic
    def post(self,request,company_id,invoice_id):
        row=locked_invoice(company_id,invoice_id)
        if row.status=='void':
            return Response(invoice_data(row))
        if row.status!='unpaid':
            raise ValidationError({'detail':'Paid invoices cannot be voided here'})
        row.status='void'
        row.save(update_fields=['status'])
        audit(row.organization,request.user,'invoice_voided',{'invoice':row.number})
        return Response(invoice_data(row))


class InvoicePDFView(PlatformView):
    def get(self,request,company_id,invoice_id):
        row=get_object_or_404(BillingInvoice.objects.select_related('payment'),organization_id=company_id,pk=invoice_id)
        output=BytesIO()
        doc=SimpleDocTemplate(output,pagesize=A4,rightMargin=48,leftMargin=48,topMargin=48,bottomMargin=48,
            title=row.number,author=row.issuer_name)
        styles=getSampleStyleSheet()
        styles.add(ParagraphStyle(name='InvoiceBrand',fontSize=19,leading=23,textColor=colors.HexColor('#a72e39'),spaceAfter=14))
        styles.add(ParagraphStyle(name='InvoiceCell',fontSize=10,leading=14,wordWrap='CJK'))
        def para(value,style='InvoiceCell'):
            return Paragraph(escape(str(value)).replace('\n','<br/>'),styles[style])
        elements=[para(row.issuer_name,'InvoiceBrand'),para('INVOICE','Heading1'),
            para(row.number),Spacer(1,12)]
        details=[
            ['Billed to',row.company_name],['Contact',row.contact_email or 'Not specified'],
            ['Issued on',row.issued_on],['Due on',row.due_on or 'Not specified'],['Status',row.status.upper()],
            ['Description',row.description],['Total',f'{row.currency} {row.amount:.2f}'],
        ]
        if row.status=='paid':
            details += [['Paid on',row.payment.paid_on],['Payment method',row.payment.method.replace('_',' ')],['Reference',row.payment.reference]]
        table=Table([[para(key),para(value)] for key,value in details],colWidths=[130,350])
        table.setStyle(TableStyle([('BACKGROUND',(0,0),(0,-1),colors.HexColor('#fff0f1')),
            ('VALIGN',(0,0),(-1,-1),'TOP'),('BOTTOMPADDING',(0,0),(-1,-1),10),
            ('TOPPADDING',(0,0),(-1,-1),10),('LINEBELOW',(0,0),(-1,-1),0.4,colors.HexColor('#e9d8da'))]))
        elements.extend([table,Spacer(1,20),para('Commercial billing record. No automated tax calculation or payment processing. Verify legal invoice requirements before issuing externally.')])
        doc.build(elements)
        output.seek(0)
        response=FileResponse(output,as_attachment=True,filename=row.number+'.pdf',content_type='application/pdf')
        response['X-Content-Type-Options']='nosniff'
        return response
