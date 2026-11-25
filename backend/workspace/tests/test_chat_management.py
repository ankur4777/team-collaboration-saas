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
        self.assertEqual(self.write('DELETE', f'/api/chats/{chat_id}/participants/{org.created_by_id}/').status_code, 403)

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

    def test_group_ownership_transfer_and_leave(self):
        org = self.register()
        first = self.user(org, 'first@company-a.test')
        second = self.user(org, 'second@company-a.test')
        outsider = self.user(org, 'outsider@company-a.test')
        chat = self.write('POST', '/api/chats/', {
            'kind': 'group', 'title': 'Transfer', 'emails': [first.email, second.email],
        }).json()
        chat_id = chat['id']
        base = f'/api/chats/{chat_id}/'
        self.assertEqual(self.write('POST', base + 'leave/').status_code, 400)
        self.assertEqual(self.write('POST', base + 'ownership/', {'user_id': str(outsider.pk)}).status_code, 400)
        self.assertEqual(self.write('POST', base + 'messages/', {'body': 'Keep this'}).status_code, 201)
        self.login(first.email)
        self.assertEqual(self.write('POST', base + 'ownership/', {'user_id': str(second.pk)}).status_code, 403)
        self.login('owner@company-a.test')
        self.assertEqual(self.write('POST', base + 'ownership/', {'user_id': str(first.pk)}).status_code, 204)
        self.assertEqual(ChatConversation.objects.get(pk=chat_id).created_by_id, first.pk)
        self.assertEqual(self.write('POST', base + 'leave/').status_code, 204)
        self.assertEqual(self.client.get(base + 'messages/').status_code, 404)
        self.assertTrue(ChatMessage.objects.filter(conversation_id=chat_id, body='Keep this').exists())
        self.login(first.email)
        self.assertEqual(self.write('POST', base + 'leave/').status_code, 400)
        self.assertEqual(self.write('POST', base + 'participants/', {'email': outsider.email}).status_code, 201)
        self.login(second.email)
        self.assertEqual(self.write('POST', base + 'leave/').status_code, 204)
        self.assertEqual(self.client.get(base + 'messages/').status_code, 404)

    def test_only_group_owner_can_rename(self):
        org = self.register()
        first = self.user(org, 'first@company-a.test')
        second = self.user(org, 'second@company-a.test')
        chat = self.write('POST', '/api/chats/', {
            'kind':'group', 'title':'Original', 'emails':[first.email, second.email],
        }).json()
        url = f"/api/chats/{chat['id']}/"
        self.assertEqual(self.write('PATCH', url, {'title':'x'}).status_code, 400)
        self.assertEqual(self.write('PATCH', url, {'title':'Renamed'}).status_code, 200)
        self.login(first.email)
        self.assertEqual(self.write('PATCH', url, {'title':'Forbidden'}).status_code, 403)
        self.assertEqual(self.client.get('/api/chats/').json()[0]['title'], 'Renamed')

    def test_reply_targets_require_visible_history_in_same_chat(self):
        org = self.register()
        a = self.user(org, 'alice@company-a.test')
        b = self.user(org, 'bob@company-a.test')
        late = self.user(org, 'late@company-a.test')
        group = self.write('POST', '/api/chats/', {'kind':'group','title':'Replies','emails':[a.email,b.email]}).json()
        url = f"/api/chats/{group['id']}/messages/"
        original = self.write('POST', url, {'body':'Original secret'}).json()
        sent = self.write('POST', url, {'body':'Reply','reply_to_id':original['id']})
        self.assertEqual(sent.status_code, 201, sent.content)
        self.assertEqual(sent.json()['reply_to_id'], original['id'])
        self.assertNotIn('Original secret', str(sent.json()))
        direct = self.write('POST','/api/chats/',{'kind':'direct','email':a.email}).json()
        other = f"/api/chats/{direct['id']}/messages/"
        self.assertEqual(self.write('POST', other, {'body':'Wrong','reply_to_id':original['id']}).status_code, 400)
        self.assertEqual(self.write('POST',f"/api/chats/{group['id']}/participants/",{'email':late.email}).status_code,201)
        self.login(late.email)
        self.assertEqual(self.write('POST',url,{'body':'Wrong','reply_to_id':original['id']}).status_code,400)
        self.login('owner@company-a.test')
        self.assertEqual(self.write('DELETE',url+original['id']+'/').status_code,204)
        self.assertEqual(self.write('POST',url,{'body':'Wrong','reply_to_id':original['id']}).status_code,400)

    def test_forward_text_between_accessible_conversations(self):
        org = self.register()
        a = self.user(org, 'alice@company-a.test')
        b = self.user(org, 'bob@company-a.test')
        chat = self.write('POST', '/api/chats/', {'kind':'direct','email':a.email}).json()
        dest = self.write('POST', '/api/chats/', {'kind':'direct','email':b.email}).json()
        original = self.write('POST', f"/api/chats/{chat['id']}/messages/", {'body':'Forward this'}).json()
        url = '/api/messages/forward/'
        payload = {'source_kind':'chat','source_id':chat['id'],'message_id':original['id'],
                   'destination_kind':'chat','destination_id':dest['id']}
        result = self.write('POST', url, payload)
        self.assertEqual(result.status_code, 201, result.content)
        self.assertEqual(result.json()['message']['body'], 'Forward this')
        self.assertTrue(result.json()['message']['is_forwarded'])
        self.assertIsNone(result.json()['message']['reply_to_id'])
        self.assertNotEqual(result.json()['message']['id'], original['id'])
        self.login(a.email)
        self.assertEqual(self.write('POST', url, payload).status_code, 404)
        self.login('owner@company-a.test')
        team = self.write('POST','/api/teams/',{'name':'Forward team'}).json()
        channel = self.client.get(f"/api/teams/{team['id']}/channels/").json()[0]
        to_channel = {**payload,'destination_kind':'channel','destination_id':channel['id']}
        forwarded = self.write('POST',url,to_channel)
        self.assertEqual(forwarded.status_code,201,forwarded.content)
        self.assertTrue(forwarded.json()['message']['is_forwarded'])
        reverse = {**payload,'source_kind':'channel','source_id':channel['id'],'message_id':forwarded.json()['message']['id']}
        self.assertEqual(self.write('POST',url,reverse).status_code,201)
        self.assertEqual(self.write('DELETE',f"/api/chats/{chat['id']}/messages/{original['id']}/").status_code,204)
        self.assertEqual(self.write('POST',url,payload).status_code,404)
        self.write('POST','/api/auth/logout/')
        self.register('other@company-b.test','Company B')
        self.assertEqual(self.client.get('/api/messages/forward/destinations/').json(),[])
        self.assertEqual(self.write('POST',url,payload).status_code,404)

    def test_shared_pins_respect_group_history_and_deletion(self):
        org = self.register()
        first = self.user(org, 'first@company-a.test')
        second = self.user(org, 'second@company-a.test')
        late = self.user(org, 'late@company-a.test')
        chat = self.write('POST', '/api/chats/', {'kind':'group','title':'Pins','emails':[first.email,second.email]}).json()
        base = f"/api/chats/{chat['id']}/"
        original = self.write('POST', base+'messages/', {'body':'Important'}).json()
        url = base+'messages/'+original['id']+'/pin/'
        self.assertEqual(self.write('POST',url,{'pinned':'true'}).status_code,400)
        self.assertEqual(self.write('POST',url,{'pinned':True}).status_code,200)
        self.assertEqual(self.write('POST',base+'participants/',{'email':late.email}).status_code,201)
        self.login(late.email)
        self.assertEqual(self.client.get(base+'pins/').json()['items'],[])
        self.assertEqual(self.write('POST',url,{'pinned':False}).status_code,404)
        self.login(first.email)
        self.assertEqual(self.client.get(base+'pins/').json()['items'][0]['id'],original['id'])
        self.assertEqual(self.write('POST',url,{'pinned':False}).status_code,200)
        self.assertEqual(self.client.get(base+'pins/').json()['items'],[])
        self.assertEqual(self.write('POST',url,{'pinned':True}).status_code,200)
        self.login('owner@company-a.test')
        self.assertEqual(self.write('DELETE',base+'messages/'+original['id']+'/').status_code,204)
        self.assertEqual(self.client.get(base+'pins/').json()['items'],[])
        self.assertIsNone(ChatMessage.objects.get(pk=original['id']).pinned_at)
        self.assertEqual(self.write('POST',url,{'pinned':True}).status_code,404)

    def test_chat_archive_is_personal_and_preserves_access(self):
        org = self.register()
        colleague = self.user(org, 'archive@company-a.test')
        chat = self.write('POST','/api/chats/',{'kind':'direct','email':colleague.email}).json()
        base = f"/api/chats/{chat['id']}/"
        self.assertEqual(self.write('POST',base+'messages/',{'body':'Keep this'}).status_code,201)
        self.assertEqual(self.write('POST',base+'archive/',{'archived':True}).status_code,200)
        self.assertIsNotNone(self.client.get('/api/chats/').json()[0]['archived_at'])
        self.login(colleague.email)
        self.assertIsNone(self.client.get('/api/chats/').json()[0]['archived_at'])
        self.assertEqual(self.write('POST',base+'messages/',{'body':'Still active'}).status_code,201)
        self.login('owner@company-a.test')
        self.assertEqual(len(self.client.get(base+'messages/').json()),2)
        self.assertEqual(self.write('POST',base+'archive/',{'archived':False}).status_code,200)
        self.assertIsNone(self.client.get('/api/chats/').json()[0]['archived_at'])

    def test_message_context_and_personal_preferences(self):
        org = self.register()
        colleague = self.user(org, 'context@company-a.test')
        chat = self.write('POST','/api/chats/',{'kind':'direct','email':colleague.email}).json()
        base = f"/api/chats/{chat['id']}/"
        original = self.write('POST',base+'messages/',{'body':'Find this'}).json()
        for i in range(12):
            self.write('POST',base+'messages/',{'body':f'Later {i}'})
        result = self.client.get(base+'messages/'+original['id']+'/context/')
        self.assertEqual(result.status_code,200)
        self.assertEqual(result.json()['items'][0]['id'],original['id'])
        self.assertEqual(len(result.json()['items']),11)
        self.assertEqual(self.write('POST',base+'preferences/',{'is_muted':True,'is_pinned':True}).status_code,200)
        self.assertTrue(self.client.get('/api/chats/').json()[0]['is_muted'])
        self.login(colleague.email)
        self.assertFalse(self.client.get('/api/chats/').json()[0]['is_muted'])
        self.assertFalse(self.client.get('/api/chats/').json()[0]['is_pinned'])
