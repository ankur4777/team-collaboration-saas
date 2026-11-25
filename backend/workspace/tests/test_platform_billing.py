import uuid
from datetime import timedelta
from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone
from workspace.models import Organization, OrganizationMember, BillingInvoice, BillingPayment, PlatformAuditEntry


class BillingTests(TestCase):
    def setUp(self):
        self.admin=get_user_model().objects.create_superuser('billing-admin@example.test','StrongProvider123!',full_name='Billing Admin')
        self.owner=get_user_model().objects.create_user('billing-owner@example.test','StrongOwner123!',full_name='Owner')
        self.org=Organization.objects.create(name='Billing company',slug='billing-company',created_by=self.owner)
        self.other=Organization.objects.create(name='Other customer',slug='billing-other',created_by=self.owner)
        OrganizationMember.objects.create(organization=self.org,user=self.owner,role='owner')
        self.client=Client()
        self.client.force_login(self.admin)
        self.url=f'/api/platform/companies/{self.org.pk}/invoices/'
        self.today=timezone.localdate()

    def post(self,url,data):
        return self.client.post(url,data,content_type='application/json')

    def issue(self,**extra):
        return self.post(self.url,{'request_id':str(uuid.uuid4()),'description':'TeamWorkspace subscription','amount':'125.50','currency':'CAD',**extra})

    def test_issue_pdf_and_record_full_payment(self):
        key=str(uuid.uuid4())
        response=self.issue(request_id=key)
        self.assertEqual(response.status_code,201,response.content)
        row=response.json()
        self.assertEqual(row['status'],'unpaid')
        self.assertEqual(self.issue(request_id=key).status_code,200)
        self.assertEqual(self.issue(request_id=key,amount='12.00').status_code,400)
        self.assertEqual(BillingInvoice.objects.count(),1)
        path=self.url+row['id']+'/'
        pdf=self.client.get(path+'pdf/')
        self.assertEqual(pdf.status_code,200)
        self.assertEqual(pdf['Content-Type'],'application/pdf')
        self.assertTrue(b''.join(pdf.streaming_content).startswith(b'%PDF'))
        data={'paid_on':self.today.isoformat(),'method':'bank_transfer','reference':'TX-001'}
        paid=self.post(path+'payment/',data)
        self.assertEqual(paid.status_code,201,paid.content)
        self.assertEqual(paid.json()['payment']['reference'],'TX-001')
        self.assertEqual(self.post(path+'payment/',data).status_code,200)
        self.assertEqual(self.post(path+'payment/',{**data,'reference':'TX-002'}).status_code,400)
        self.assertEqual(self.post(path+'void/',{}).status_code,400)
        self.assertEqual(BillingPayment.objects.count(),1)
        self.assertEqual(self.client.get(self.url).json()['totals'][0]['paid'],'125.50')
        self.assertEqual(PlatformAuditEntry.objects.filter(organization=self.org).count(),2)

    def test_validation_void_and_isolation(self):
        self.assertEqual(self.issue(amount='0').status_code,400)
        self.assertEqual(self.issue(currency='BAD').status_code,400)
        self.assertEqual(self.issue(due_on=(self.today-timedelta(days=1)).isoformat()).status_code,400)
        row=self.issue(currency='INR').json()
        path=self.url+row['id']+'/'
        other=f'/api/platform/companies/{self.other.pk}/invoices/{row["id"]}/'
        self.assertEqual(self.client.get(other+'pdf/').status_code,404)
        self.assertEqual(self.post(path+'void/',{}).status_code,200)
        self.assertEqual(self.client.get(self.url).json()['totals'],[])
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get(self.url).status_code,403)
        self.assertEqual(self.client.get(path+'pdf/').status_code,403)
        self.assertEqual(self.issue().status_code,403)
