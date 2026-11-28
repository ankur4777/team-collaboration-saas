from django.contrib.auth import get_user_model
from django.core import mail
from django.test import Client, TestCase, override_settings
from workspace.models import CompanyLicense, Organization, OrganizationMember, Invitation


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class ProviderDirectoryTests(TestCase):
    def setUp(self):
        user=get_user_model()
        self.provider=user.objects.create_superuser('directory-provider@example.test','StrongProvider123!',full_name='Provider')
        self.owner=user.objects.create_user('directory-owner@example.test','StrongOwner123!',full_name='Owner Name')
        self.employee=user.objects.create_user('directory-employee@example.test','StrongEmployee123!',full_name='Employee Name')
        self.org=Organization.objects.create(name='Example Company',slug='example-company',created_by=self.owner)
        self.owner_row=OrganizationMember.objects.create(organization=self.org,user=self.owner,role='admin')
        self.row=OrganizationMember.objects.create(organization=self.org,user=self.employee)
        CompanyLicense.objects.create(organization=self.org,status='active',seat_limit=3)
        self.client=Client()
        self.client.force_login(self.provider)
        self.path=f'/api/platform/companies/{self.org.pk}/'

    def test_company_details_and_filters(self):
        profile={'name':'Updated Company','country':'Canada','country_code':'+1','phone':'4165550100',
                 'website':'https://example.com','tax_number':'TEST-123','address':'Toronto, Canada'}
        r=self.client.patch(self.path,profile,content_type='application/json')
        self.assertEqual(r.status_code,200,r.content)
        self.assertEqual(r.json()['owner_names'],['Owner Name'])
        self.assertEqual(r.json()['phone'],'4165550100')
        self.assertEqual(r.json()['name'],'Updated Company')
        self.assertEqual(r.json()['slug'],'example-company')
        self.assertEqual(self.client.get('/api/platform/companies/',{'q':'TEST-123','page_size':10,'sort':'name'}).json()['total'],1)
        self.assertEqual(self.client.patch(self.path,{'phone':'abc'},content_type='application/json').status_code,400)

    def test_user_directory_and_safe_edit(self):
        response=self.client.get('/api/platform/users/',{'q':'Employee Name','page_size':10})
        self.assertEqual(response.status_code,200,response.content)
        self.assertEqual(response.json()['total'],1)
        url=f'/api/platform/users/{self.row.pk}/'
        changed=self.client.patch(url,{'role':'admin','contact_phone':'+14165550100'},content_type='application/json')
        self.assertEqual(changed.status_code,200,changed.content)
        self.assertEqual(changed.json()['contact_phone'],'+14165550100')
        self.assertEqual(self.client.patch(f'/api/platform/users/{self.owner_row.pk}/',{'role':'member'},content_type='application/json').status_code,200)
        self.assertEqual(self.client.patch(url,{'role':'member'},content_type='application/json').status_code,400)
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get('/api/platform/users/').status_code,403)
        self.assertEqual(self.client.patch(url,{'role':'member'},content_type='application/json').status_code,403)

    def test_invite_respects_capacity_and_resends(self):
        path=self.path+'invite-user/'
        data={'email':'new-directory@example.test','role':'member'}
        r=self.client.post(path,data,content_type='application/json')
        self.assertEqual(r.status_code,201,r.content)
        self.assertTrue(r.json()['invitation_sent'])
        self.assertEqual(mail.outbox[-1].to,[data['email']])
        previous=Invitation.objects.get(pk=r.json()['id'])
        self.assertEqual(self.client.post(path,data,content_type='application/json').status_code,201)
        previous.refresh_from_db()
        self.assertFalse(previous.is_valid)
        CompanyLicense.objects.filter(organization=self.org).update(seat_limit=2)
        self.assertEqual(self.client.post(path,{'email':'full@example.test'},content_type='application/json').status_code,409)

    def test_user_filters_are_company_scoped(self):
        other=Organization.objects.create(name='Other company',slug='other-company',created_by=self.employee)
        OrganizationMember.objects.create(organization=other,user=self.employee,role='admin')
        self.employee.is_active=False
        self.employee.save(update_fields=['is_active'])
        data=self.client.get('/api/platform/users/',{'company':str(self.org.pk),'account':'inactive','verified':'no'}).json()
        self.assertEqual(data['total'],1)
        self.assertEqual(data['items'][0]['id'],str(self.row.pk))
        self.assertEqual(data['stats']['memberships'],2)
        self.assertEqual(data['stats']['admins'],1)
        self.assertEqual(self.client.get('/api/platform/users/',{'company':'bad'}).status_code,400)

    def test_pending_user_invitations_can_be_revoked_by_provider_only(self):
        created=self.client.post(self.path+'invite-user/',{'email':'pending-user@example.test','role':'member'},content_type='application/json')
        self.assertEqual(created.status_code,201,created.content)
        path='/api/platform/user-invitations/'
        data=self.client.get(path,{'company':str(self.org.pk),'role':'member'}).json()
        self.assertEqual(data['total'],1)
        row=data['items'][0]
        self.assertNotIn('token_hash',row)
        detail=path+row['id']+'/'
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get(path).status_code,403)
        self.assertEqual(self.client.delete(detail).status_code,403)
        self.client.force_login(self.provider)
        self.assertEqual(self.client.delete(detail).status_code,204)
        self.assertFalse(Invitation.objects.get(pk=row['id']).is_valid)
        self.assertEqual(self.client.get(path).json()['total'],0)
