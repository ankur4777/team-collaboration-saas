"""Chat unread counts, read receipts and company isolation."""
import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings
from workspace.models import ChatParticipant, Organization, OrganizationMember


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class ChatUnreadTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def post(self, path, data=None):
        res = self.client.post(
            path, data=json.dumps(data or {}), content_type='application/json',
            HTTP_X_CSRFTOKEN=self.csrf,
        )
        if res.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return res

    def register(self, email='owner@company-a.test', company='Company A'):
        res = self.post('/api/auth/register/', {
            'email': email, 'full_name': 'Owner', 'password': 'GoodPassword123!',
            'organization_name': company,
        })
        self.assertEqual(res.status_code, 201, res.content)
        return Organization.objects.get(pk=res.json()['active_organization_id'])

    def colleague(self, org, email):
        user = get_user_model().objects.create_user(
            email=email, password='GoodPassword123!', full_name=email.split('@')[0],
        )
        OrganizationMember.objects.create(organization=org, user=user)
        return user

    def login(self, email):
        out = self.post('/api/auth/logout/')
        self.assertEqual(out.status_code, 200, out.content)
        res = self.post('/api/auth/login/', {'email': email, 'password': 'GoodPassword123!'})
        self.assertEqual(res.status_code, 200, res.content)

    def test_unread_receipts_are_explicit_and_monotonic(self):
        org = self.register()
        other = self.colleague(org, 'colleague@company-a.test')
        created = self.post('/api/chats/', {'kind': 'direct', 'email': other.email})
        self.assertEqual(created.status_code, 201)
        chat_id = created.json()['id']
        one = self.post(f'/api/chats/{chat_id}/messages/', {'body': 'First note'}).json()
        two = self.post(f'/api/chats/{chat_id}/messages/', {'body': 'Second note'}).json()
        self.assertEqual(self.client.get('/api/chats/').json()[0]['unread_count'], 0)
        self.login(other.email)
        chat = self.client.get('/api/chats/').json()[0]
        self.assertEqual(chat['unread_count'], 2)
        self.assertIsNone(next(p for p in chat['participants'] if p['user']['id'] == str(other.id))['last_read_at'])
        self.assertEqual(
            self.client.post(f'/api/chats/{chat_id}/read/', data='{}',
                             content_type='application/json').status_code, 403
        )
        read = self.post(f'/api/chats/{chat_id}/read/', {'message_id': one['id']})
        self.assertEqual(read.status_code, 200, read.content)
        self.assertEqual(self.client.get('/api/chats/').json()[0]['unread_count'], 1)
        cursor = read.json()['last_read_at']
        self.assertEqual(self.post(f'/api/chats/{chat_id}/read/', {'message_id': one['id']}).json()['last_read_at'], cursor)
        final = self.post(f'/api/chats/{chat_id}/read/', {'message_id': two['id']})
        self.assertEqual(final.status_code, 200, final.content)
        self.assertEqual(self.client.get('/api/chats/').json()[0]['unread_count'], 0)
        self.assertIsNotNone(ChatParticipant.objects.get(conversation_id=chat_id, user=other).last_read_at)
        self.login('owner@company-a.test')
        mine = self.client.get('/api/chats/').json()[0]
        self.assertEqual(mine['unread_count'], 0)
        self.assertIsNotNone(next(p for p in mine['participants'] if p['user']['id'] == str(other.id))['last_read_at'])

    def test_group_newcomers_exclude_prejoin_history_and_reads(self):
        org = self.register()
        first = self.colleague(org, 'first@company-a.test')
        second = self.colleague(org, 'second@company-a.test')
        third = self.colleague(org, 'third@company-a.test')
        group = self.post('/api/chats/', {
            'kind': 'group', 'title': 'Team Chat', 'emails': [first.email, second.email],
        })
        self.assertEqual(group.status_code, 201)
        chat_id = group.json()['id']
        before = self.post(f'/api/chats/{chat_id}/messages/', {'body': 'Before join'}).json()
        added = self.post(f'/api/chats/{chat_id}/participants/', {'email': third.email})
        self.assertEqual(added.status_code, 201)
        after = self.post(f'/api/chats/{chat_id}/messages/', {'body': 'After join'}).json()
        self.login(third.email)
        self.assertEqual(self.client.get('/api/chats/').json()[0]['unread_count'], 1)
        self.assertEqual(self.post(f'/api/chats/{chat_id}/read/', {'message_id': before['id']}).status_code, 400)
        self.assertEqual(self.post(f'/api/chats/{chat_id}/read/', {'message_id': after['id']}).status_code, 200)
        self.assertEqual(self.client.get('/api/chats/').json()[0]['unread_count'], 0)

    def test_cross_company_user_cannot_mark_private_chat_read(self):
        org = self.register()
        target = self.colleague(org, 'other@company-a.test')
        chat = self.post('/api/chats/', {'kind': 'direct', 'email': target.email}).json()
        message = self.post(f'/api/chats/{chat["id"]}/messages/', {'body': 'Not for Company B'}).json()
        self.post('/api/auth/logout/')
        self.register('owner@company-b.test', 'Company B')
        self.assertEqual(self.client.get('/api/chats/').json(), [])
        self.assertEqual(
            self.post(f'/api/chats/{chat["id"]}/read/', {'message_id': message['id']}).status_code, 404
        )
