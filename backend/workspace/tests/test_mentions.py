"""End-to-end API tests for mention resolution, notifications, and access control."""
import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from workspace.models import (
    Channel, ChatParticipant, MentionNotification, Organization, OrganizationMember,
    Team, TeamMember,
)


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class MentionsTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        registered = self.post('/api/auth/register/', {
            'email': 'owner@first.test', 'password': 'GoodPassword123!',
            'full_name': 'Owner', 'organization_name': 'First Company',
        })
        self.assertEqual(registered.status_code, 201, registered.content)
        self.owner = get_user_model().objects.get(email='owner@first.test')
        self.org = Organization.objects.get(pk=registered.json()['active_organization_id'])
        self.team = Team.objects.create(
            organization=self.org, created_by=self.owner, name='Engineering',
        )
        TeamMember.objects.create(team=self.team, user=self.owner, role=TeamMember.Role.OWNER)
        self.channel = Channel.objects.create(team=self.team, name='General')

    def post(self, url, data=None):
        return self.client.post(
            url, data=json.dumps(data or {}), content_type='application/json',
            HTTP_X_CSRFTOKEN=self.csrf,
        )

    def add_person(self, email, name, *, organization=None, team=False):
        organization = organization or self.org
        user = get_user_model().objects.create_user(
            email=email, password='GoodPassword123!', full_name=name,
        )
        OrganizationMember.objects.create(organization=organization, user=user)
        if team:
            TeamMember.objects.create(team=self.team, user=user)
        return user

    def login(self, email):
        response = self.post('/api/auth/logout/')
        self.assertEqual(response.status_code, 200, response.content)
        response = self.post('/api/auth/login/', {
            'email': email, 'password': 'GoodPassword123!',
        })
        self.assertEqual(response.status_code, 200, response.content)

    def send_channel(self, body):
        response = self.post(
            f'/api/channels/{self.channel.pk}/messages/', {'body': body},
        )
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def test_channel_mention_is_unique_and_markable(self):
        alice = self.add_person('alice@first.test', 'Alice Smith', team=True)
        self.send_channel('Hello @Alice Smith, thanks @Alice Smith!')
        self.assertEqual(
            MentionNotification.objects.filter(recipient=alice).count(), 1,
        )
        self.login(alice.email)
        response = self.client.get('/api/mentions/')
        self.assertEqual(response.status_code, 200, response.content)
        rows = response.json()['results']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['kind'], 'channel')
        self.assertEqual(rows[0]['source_id'], str(self.channel.pk))
        self.assertEqual(rows[0]['team_id'], str(self.team.pk))
        self.assertIsNone(rows[0]['read_at'])
        response = self.post(f"/api/mentions/{rows[0]['id']}/read/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.json()['read_at'])
        again = self.post(f"/api/mentions/{rows[0]['id']}/read/")
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json()['read_at'], response.json()['read_at'])
        self.assertIsNotNone(self.client.get('/api/mentions/').json()['results'][0]['read_at'])

    def test_no_mention_for_self_nonmember_or_other_company(self):
        self.add_person('alice@first.test', 'Alice Smith')  # not on team
        self.add_person('bob@first.test', 'Bob', team=True)
        second = Organization.objects.create(
            name='Second Company', slug='mentions-second-company',
            created_by=self.owner,
        )
        self.add_person('external@second.test', 'External Person', organization=second)
        self.send_channel('@Owner @Alice Smith @External Person and hello@Bob.test')
        self.assertEqual(MentionNotification.objects.count(), 0)
        self.send_channel('Hello @Bob!')
        self.assertEqual(MentionNotification.objects.count(), 1)

    def test_ambiguous_and_prefix_names_do_not_misroute(self):
        self.add_person('alex@first.test', 'Alex', team=True)
        self.add_person('alexsmith@first.test', 'Alex Smith', team=True)
        self.add_person('dup1@first.test', 'Sam', team=True)
        self.add_person('dup2@first.test', 'Sam', team=True)
        self.send_channel('Please help @Alex Smith and @Sam')
        self.assertEqual(
            list(MentionNotification.objects.values_list('recipient__email', flat=True)),
            ['alexsmith@first.test'],
        )
        self.send_channel('Only @Alex please')
        self.assertEqual(
            MentionNotification.objects.filter(recipient__email='alex@first.test').count(), 1,
        )

    def test_group_mention_only_appears_to_participants(self):
        alice = self.add_person('alice@first.test', 'Alice Smith')
        outsider = self.add_person('outsider@first.test', 'Outsider')
        helper = self.add_person('helper@first.test', 'Helper')
        response = self.post('/api/chats/', {
            'kind': 'group', 'title': 'Announcements', 'emails': [alice.email, helper.email],
        })
        self.assertEqual(response.status_code, 201, response.content)
        chat = response.json()
        sent = self.post(f"/api/chats/{chat['id']}/messages/", {
            'body': '@Alice Smith please review, not @Outsider.',
        })
        self.assertEqual(sent.status_code, 201, sent.content)
        notification = MentionNotification.objects.get()
        self.assertEqual(notification.recipient_id, alice.pk)
        self.login(outsider.email)
        self.assertEqual(self.client.get('/api/mentions/').json()['results'], [])
        self.assertEqual(
            self.post(f'/api/mentions/{notification.pk}/read/').status_code, 404,
        )
        self.login(alice.email)
        rows = self.client.get('/api/mentions/').json()['results']
        self.assertEqual(rows[0]['kind'], 'chat')
        self.assertEqual(rows[0]['chat_kind'], 'group')
        self.assertEqual(rows[0]['source_id'], chat['id'])

    def test_removed_chat_participant_cannot_see_old_mentions(self):
        alice = self.add_person('alice@first.test', 'Alice Smith')
        helper = self.add_person('helper@first.test', 'Helper')
        chat = self.post('/api/chats/', {
            'kind': 'group', 'title': 'Chat', 'emails': [alice.email, helper.email],
        }).json()
        self.post(f"/api/chats/{chat['id']}/messages/", {'body': 'Ping @Alice Smith'})
        notification = MentionNotification.objects.get()
        ChatParticipant.objects.filter(conversation_id=chat['id'], user=alice).delete()
        self.login(alice.email)
        self.assertEqual(self.client.get('/api/mentions/').json()['results'], [])
        self.assertEqual(
            self.post(f'/api/mentions/{notification.pk}/read/').status_code, 404,
        )
        ChatParticipant.objects.create(conversation_id=chat['id'], user=alice)
        self.assertEqual(self.client.get('/api/mentions/').json()['results'], [])

    def test_team_removal_hides_channel_mentions(self):
        alice = self.add_person('alice@first.test', 'Alice Smith', team=True)
        self.send_channel('Hi @Alice Smith')
        notification = MentionNotification.objects.get()
        TeamMember.objects.filter(team=self.team, user=alice).delete()
        self.login(alice.email)
        self.assertEqual(self.client.get('/api/mentions/').json()['results'], [])
        self.assertEqual(
            self.post(f'/api/mentions/{notification.pk}/read/').status_code, 404,
        )

    def test_active_workspace_switch_hides_other_workspace_mentions(self):
        alice = self.add_person('alice@first.test', 'Alice Smith', team=True)
        self.send_channel('Hello @Alice Smith')
        self.login(alice.email)
        self.assertEqual(len(self.client.get('/api/mentions/').json()['results']), 1)
        other = Organization.objects.create(
            name='Second Company', slug='mentions-different-company',
            created_by=self.owner,
        )
        OrganizationMember.objects.create(organization=other, user=alice)
        response = self.post(f'/api/organizations/{other.pk}/activate/')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.client.get('/api/mentions/').json()['results'], [])
        notification = MentionNotification.objects.get()
        self.assertEqual(
            self.post(f'/api/mentions/{notification.pk}/read/').status_code, 404,
        )

    def test_soft_deleted_group_message_is_not_a_visible_mention(self):
        alice = self.add_person('alice@first.test', 'Alice Smith')
        helper = self.add_person('helper@first.test', 'Helper')
        chat = self.post('/api/chats/', {
            'kind': 'group', 'title': 'Chat', 'emails': [alice.email, helper.email],
        }).json()
        message = self.post(f"/api/chats/{chat['id']}/messages/", {
            'body': '@Alice Smith please see this',
        }).json()
        notification = MentionNotification.objects.get()
        deleted = self.client.delete(
            f"/api/chats/{chat['id']}/messages/{message['id']}/",
            HTTP_X_CSRFTOKEN=self.csrf,
        )
        self.assertEqual(deleted.status_code, 204, deleted.content)
        self.login(alice.email)
        self.assertEqual(self.client.get('/api/mentions/').json()['results'], [])
        self.assertEqual(
            self.post(f'/api/mentions/{notification.pk}/read/').status_code, 404,
        )
