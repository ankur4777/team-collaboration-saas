"""Tests for member-safe private message actions and group participant changes."""
import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings
from workspace.models import ChatConversation, ChatMessage, ChatParticipant, Organization, OrganizationMember


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class ChatManagementTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def write(self, method, path, data=None):
        response = self.client.generic(
            method, path, data=json.dumps(data or {}),
            content_type='application/json', HTTP_X_CSRFTOKEN=self.csrf,
        )
        if response.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return response

    def register(self, email='owner@company-a.test', org='Company A'):
        result = self.write('POST', '/api/auth/register/', {
            'email': email, 'password': 'SafePass123!2026', 'full_name': 'Owner',
            'organization_name': org,
        })
        self.assertEqual(result.status_code, 201, result.content)
        return Organization.objects.get(id=result.json()['active_organization_id'])

    def user(self, org, email):
        user = get_user_model().objects.create_user(
            email=email, password='SafePass123!2026', full_name=email.split('@')[0],
        )
        OrganizationMember.objects.create(organization=org, user=user)
        return user

    def login(self, email):
        self.assertEqual(self.write('POST', '/api/auth/logout/').status_code, 200)
        result = self.write('POST', '/api/auth/login/', {'email': email, 'password': 'SafePass123!2026'})
        self.assertEqual(result.status_code, 200, result.content)

    def test_author_edits_and_soft_deletes_message(self):
        org = self.register()
        colleague = self.user(org, 'colleague@company-a.test')
        chat = self.write('POST', '/api/chats/', {'kind': 'direct', 'email': colleague.email}).json()
        chat_id = chat['id']
        created = self.write('POST', f'/api/chats/{chat_id}/messages/', {'body': 'Initial note'})
        self.assertEqual(created.status_code, 201, created.content)
        message_id = created.json()['id']
        url = f'/api/chats/{chat_id}/messages/{message_id}/'

        edited = self.write('PATCH', url, {'body': 'Updated note'})
        self.assertEqual(edited.status_code, 200, edited.content)
        self.assertEqual(edited.json()['body'], 'Updated note')
        self.assertIsNotNone(edited.json()['edited_at'])
        self.assertIsNone(edited.json()['deleted_at'])
        self.assertEqual(ChatMessage.objects.get(pk=message_id).body, 'Updated note')

        deleted = self.write('DELETE', url)
        self.assertEqual(deleted.status_code, 204, deleted.content)
        self.assertEqual(self.write('DELETE', url).status_code, 204)
        msg = ChatMessage.objects.get(pk=message_id)
        self.assertEqual(msg.body, '')
        self.assertIsNotNone(msg.deleted_at)
        self.assertEqual(self.write('PATCH', url, {'body': 'Restored'}).status_code, 400)
        response = self.client.get(f'/api/chats/{chat_id}/messages/').json()
        self.assertEqual(response[0]['body'], '')
        self.assertIsNotNone(response[0]['deleted_at'])

    def test_other_member_and_other_company_cannot_edit_or_delete(self):
        org = self.register()
        colleague = self.user(org, 'colleague@company-a.test')
        chat = self.write('POST', '/api/chats/', {'kind': 'direct', 'email': colleague.email}).json()
        chat_id = chat['id']
        msg_id = self.write('POST', f'/api/chats/{chat_id}/messages/', {'body': 'Only my note'}).json()['id']
        url = f'/api/chats/{chat_id}/messages/{msg_id}/'

        self.login(colleague.email)
        self.assertEqual(self.write('PATCH', url, {'body': 'Tamper'}).status_code, 403)
        self.assertEqual(self.write('DELETE', url).status_code, 403)

        self.write('POST', '/api/auth/logout/')
        self.register('other@company-b.test', 'Company B')
        self.assertEqual(self.write('PATCH', url, {'body': 'Outside'}).status_code, 404)
        self.assertEqual(self.write('DELETE', url).status_code, 404)
        self.assertEqual(ChatMessage.objects.get(pk=msg_id).body, 'Only my note')

    def test_only_group_creator_manages_participants_and_newcomers_cannot_read_past(self):
        org = self.register()
        first = self.user(org, 'first@company-a.test')
        second = self.user(org, 'second@company-a.test')
        third = self.user(org, 'third@company-a.test')
        chat = self.write('POST', '/api/chats/', {
            'kind': 'group', 'title': 'Engineering', 'emails': [first.email, second.email],
        })
        self.assertEqual(chat.status_code, 201, chat.content)
        chat_id = chat.json()['id']
        before = self.write('POST', f'/api/chats/{chat_id}/messages/', {'body': 'Before arrival'})
        self.assertEqual(before.status_code, 201)
        url = f'/api/chats/{chat_id}/participants/'

        added = self.write('POST', url, {'email': third.email})
        self.assertEqual(added.status_code, 201, added.content)
        self.assertEqual(len(added.json()['participants']), 4)
        self.assertEqual(self.write('POST', url, {'email': third.email}).status_code, 400)
        self.assertEqual(self.write('POST', url, {'email': 'outsider@other.test'}).status_code, 400)
        self.assertEqual(self.write('DELETE', f'/api/chats/{chat_id}/participants/{chat.json()["participants"][0]["user"]["id"]}/').status_code, 403)

        self.login(third.email)
        old = self.client.get(f'/api/chats/{chat_id}/messages/')
        self.assertEqual(old.status_code, 200)
        self.assertEqual(old.json(), [])
        self.assertEqual(self.write('POST', url, {'email': 'unused@company-a.test'}).status_code, 403)
        self.assertEqual(self.write('POST', f'/api/chats/{chat_id}/messages/', {'body': 'New message'}).status_code, 201)
        self.assertEqual([x['body'] for x in self.client.get(f'/api/chats/{chat_id}/messages/').json()], ['New message'])

        self.login('owner@company-a.test')
        removed = self.write('DELETE', f'/api/chats/{chat_id}/participants/{third.id}/')
        self.assertEqual(removed.status_code, 204, removed.content)
        self.assertFalse(ChatParticipant.objects.filter(conversation_id=chat_id, user=third).exists())
        self.login(third.email)
        self.assertEqual(self.client.get(f'/api/chats/{chat_id}/messages/').status_code, 404)

    def test_direct_chat_cannot_have_participants_manually_added(self):
        org = self.register()
        colleague = self.user(org, 'colleague@company-a.test')
        direct = self.write('POST', '/api/chats/', {'kind':'direct', 'email':colleague.email}).json()
        self.assertEqual(self.write('POST', f'/api/chats/{direct["id"]}/participants/',
                                    {'email': colleague.email}).status_code, 400)
