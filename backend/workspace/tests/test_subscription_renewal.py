import uuid
from datetime import timedelta
from django.contrib.auth import get_user_model
from django.test import TestCase, Client
from django.utils import timezone
from workspace.models import Organization, OrganizationMember, CompanyLicense, SubscriptionRenewal, PlatformAuditEntry


class RenewalTests(TestCase):
    def setUp(self):
        self.provider=get_user_model().objects.create_superuser('renew-provider@example.test','StrongProviderPass123!',full_name='Provider')
        self.owner=get_user_model().objects.create_user('renew-owner@example.test','StrongOwnerPass123!',full_name='Owner')
        self.org=Organization.objects.create(name='Renew company',slug='renew-company',created_by=self.owner)
        OrganizationMember.objects.create(organization=self.org,user=self.owner,role='owner')
        self.today=timezone.localdate()
        self.row=CompanyLicense.objects.create(organization=self.org,status='active',
            starts_on=self.today-timedelta(days=10), ends_on=self.today+timedelta(days=20),seat_limit=5,modules=['chats'],enforce_modules=True)
        self.client=Client()
        self.client.force_login(self.provider)
        self.url=f'/api/platform/companies/{self.org.pk}/renewals/'

    def renew(self,**kwargs):
        data={'request_id':str(uuid.uuid4()),'days':30,**kwargs}
        return self.client.post(self.url,data,content_type='application/json')

    def test_extend_and_deduplicate(self):
        key=str(uuid.uuid4())
        first=self.renew(request_id=key,note='Contract 1')
        self.assertEqual(first.status_code,201,first.content)
        self.row.refresh_from_db()
        self.assertEqual(self.row.ends_on,self.today+timedelta(days=50))
        self.assertEqual(self.row.seat_limit,5)
        self.assertEqual(self.row.modules,['chats'])
        self.assertEqual(self.row.starts_on,self.today-timedelta(days=10))
        repeat=self.renew(request_id=key,note='Contract 1')
        self.assertEqual(repeat.status_code,200,repeat.content)
        self.assertTrue(repeat.json()['replayed'])
        self.assertEqual(self.renew(request_id=key,days=90).status_code,400)
        self.assertEqual(SubscriptionRenewal.objects.count(),1)
        self.assertEqual(PlatformAuditEntry.objects.filter(action='subscription_renewed').count(),1)
        self.assertEqual(self.client.get(self.url).json()['items'][0]['note'],'Contract 1')

    def test_expiry_and_manual_suspension(self):
        self.row.ends_on=self.today-timedelta(days=1)
        self.row.save()
        response=self.renew(days=1)
        self.assertEqual(response.status_code,201,response.content)
        self.assertEqual(response.json()['company']['effective_status'],'active')
        self.row.refresh_from_db()
        self.assertEqual(self.row.starts_on,self.today)
        self.assertEqual(self.row.ends_on,self.today)
        self.row.status='suspended'
        self.row.save()
        self.assertEqual(self.renew().json()['company']['effective_status'],'suspended')
        self.assertEqual(self.renew(reactivate=True).json()['company']['effective_status'],'active')

    def test_provider_only_and_invalid_duration(self):
        self.assertEqual(self.renew(days=0).status_code,400)
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get(self.url).status_code,403)
        self.assertEqual(self.renew().status_code,403)
        self.assertFalse(SubscriptionRenewal.objects.exists())
