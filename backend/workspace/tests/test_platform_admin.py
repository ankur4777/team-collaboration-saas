import json
from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.core import mail
from django.test import TestCase, Client, override_settings
from django.utils import timezone
from workspace.models import Organization, OrganizationMember, CompanyLicense, PlatformAuditEntry, Invitation


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class PlatformAdminTests(TestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser('provider@example.test','StrongAdminPass123!',full_name='Provider')
        self.employee = get_user_model().objects.create_user('employee@example.test','StrongEmployeePass123!',full_name='Employee')
        self.company = Organization.objects.create(name='Existing customer',slug='existing-customer',created_by=self.employee)
        OrganizationMember.objects.create(organization=self.company,user=self.employee,role='admin')
        self.client = Client(enforce_csrf_checks=True)
        self.base = '/api/platform/companies/'

    def sign_in(self,user):
        self.client.force_login(user)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def write(self,method,path,data):
        return self.client.generic(method,path,data=json.dumps(data),content_type='application/json',HTTP_X_CSRFTOKEN=self.csrf)

    def test_platform_permissions_and_existing_company(self):
        self.sign_in(self.employee)
        self.assertEqual(self.client.get(self.base).status_code,403)
        self.assertEqual(self.write('PATCH',self.base+str(self.company.pk)+'/',{'status':'active'}).status_code,403)
        self.employee.is_staff=True
        self.employee.save(update_fields=['is_staff'])
        self.assertEqual(self.client.get(self.base).status_code,403)
        self.sign_in(self.admin)
        response=self.client.get(self.base)
        self.assertEqual(response.status_code,200,response.content)
        row=response.json()['items'][0]
        self.assertEqual(row['effective_status'],'unassigned')
        self.assertEqual(row['employee_count'],1)
        self.assertEqual(row['owner_emails'],[self.employee.email])
        self.assertTrue(self.client.get('/api/auth/me/').json()['user']['is_platform_admin'])

    def test_create_invite_and_update_license(self):
        self.sign_in(self.admin)
        created=self.write('POST',self.base,{'name':'New customer','owner_email':'client@example.test','plan':'Business','status':'active','seat_limit':10,'modules':['teams','chats'],'ends_on':'2020-01-01'})
        self.assertEqual(created.status_code,201,created.content)
        payload=created.json()
        self.assertTrue(payload['invitation_sent'])
        self.assertEqual(payload['company']['effective_status'],'expired')
        pk=payload['company']['id']
        self.assertEqual(payload['company']['employee_count'],0)
        self.assertFalse(OrganizationMember.objects.filter(organization_id=pk,user=self.admin).exists())
        self.assertEqual(Invitation.objects.get(organization_id=pk).role, 'admin')
        self.assertIn('client@example.test',mail.outbox[-1].to)
        self.assertEqual(self.client.get(self.base,{'status':'expired'}).json()['total'],1)
        path=self.base+pk+'/'
        self.assertEqual(self.write('PATCH',path,{'seat_limit':0}).status_code,400)
        self.assertEqual(self.write('PATCH',path,{'starts_on':'2027-01-01','ends_on':'2026-01-01'}).status_code,400)
        updated=self.write('PATCH',path,{'status':'suspended','modules':['email']})
        self.assertEqual(updated.status_code,200,updated.content)
        self.assertEqual(updated.json()['modules'],['email'])
        self.assertEqual(PlatformAuditEntry.objects.filter(organization_id=pk).count(),2)
        self.assertEqual(len(self.client.get(path).json()['audit']),2)
        previous=Invitation.objects.get(organization_id=pk)
        result=self.write('POST',path+'invite-owner/',{'email':'client@example.test'})
        self.assertEqual(result.status_code,200,result.content)
        previous.refresh_from_db()
        self.assertLessEqual(previous.expires_at,timezone.now())

    def test_owner_invite_failure_is_recoverable(self):
        self.sign_in(self.admin)
        with patch('workspace.platform_admin.send_mail',side_effect=RuntimeError('mail unavailable')):
            response=self.write('POST',self.base,{'name':'Mail failure','owner_email':'new@example.test'})
        self.assertEqual(response.status_code,201,response.content)
        self.assertFalse(response.json()['invitation_sent'])
        self.assertTrue(CompanyLicense.objects.filter(organization_id=response.json()['company']['id']).exists())
        self.assertNotIn('token',response.json())
