import hashlib
from django.contrib.auth import get_user_model
from django.test import TestCase, Client, override_settings
from django.core import mail
from urllib.parse import urlparse, parse_qs
from workspace.models import Organization, OrganizationMember, CompanyLicense, Invitation


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class SeatLimitTests(TestCase):
    def setUp(self):
        self.owner = get_user_model().objects.create_user('seat-owner@example.test','StrongOwnerPass123!',full_name='Owner')
        self.org = Organization.objects.create(name='Seat company',slug='seat-company',created_by=self.owner)
        OrganizationMember.objects.create(organization=self.org,user=self.owner,role='admin')
        self.license = CompanyLicense.objects.create(organization=self.org,status='active',seat_limit=2)
        self.client = Client()
        self.client.force_login(self.owner)
        session = self.client.session
        session['active_organization_id'] = str(self.org.pk)
        session.save()
        self.url = f'/api/organizations/{self.org.pk}/invitations/'

    def invite(self,email):
        return self.client.post(self.url,{'email':email},content_type='application/json')

    def token(self):
        link = next(line for line in mail.outbox[-1].body.splitlines() if '/invite?token=' in line)
        return parse_qs(urlparse(link).query)['token'][0]

    def accept(self,client,token):
        return client.post(f'/api/invitations/{token}/accept/',{'full_name':'New Employee','password':'AnotherStrongPass123!'},content_type='application/json')

    def test_invite_redemption_rechecks_capacity_and_does_not_create_orphan(self):
        self.assertEqual(self.invite('first@example.test').status_code,201)
        first = self.token()
        self.assertEqual(self.invite('second@example.test').status_code,201)
        second = self.token()
        self.assertEqual(self.accept(Client(),first).status_code,200)
        blocked = self.accept(Client(),second)
        self.assertEqual(blocked.status_code,409,blocked.content)
        self.assertFalse(get_user_model().objects.filter(email='second@example.test').exists())
        invitation = Invitation.objects.get(token_hash=hashlib.sha256(second.encode()).hexdigest())
        self.assertIsNone(invitation.accepted_at)
        self.assertEqual(self.invite('third@example.test').status_code,409)
        info=self.client.get('/api/auth/me/').json()['organizations'][0]['subscription']
        self.assertEqual(info['seats_used'],2)
        self.assertEqual(info['seats_remaining'],0)
        first_member = OrganizationMember.objects.get(organization=self.org,user__email='first@example.test')
        self.assertEqual(self.client.delete(f'/api/organizations/{self.org.pk}/members/{first_member.pk}/').status_code,204)
        self.assertEqual(self.accept(Client(),second).status_code,200)
        self.assertEqual(OrganizationMember.objects.filter(organization=self.org).count(),2)

    def test_provider_cannot_reduce_below_usage_and_increase_restores_capacity(self):
        employee = get_user_model().objects.create_user('already@example.test','StrongOtherPass123!',full_name='Existing')
        OrganizationMember.objects.create(organization=self.org,user=employee)
        provider = get_user_model().objects.create_superuser('seat-provider@example.test','StrongProviderPass123!',full_name='Provider')
        admin = Client()
        admin.force_login(provider)
        path = f'/api/platform/companies/{self.org.pk}/'
        self.assertEqual(admin.patch(path,{'seat_limit':1},content_type='application/json').status_code,400)
        self.assertEqual(self.invite('new@example.test').status_code,409)
        self.assertEqual(admin.patch(path,{'seat_limit':3},content_type='application/json').status_code,200)
        self.assertEqual(self.invite('new@example.test').status_code,201)
        self.assertEqual(admin.patch(path,{'seat_limit':None},content_type='application/json').status_code,200)
        self.assertEqual(self.invite('unlimited@example.test').status_code,201)
