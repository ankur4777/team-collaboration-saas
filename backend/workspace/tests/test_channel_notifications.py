"""Channel unread/read cursor tests: per-member state and tenant isolation."""
import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from workspace.models import ChannelReadCursor, Organization, OrganizationMember, TeamMember


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class ChannelNotificationTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def post(self, path, data=None):
        response = self.client.post(
            path, data=json.dumps(data or {}), content_type='application/json',
            HTTP_X_CSRFTOKEN=self.csrf,
        )
        if response.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return response

    def register(self, email='owner@a.test', company='Company A'):
        response = self.post('/api/auth/register/', {
            'email': email, 'password': 'SafePassword123!',
            'full_name': 'Owner', 'organization_name': company,
        })
        self.assertEqual(response.status_code, 201, response.content)
        return Organization.objects.get(pk=response.json()['active_organization_id'])

    def employee(self, org, email):
        user = get_user_model().objects.create_user(
            email=email, password='SafePassword123!', full_name='Member',
        )
        OrganizationMember.objects.create(organization=org, user=user)
        return user

    def login(self, email):
        self.assertEqual(self.post('/api/auth/logout/').status_code, 200)
        response = self.post('/api/auth/login/', {
            'email': email, 'password': 'SafePassword123!',
        })
        self.assertEqual(response.status_code, 200, response.content)

    def channel(self):
        team = self.post('/api/teams/', {'name': 'Engineering'})
        self.assertEqual(team.status_code, 201, team.content)
        team_id = team.json()['id']
        channel_id = self.client.get(f'/api/teams/{team_id}/channels/').json()[0]['id']
        return team_id, channel_id

    def test_only_new_team_messages_unread_and_monotonic_read(self):
        org = self.register()
        team_id, channel_id = self.channel()
        old = self.post(f'/api/channels/{channel_id}/messages/', {'body': 'Historical'})
        self.assertEqual(old.status_code, 201)
        other = self.employee(org, 'colleague@a.test')
        invited = self.post(f'/api/teams/{team_id}/members/', {'email': other.email})
        self.assertEqual(invited.status_code, 201, invited.content)
        first = self.post(f'/api/channels/{channel_id}/messages/', {'body': 'New one'})
        second = self.post(f'/api/channels/{channel_id}/messages/', {'body': 'New two'})
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)

        self.login(other.email)
        notices = self.client.get('/api/channel-notifications/')
        self.assertEqual(notices.status_code, 200, notices.content)
        self.assertEqual(notices.json()[0]['channel_id'], channel_id)
        self.assertEqual(notices.json()[0]['unread_count'], 2)
        self.assertIsNone(notices.json()[0]['last_read_at'])

        csrf_failed = self.client.post(
            f'/api/channels/{channel_id}/read/', data=json.dumps({'message_id': first.json()['id']}),
            content_type='application/json',
        )
        self.assertEqual(csrf_failed.status_code, 403)
        self.assertEqual(self.post(f'/api/channels/{channel_id}/read/', {'message_id': 'not-a-uuid'}).status_code, 400)
        self.assertEqual(self.post(f'/api/channels/{channel_id}/read/', {'message_id': old.json()['id']}).status_code, 400)
        mark = self.post(f'/api/channels/{channel_id}/read/', {'message_id': first.json()['id']})
        self.assertEqual(mark.status_code, 200, mark.content)
        self.assertEqual(self.client.get('/api/channel-notifications/').json()[0]['unread_count'], 1)
        earlier = self.post(f'/api/channels/{channel_id}/read/', {'message_id': first.json()['id']})
        self.assertEqual(earlier.json()['last_read_at'], mark.json()['last_read_at'])
        self.assertEqual(self.post(f'/api/channels/{channel_id}/read/', {'message_id': second.json()['id']}).status_code, 200)
        self.assertEqual(self.client.get('/api/channel-notifications/').json()[0]['unread_count'], 0)

        self.login('owner@a.test')
        self.assertEqual(self.client.get('/api/channel-notifications/').json()[0]['unread_count'], 0)

    def test_isolation_from_other_companies_and_revoked_teams(self):
        org = self.register()
        team_id, channel_id = self.channel()
        other = self.employee(org, 'member@a.test')
        self.assertEqual(self.post(f'/api/teams/{team_id}/members/', {'email': other.email}).status_code, 201)
        message = self.post(f'/api/channels/{channel_id}/messages/', {'body': 'Private to A'}).json()
        self.login(other.email)
        self.assertEqual(len(self.client.get('/api/channel-notifications/').json()), 1)
        self.assertEqual(self.post(f'/api/channels/{channel_id}/read/', {'message_id': message['id']}).status_code, 200)
        self.assertTrue(ChannelReadCursor.objects.filter(channel_id=channel_id, user=other).exists())
        TeamMember.objects.filter(team_id=team_id, user=other).delete()
        self.assertEqual(self.client.get('/api/channel-notifications/').json(), [])
        self.assertEqual(self.post(f'/api/channels/{channel_id}/read/', {'message_id': message['id']}).status_code, 403)

        self.post('/api/auth/logout/')
        second = self.register('owner@b.test', 'Company B')
        self.assertNotEqual(second.pk, org.pk)
        self.assertEqual(self.client.get('/api/channel-notifications/').json(), [])
        self.assertEqual(self.post(f'/api/channels/{channel_id}/read/', {'message_id': message['id']}).status_code, 403)
