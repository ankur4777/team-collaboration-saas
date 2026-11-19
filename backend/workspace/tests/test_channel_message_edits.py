"""Channel edit/delete behavior and tenant-safe history regressions."""
import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from workspace.models import (
    Channel, MentionNotification, Message, Organization, OrganizationMember,
    Team, TeamMember,
)


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class ChannelMessageEditDeleteTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        registered = self.post('/api/auth/register/', {
            'email': 'owner@a.test', 'password': 'SafePassword123!',
            'full_name': 'Owner', 'organization_name': 'Company A',
        })
        self.assertEqual(registered.status_code, 201, registered.content)
        self.org = Organization.objects.get(pk=registered.json()['active_organization_id'])
        self.owner = get_user_model().objects.get(email='owner@a.test')
        self.team = Team.objects.create(organization=self.org, created_by=self.owner, name='Engineering')
        TeamMember.objects.create(team=self.team, user=self.owner, role=TeamMember.Role.OWNER)
        self.channel = Channel.objects.create(team=self.team, name='General')

    def post(self, url, body=None):
        response = self.client.post(
            url, data=json.dumps(body or {}), content_type='application/json',
            HTTP_X_CSRFTOKEN=self.csrf,
        )
        if response.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return response

    def patch(self, url, body):
        return self.client.patch(
            url, data=json.dumps(body), content_type='application/json',
            HTTP_X_CSRFTOKEN=self.csrf,
        )

    def delete(self, url):
        return self.client.delete(url, HTTP_X_CSRFTOKEN=self.csrf)

    def employee(self, email, name, *, join_team=False):
        user = get_user_model().objects.create_user(
            email=email, password='SafePassword123!', full_name=name,
        )
        OrganizationMember.objects.create(organization=self.org, user=user)
        if join_team:
            TeamMember.objects.create(team=self.team, user=user)
        return user

    def login(self, email):
        self.assertEqual(self.post('/api/auth/logout/').status_code, 200)
        response = self.post('/api/auth/login/', {
            'email': email, 'password': 'SafePassword123!',
        })
        self.assertEqual(response.status_code, 200, response.content)

    def send_message(self, body='Project update'):
        response = self.post(f'/api/channels/{self.channel.pk}/messages/', {'body':body})
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def detail_url(self, message_id):
        return f'/api/channels/{self.channel.pk}/messages/{message_id}/'

    def test_author_can_edit_and_broadcast_updates(self):
        message = self.send_message('Original message')
        url = self.detail_url(message['id'])
        self.assertIsNone(message['edited_at'])
        self.assertIsNone(message['deleted_at'])
        with patch('workspace.views.broadcast_message') as broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                result = self.patch(url, {'body':'  Updated message  '})
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual(result.json()['body'], 'Updated message')
        self.assertIsNotNone(result.json()['edited_at'])
        self.assertIsNone(result.json()['deleted_at'])
        broadcast.assert_called_once()
        self.assertEqual(broadcast.call_args.kwargs['action'], 'message.updated')
        self.assertEqual(broadcast.call_args.args[1]['body'], 'Updated message')
        rows = self.client.get(f'/api/channels/{self.channel.pk}/messages/').json()
        self.assertEqual(rows[0]['body'], 'Updated message')

    def test_only_author_may_mutate_and_invalid_body_rejected(self):
        colleague = self.employee('member@a.test', 'Member', join_team=True)
        message = self.send_message()
        url = self.detail_url(message['id'])
        for bad in ('', ' ', 'x'*4001, None):
            result = self.patch(url, {'body':bad})
            self.assertEqual(result.status_code, 400, result.content)
        self.login(colleague.email)
        self.assertEqual(self.patch(url, {'body':'Unauthorized'}).status_code, 403)
        self.assertEqual(self.delete(url).status_code, 403)
        self.assertEqual(Message.objects.get(pk=message['id']).body, 'Project update')
        no_csrf = self.client.patch(url, data=json.dumps({'body':'Unauthorized'}), content_type='application/json')
        self.assertEqual(no_csrf.status_code, 403)

    def test_soft_delete_hides_content_and_prevents_edit(self):
        message = self.send_message('Delete sensitive details')
        url = self.detail_url(message['id'])
        with patch('workspace.views.broadcast_message') as broadcast:
            with self.captureOnCommitCallbacks(execute=True):
                result = self.delete(url)
        self.assertEqual(result.status_code, 204, result.content)
        event = broadcast.call_args
        self.assertEqual(event.kwargs['action'], 'message.deleted')
        self.assertEqual(event.args[1]['body'], '')
        self.assertIsNotNone(event.args[1]['deleted_at'])
        record = Message.objects.get(pk=message['id'])
        self.assertEqual(record.body, '')
        self.assertIsNotNone(record.deleted_at)
        listed = self.client.get(f'/api/channels/{self.channel.pk}/messages/').json()
        self.assertEqual(listed[0]['body'], '')
        self.assertIsNotNone(listed[0]['deleted_at'])
        self.assertEqual(self.patch(url, {'body':'Restore'}).status_code, 400)
        self.assertEqual(self.delete(url).status_code, 204)
        self.assertEqual(
            self.client.get('/api/search/messages/', {'q':'sensitive', 'scope':'channels'}).json()['results'],
            [],
        )

    def test_deleted_message_no_longer_unread_or_a_mention(self):
        alice = self.employee('alice@a.test', 'Alice Smith', join_team=True)
        message = self.send_message('Please review @Alice Smith roadmap')
        self.assertEqual(MentionNotification.objects.filter(recipient=alice).count(), 1)
        self.login(alice.email)
        counts = self.client.get('/api/channel-notifications/').json()
        self.assertEqual(counts[0]['unread_count'], 1)
        self.assertEqual(len(self.client.get('/api/mentions/').json()['results']), 1)
        self.login(self.owner.email)
        self.assertEqual(self.delete(self.detail_url(message['id'])).status_code, 204)
        self.assertEqual(MentionNotification.objects.filter(recipient=alice).count(), 0)
        self.login(alice.email)
        self.assertEqual(self.client.get('/api/channel-notifications/').json()[0]['unread_count'], 0)
        self.assertEqual(self.client.get('/api/mentions/').json()['results'], [])

    def test_history_uses_current_team_join_time_after_reinvite(self):
        old = self.send_message('Before join')
        alice = self.employee('alice@a.test', 'Alice', join_team=True)
        recent = self.send_message('After join')
        self.login(alice.email)
        rows = self.client.get(f'/api/channels/{self.channel.pk}/messages/').json()
        self.assertEqual([item['id'] for item in rows], [recent['id']])
        self.login(self.owner.email)
        TeamMember.objects.filter(team=self.team, user=alice).delete()
        last = self.send_message('Before rejoin')
        TeamMember.objects.create(team=self.team, user=alice)
        newest = self.send_message('After rejoin')
        self.login(alice.email)
        rows = self.client.get(f'/api/channels/{self.channel.pk}/messages/').json()
        self.assertEqual([item['id'] for item in rows], [newest['id']])
        self.assertNotIn(old['id'], [item['id'] for item in rows])
        self.assertNotIn(last['id'], [item['id'] for item in rows])

    def test_wrong_message_and_other_company_cannot_mutate(self):
        import uuid
        sent = self.send_message()
        unknown = self.detail_url(uuid.uuid4())
        self.assertEqual(self.patch(unknown, {'body':'Not found'}).status_code, 404)
        self.assertEqual(self.delete(unknown).status_code, 404)
        other = Organization.objects.create(
            name='Company B', slug='channel-edit-company-b', created_by=self.owner,
        )
        OrganizationMember.objects.create(
            organization=other, user=self.owner, role=OrganizationMember.Role.OWNER,
        )
        switched = self.post(f'/api/organizations/{other.pk}/activate/')
        self.assertEqual(switched.status_code, 200, switched.content)
        old = self.detail_url(sent['id'])
        self.assertEqual(self.patch(old, {'body':'Change from B'}).status_code, 403)
        self.assertEqual(self.delete(old).status_code, 403)
        self.assertEqual(Message.objects.get(pk=sent['id']).body, 'Project update')
