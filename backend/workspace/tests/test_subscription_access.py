from datetime import timedelta
from django.contrib.auth import get_user_model
from django.test import TestCase, Client
from django.utils import timezone
from workspace.models import Organization, OrganizationMember, CompanyLicense, Team
from workspace.license_access import access_allowed


class SubscriptionAccessTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user('subscriber@example.test','StrongPass123!',full_name='Subscriber')
        self.org = Organization.objects.create(name='Customer',slug='customer',created_by=self.user)
        OrganizationMember.objects.create(organization=self.org,user=self.user,role='owner')
        self.client = Client()
        self.client.force_login(self.user)
        session = self.client.session
        session['active_organization_id'] = str(self.org.pk)
        session.save()

    def test_legacy_and_expiry_renewal_without_data_loss(self):
        self.assertEqual(self.client.get('/api/teams/').status_code,200)
        today = timezone.localdate()
        row = CompanyLicense.objects.create(organization=self.org,status='active',ends_on=today)
        self.assertTrue(access_allowed(self.org.pk))
        team = self.client.post('/api/teams/',{'name':'Retained'},content_type='application/json')
        self.assertEqual(team.status_code,201,team.content)
        row.ends_on=today-timedelta(days=1)
        row.save()
        self.assertFalse(access_allowed(self.org.pk))
        self.assertEqual(self.client.get('/api/teams/').status_code,403)
        self.assertEqual(self.client.get('/api/chats/').status_code,403)
        self.assertEqual(self.client.get('/api/search/messages/',{'q':'abc'}).status_code,403)
        self.assertEqual(self.client.get('/api/files/').status_code,403)
        self.assertEqual(self.client.get('/api/mail/accounts/').status_code,403)
        info=self.client.get('/api/auth/me/').json()['organizations'][0]['subscription']
        self.assertEqual(info['status'],'expired')
        self.assertFalse(info['allowed'])
        row.ends_on=today+timedelta(days=30)
        row.save()
        self.assertEqual(self.client.get('/api/teams/').status_code,200)
        self.assertTrue(Team.objects.filter(organization=self.org,name='Retained').exists())

    def test_manual_suspension_and_future_dates(self):
        row = CompanyLicense.objects.create(organization=self.org,status='suspended')
        self.assertEqual(self.client.get('/api/teams/').status_code,403)
        row.status='cancelled'
        row.save()
        self.assertFalse(access_allowed(self.org.pk))
        row.status='trial'
        row.starts_on=timezone.localdate()+timedelta(days=1)
        row.save()
        self.assertFalse(access_allowed(self.org.pk))
        row.starts_on=timezone.localdate()
        row.save()
        self.assertTrue(access_allowed(self.org.pk))
        self.assertEqual(self.client.get('/api/teams/').status_code,200)

    def test_module_restrictions_and_shared_scheduling(self):
        row = CompanyLicense.objects.create(organization=self.org, status='active',
            enforce_modules=True, modules=['teams','search','calendar'])
        team = self.client.post('/api/teams/',{'name':'Entitled'},content_type='application/json')
        self.assertEqual(team.status_code,201,team.content)
        for path in ('/api/chats/','/api/mail/accounts/','/api/files/'):
            self.assertEqual(self.client.get(path).status_code,403,path)
        self.assertEqual(self.client.get('/api/search/messages/',{'q':'abc'}).status_code,200)
        self.assertEqual(self.client.get('/api/meetings/').status_code,200)
        import uuid
        self.assertEqual(self.client.get(f'/api/meetings/{uuid.uuid4()}/call/').status_code,403)
        self.assertEqual(self.client.get('/api/auth/me/').json()['organizations'][0]['subscription']['modules'],
                         ['calendar','search','teams'])
        row.modules=[]
        row.save()
        self.assertEqual(self.client.get('/api/teams/').status_code,403)
        self.assertEqual(self.client.get('/api/organizations/'+str(self.org.pk)+'/members/').status_code,200)
        row.enforce_modules=False
        row.save()
        self.assertEqual(self.client.get('/api/teams/').status_code,200)
        self.assertTrue(Team.objects.filter(organization=self.org,name='Entitled').exists())

    def test_countdown_uses_inclusive_utc_end_date(self):
        from datetime import datetime, timezone as utc
        from unittest.mock import patch
        from workspace.license_access import access_summary
        now = datetime(2026, 11, 25, 12, 30, tzinfo=utc.utc)
        row = CompanyLicense.objects.create(organization=self.org, status='active', ends_on=now.date())
        with patch('workspace.license_access.timezone.now', return_value=now):
            info = access_summary(row)
            self.assertEqual(info['remaining_seconds'], 41400)
            self.assertEqual(info['expires_at'], '2026-11-26T00:00:00+00:00')
            self.assertEqual(info['status'], 'active')
            row.ends_on = now.date()-timedelta(days=1)
            self.assertEqual(access_summary(row)['remaining_seconds'], 0)
            self.assertEqual(access_summary(row)['status'], 'expired')
            row.ends_on = None
            self.assertIsNone(access_summary(row)['expires_at'])
