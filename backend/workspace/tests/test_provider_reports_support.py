import uuid
from datetime import timedelta
from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone
from workspace.models import Organization, OrganizationMember, CompanyLicense, Team, BillingInvoice, BillingPayment, SupportTicket


class ProviderReportsSupportTests(TestCase):
    def setUp(self):
        User=get_user_model()
        self.admin=User.objects.create_superuser('reports-provider@example.test','StrongProvider123!',full_name='Provider')
        self.owner=User.objects.create_user('reports-owner@example.test','StrongOwner123!',full_name='Owner')
        self.peer=User.objects.create_user('reports-peer@example.test','StrongPeer123!',full_name='Peer')
        self.other=User.objects.create_user('reports-other@example.test','StrongOther123!',full_name='Other')
        self.org=Organization.objects.create(name='Report customer',slug='report-customer',created_by=self.owner)
        self.org2=Organization.objects.create(name='Other customer',slug='report-other',created_by=self.other)
        OrganizationMember.objects.create(organization=self.org,user=self.owner,role='owner',last_seen_at=timezone.now())
        OrganizationMember.objects.create(organization=self.org,user=self.peer)
        OrganizationMember.objects.create(organization=self.org2,user=self.other,role='owner')
        self.provider=Client()
        self.provider.force_login(self.admin)
        self.today=timezone.localdate()

    def customer(self,user,org):
        client=Client()
        client.force_login(user)
        session=client.session
        session['active_organization_id']=str(org.pk)
        session.save()
        return client

    def post(self,client,path,data):
        return client.post(path,data,content_type='application/json')

    def test_usage_is_aggregate_and_company_scoped(self):
        Team.objects.create(organization=self.org,name='First team',created_by=self.owner)
        Team.objects.create(organization=self.org2,name='Other team',created_by=self.other)
        url=f'/api/platform/companies/{self.org.pk}/usage/'
        result=self.provider.get(url)
        self.assertEqual(result.status_code,200,result.content)
        row=result.json()
        self.assertEqual(row['members'],2)
        self.assertEqual(row['recent_members'],1)
        self.assertEqual(row['teams'],1)
        self.assertEqual(row['storage_bytes'],0)
        self.assertEqual(self.customer(self.owner,self.org).get(url).status_code,403)

    def test_support_isolation_and_resolution_even_when_expired(self):
        CompanyLicense.objects.create(organization=self.org,status='suspended')
        peer=self.customer(self.peer,self.org)
        owner=self.customer(self.owner,self.org)
        other=self.customer(self.other,self.org2)
        data={'subject':'Subscription question','priority':'high','body':'Please help with renewal.'}
        created=self.post(peer,'/api/support/',data)
        self.assertEqual(created.status_code,201,created.content)
        pk=created.json()['id']
        path=f'/api/support/{pk}/'
        provider_path=f'/api/platform/support/{pk}/'
        self.assertEqual(owner.get(path).status_code,200)
        self.assertEqual(other.get(path).status_code,404)
        self.assertEqual(other.get('/api/support/').json()['total'],0)
        self.assertEqual(peer.get('/api/platform/support/').status_code,403)
        updated=self.post(self.provider,provider_path,{'body':'We can assist.','status':'resolved'})
        self.assertEqual(updated.status_code,200,updated.content)
        self.assertEqual(updated.json()['status'],'resolved')
        self.assertEqual(len(peer.get(path).json()['replies']),2)
        self.assertEqual(self.post(peer,path,{'status':'closed'}).status_code,400)
        self.assertEqual(self.post(peer,path,{'body':'Thank you, one more question.'}).json()['status'],'open')
        self.post(self.provider,provider_path,{'status':'closed'})
        self.assertEqual(self.post(peer,path,{'body':'Closed reply'}).status_code,400)
        self.assertEqual(SupportTicket.objects.count(),1)

    def test_revenue_currency_and_period_separation(self):
        def invoice(org,currency,amount,status,issued,due=None):
            return BillingInvoice.objects.create(organization=org,actor=self.admin,request_id=uuid.uuid4(),
                company_name=org.name,issuer_name='TeamWorkspace',description='Subscription',currency=currency,
                amount=amount,status=status,issued_on=issued,due_on=due)
        old=invoice(self.org,'CAD','120.00','paid',self.today-timedelta(days=60))
        BillingPayment.objects.create(invoice=old,actor=self.admin,paid_on=self.today,method='bank_transfer',reference='CAD-1')
        invoice(self.org,'CAD','40.00','unpaid',self.today-timedelta(days=40),self.today-timedelta(days=2))
        invoice(self.org,'CAD','999.00','void',self.today)
        invoice(self.org2,'INR','1000.00','unpaid',self.today)
        url='/api/platform/revenue/'
        response=self.provider.get(url,{'start':self.today.isoformat(),'end':self.today.isoformat()})
        self.assertEqual(response.status_code,200,response.content)
        data=response.json()
        totals={r['currency']:r for r in data['totals']}
        self.assertEqual(totals['CAD']['billed'],'0.00')
        self.assertEqual(totals['CAD']['received'],'120.00')
        self.assertEqual(totals['CAD']['outstanding'],'40.00')
        self.assertEqual(totals['CAD']['overdue'],'40.00')
        self.assertEqual(totals['INR']['billed'],'1000.00')
        self.assertEqual(data['monthly'][0]['received'],'120.00')
        self.assertEqual(data['customers'][0]['company_id'],str(self.org.pk))
        scoped=self.provider.get(url,{'company':str(self.org.pk)}).json()
        self.assertEqual([x['currency'] for x in scoped['totals']],['CAD'])
        self.assertEqual(self.customer(self.owner,self.org).get(url).status_code,403)
