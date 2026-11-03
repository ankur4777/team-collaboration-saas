"""Run: python manage.py test workspace --verbosity 2"""
import json
from django.test import TestCase, Client, override_settings
from django.contrib.auth import get_user_model
from workspace.models import Organization, OrganizationMember, Team, TeamMember, Channel, Message


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class WorkspaceAPITests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def post(self, path, data):
        result = self.client.post(path, data=json.dumps(data), content_type='application/json',
                                  HTTP_X_CSRFTOKEN=self.csrf)
        # Logging in regenerates the CSRF secret: refresh before next write.
        if result.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return result

    def register(self, email='owner@company-a.test', org='Company A'):
        result = self.post('/api/auth/register/', {'email': email, 'password': 'SecurePass123!',
                                                  'full_name': 'Owner', 'organization_name': org})
        self.assertEqual(result.status_code, 201, result.content)
        return result.json()

    def test_registration_creates_owner_and_csrf_logout(self):
        session = self.register()
        org_id = session['active_organization_id']
        self.assertEqual(OrganizationMember.objects.get(organization_id=org_id).role, 'owner')
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 200)
        self.assertEqual(self.post('/api/auth/logout/', {}).status_code, 200)
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 401)
        self.assertEqual(self.client.post('/api/auth/login/', data='{}', content_type='application/json').status_code, 403)

    def test_team_chat_and_tenant_isolation(self):
        company_a = self.register()
        first = self.post('/api/teams/', {'name': 'Engineering'})
        self.assertEqual(first.status_code, 201, first.content)
        team_id = first.json()['id']
        channels = self.client.get(f'/api/teams/{team_id}/channels/').json()
        self.assertEqual(len(channels), 1)
        channel_id = channels[0]['id']
        msg = self.post(f'/api/channels/{channel_id}/messages/', {'body': 'Hello team!'})
        self.assertEqual(msg.status_code, 201, msg.content)
        self.assertEqual(Message.objects.count(), 1)

        self.post('/api/auth/logout/', {})
        company_b = self.register(email='owner@company-b.test', org='Company B')
        self.assertNotEqual(company_a['active_organization_id'], company_b['active_organization_id'])
        self.assertEqual(self.client.get('/api/teams/').json(), [])
        self.assertEqual(self.client.get(f'/api/teams/{team_id}/channels/').status_code, 403)
        self.assertEqual(self.client.get(f'/api/channels/{channel_id}/messages/').status_code, 403)
        self.assertEqual(self.post(f'/api/channels/{channel_id}/messages/', {'body': 'unauthorized'}).status_code, 403)
        self.assertEqual(self.post(f'/api/organizations/{company_a["active_organization_id"]}/activate/', {}).status_code, 403)

    def test_invitation_membership_and_team_access(self):
        owner = self.register()
        org_id = owner['active_organization_id']
        response = self.post(f'/api/organizations/{org_id}/invitations/', {'email': 'colleague@example.test'})
        self.assertEqual(response.status_code, 201, response.content)
        import urllib.parse
        invite_url = response.json()['development_invite_url'] if 'development_invite_url' in response.json() else None
        if invite_url is None:
            from django.core import mail
            invite_url = mail.outbox[-1].body.split('http://')[-1].splitlines()[0]
            invite_url = 'http://' + invite_url
        token = urllib.parse.parse_qs(urllib.parse.urlparse(invite_url).query)['token'][0]
        self.post('/api/auth/logout/', {})
        accepted = self.post(f'/api/invitations/{token}/accept/', {'full_name': 'Colleague', 'password': 'OtherSafePass123!'})
        self.assertEqual(accepted.status_code, 200, accepted.content)
        self.assertEqual(OrganizationMember.objects.filter(organization_id=org_id).count(), 2)
        self.assertEqual(self.post(f'/api/invitations/{token}/accept/', {}).status_code, 410)
        self.assertEqual(self.post('/api/teams/', {'name': 'Design'}).status_code, 201)

    def test_member_cannot_send_invites(self):
        owner = self.register()
        org = Organization.objects.get(id=owner['active_organization_id'])
        user = get_user_model().objects.create_user('staff@company-a.test', 'SecurePass123!', full_name='Staff')
        OrganizationMember.objects.create(organization=org, user=user, role='member')
        self.post('/api/auth/logout/', {})
        self.assertEqual(self.post('/api/auth/login/', {'email': user.email, 'password': 'SecurePass123!'}).status_code, 200)
        self.assertEqual(self.post(f'/api/organizations/{org.pk}/invitations/', {'email': 'new@example.test'}).status_code, 403)
