"""Private-chat API regression tests, including cross-organization isolation."""
import json
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from workspace.models import (
    ChatConversation, ChatMessage, ChatParticipant, Organization, OrganizationMember,
)


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class PrivateChatTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def post(self, url, body=None):
        response = self.client.post(
            url, data=json.dumps(body or {}), content_type='application/json',
            HTTP_X_CSRFTOKEN=self.csrf,
        )
        if response.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return response

    def delete(self, url):
        return self.client.delete(url, content_type='application/json',
                                  HTTP_X_CSRFTOKEN=self.csrf)

    def register(self, email='owner@company-a.test', company='Company A'):
        response = self.post('/api/auth/register/', {
            'email': email, 'password': 'GoodPassword123!',
            'full_name': 'Owner', 'organization_name': company,
        })
        self.assertEqual(response.status_code, 201, response.content)
        return Organization.objects.get(id=response.json()['active_organization_id'])

    def staff(self, org, email):
        user = get_user_model().objects.create_user(
            email=email, password='GoodPassword123!', full_name=email.split('@')[0],
        )
        member = OrganizationMember.objects.create(organization=org, user=user)
        return user, member

    def test_direct_is_idempotent_and_messages_are_accessible_to_members(self):
        org = self.register()
        other, _ = self.staff(org, 'friend@company-a.test')
        first = self.post('/api/chats/', {'kind': 'direct', 'email': other.email})
        self.assertEqual(first.status_code, 201, first.content)
        second = self.post('/api/chats/', {'kind': 'direct', 'email': other.email})
        self.assertEqual(second.status_code, 200, second.content)
        self.assertEqual(first.json()['id'], second.json()['id'])
        chat_id = first.json()['id']
        self.assertEqual(len(first.json()['participants']), 2)
        self.assertEqual(ChatConversation.objects.count(), 1)
        self.assertEqual(self.post('/api/chats/', {
            'kind': 'direct', 'email': 'not-in-workspace@example.test'
        }).status_code, 400)
        saved = self.post(f'/api/chats/{chat_id}/messages/', {'body': 'Hello!'})
        self.assertEqual(saved.status_code, 201, saved.content)
        self.assertEqual(saved.json()['body'], 'Hello!')
        self.assertEqual(self.client.get(f'/api/chats/{chat_id}/messages/').json()[0]['body'], 'Hello!')
        self.assertEqual(len(self.client.get('/api/chats/').json()), 1)
        self.assertEqual(ChatMessage.objects.count(), 1)

    def test_group_chat_requires_two_other_active_workspace_members(self):
        org = self.register()
        u1, _ = self.staff(org, 'a@company-a.test')
        u2, _ = self.staff(org, 'b@company-a.test')
        chat = self.post('/api/chats/', {
            'kind': 'group', 'title': 'Engineering',
            'emails': [u1.email, u2.email],
        })
        self.assertEqual(chat.status_code, 201, chat.content)
        self.assertEqual(chat.json()['kind'], 'group')
        self.assertEqual(len(chat.json()['participants']), 3)
        self.assertEqual(self.post('/api/chats/', {
            'kind': 'group', 'title': 'Duplicate', 'emails': [u1.email, u1.email],
        }).status_code, 400)
        self.assertEqual(self.post('/api/chats/', {
            'kind': 'group', 'title': 'Invalid',
            'emails': [u1.email, 'outside@company-b.test'],
        }).status_code, 400)
        self.assertEqual(self.post(f"/api/chats/{chat.json()['id']}/messages/", {
            'body': 'Group kickoff',
        }).status_code, 201)

    def test_other_company_cannot_see_or_post_private_messages(self):
        org = self.register()
        user, _ = self.staff(org, 'friend@company-a.test')
        created = self.post('/api/chats/', {'kind': 'direct', 'email': user.email})
        chat_id = created.json()['id']
        self.post('/api/auth/logout/')
        other_org = self.register('owner@company-b.test', 'Company B')
        self.assertNotEqual(org.pk, other_org.pk)
        self.assertEqual(self.client.get('/api/chats/').json(), [])
        self.assertEqual(self.client.get(f'/api/chats/{chat_id}/messages/').status_code, 404)
        self.assertEqual(self.post(f'/api/chats/{chat_id}/messages/', {'body': 'No access'}).status_code, 404)
        self.assertEqual(self.post('/api/chats/', {'kind': 'direct', 'email': user.email}).status_code, 400)

    def test_removed_employee_cannot_rejoin_old_chat_history(self):
        org = self.register()
        user, membership = self.staff(org, 'exstaff@company-a.test')
        direct = self.post('/api/chats/', {'kind': 'direct', 'email': user.email}).json()
        self.post(f"/api/chats/{direct['id']}/messages/", {'body': 'Historical message'})
        result = self.delete(f'/api/organizations/{org.pk}/members/{membership.pk}/')
        self.assertEqual(result.status_code, 204, result.content)
        self.assertFalse(ChatParticipant.objects.filter(
            conversation_id=direct['id'], user=user,
        ).exists())
        old = ChatConversation.objects.get(pk=direct['id'])
        self.assertIsNone(old.direct_key)

        # A fresh company invitation must not restore old private messages.
        OrganizationMember.objects.create(organization=org, user=user)
        new_chat = self.post('/api/chats/', {'kind': 'direct', 'email': user.email})
        self.assertEqual(new_chat.status_code, 201, new_chat.content)
        self.assertNotEqual(new_chat.json()['id'], direct['id'])
        self.assertEqual(self.client.get(f"/api/chats/{new_chat.json()['id']}/messages/").json(), [])

    def test_chat_history_pages_preserve_tied_timestamps_and_legacy_response(self):
        org = self.register()
        colleague, _ = self.staff(org, 'friend@company-a.test')
        chat = self.post('/api/chats/', {'kind': 'direct', 'email': colleague.email}).json()
        chat_id = chat['id']
        ChatMessage.objects.bulk_create([
            ChatMessage(conversation_id=chat_id, sender=org.created_by, body=f'History {i}')
            for i in range(121)
        ])
        ChatMessage.objects.filter(conversation_id=chat_id).update(created_at=timezone.now())
        url = f'/api/chats/{chat_id}/messages/'
        self.assertEqual(len(self.client.get(url).json()), 50)
        seen = set()
        cursor = {}
        for size in (50, 50, 21):
            response = self.client.get(url, {'page': '1', **cursor})
            self.assertEqual(response.status_code, 200, response.content)
            page = response.json()
            self.assertEqual(len(page['items']), size)
            ids = [row['id'] for row in page['items']]
            self.assertEqual(ids, sorted(ids))
            self.assertFalse(seen.intersection(ids))
            seen.update(ids)
            cursor = page['next_cursor']
            self.assertEqual(bool(cursor), page['has_more'])
        self.assertEqual(len(seen), 121)
        self.assertIsNone(cursor)
        for query in ({'page': '2'}, {'page': '1', 'before_id': 'invalid'},
                      {'page': '1', 'before': '2026-02-31T12:00:00Z'},
                      {'page': '1', 'before': '2026-01-01T12:00:00Z', 'before_id': 'bad'}):
            self.assertEqual(self.client.get(url, query).status_code, 400)

    def test_group_history_pages_and_mutations_respect_rejoin_boundary(self):
        org = self.register()
        a, _ = self.staff(org, 'alice@company-a.test')
        b, _ = self.staff(org, 'bob@company-a.test')
        chat_id = self.post('/api/chats/', {
            'kind': 'group', 'title': 'History', 'emails': [a.email, b.email],
        }).json()['id']
        hidden = ChatMessage.objects.create(conversation_id=chat_id, sender=org.created_by, body='Before rejoin')
        ChatMessage.objects.filter(pk=hidden.pk).update(created_at=timezone.now()-timedelta(days=1))
        url = f'/api/chats/{chat_id}/messages/'
        visible = self.post(url, {'body': 'Visible'}).json()
        page = self.client.get(url, {'page': '1'}).json()
        self.assertEqual([row['id'] for row in page['items']], [visible['id']])
        self.assertIsNone(page['next_cursor'])
        detail = url + f'{hidden.pk}/'
        edited = self.client.patch(detail, data=json.dumps({'body': 'Not permitted'}),
                                   content_type='application/json', HTTP_X_CSRFTOKEN=self.csrf)
        self.assertEqual(edited.status_code, 404)
        self.assertEqual(self.delete(detail).status_code, 404)
        self.post('/api/auth/logout/')
        self.register('owner@company-b.test', 'Company B')
        self.assertEqual(self.client.get(url, {'page': '1'}).status_code, 404)
