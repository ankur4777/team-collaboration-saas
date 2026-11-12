"""Search returns only accessible workspace history, even after membership changes."""
import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from workspace.models import Organization, OrganizationMember


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class WorkspaceMessageSearchTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def post(self, path, body=None):
        response = self.client.post(
            path, data=json.dumps(body or {}), content_type='application/json',
            HTTP_X_CSRFTOKEN=self.csrf,
        )
        if response.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return response

    def register(self, email='owner@a.test', company='Company A'):
        response = self.post('/api/auth/register/', {
            'email': email, 'full_name': 'Owner',
            'password': 'GoodPassword123!', 'organization_name': company,
        })
        self.assertEqual(response.status_code, 201, response.content)
        return Organization.objects.get(pk=response.json()['active_organization_id'])

    def employee(self, org, email):
        user = get_user_model().objects.create_user(
            email=email, password='GoodPassword123!', full_name=email.split('@')[0],
        )
        OrganizationMember.objects.create(organization=org, user=user)
        return user

    def login(self, email):
        self.assertEqual(self.post('/api/auth/logout/').status_code, 200)
        result = self.post('/api/auth/login/', {'email': email, 'password': 'GoodPassword123!'})
        self.assertEqual(result.status_code, 200, result.content)

    def search(self, query, scope='all'):
        return self.client.get('/api/search/messages/', {'q': query, 'scope': scope})

    def test_requires_auth_and_valid_search(self):
        self.assertIn(self.search('ab').status_code, (401, 403))
        self.register()
        for term in ('', 'x', 'a' * 101):
            self.assertEqual(self.search(term).status_code, 400)
        self.assertEqual(self.search('hello', scope='invalid').status_code, 400)
        self.assertEqual(self.search('notfound').json(), {'results': [], 'limit': 50})

    def test_chat_search_respects_workspace_and_deletions(self):
        org = self.register()
        colleague = self.employee(org, 'colleague@a.test')
        outsider = self.employee(org, 'outsider@a.test')
        chat = self.post('/api/chats/', {'kind': 'direct', 'email': colleague.email})
        self.assertEqual(chat.status_code, 201, chat.content)
        chat_id = chat.json()['id']
        one = self.post(f'/api/chats/{chat_id}/messages/', {'body': 'Roadmap Q4 milestone'})
        deleted = self.post(f'/api/chats/{chat_id}/messages/', {'body': 'Roadmap confidential deleted'})
        self.assertEqual(one.status_code, 201, one.content)
        self.assertEqual(deleted.status_code, 201, deleted.content)
        result = self.search('roadmap')
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual([item['id'] for item in result.json()['results']], [
            deleted.json()['id'], one.json()['id'],
        ])
        self.assertEqual(result.json()['results'][0]['source'], 'chat')
        self.assertEqual(self.client.delete(
            f"/api/chats/{chat_id}/messages/{deleted.json()['id']}/",
            HTTP_X_CSRFTOKEN=self.csrf,
        ).status_code, 204)
        self.assertEqual([item['id'] for item in self.search('roadmap').json()['results']], [
            one.json()['id'],
        ])

        self.login(outsider.email)
        self.assertEqual(self.search('roadmap').json()['results'], [])
        self.login(colleague.email)
        self.assertEqual([item['id'] for item in self.search('roadmap').json()['results']], [
            one.json()['id'],
        ])
        self.login('owner@a.test')
        other_org = Organization.objects.create(
            name='Other company', slug='other-company', created_by=get_user_model().objects.get(email='owner@a.test'),
        )
        OrganizationMember.objects.create(
            organization=other_org, user=get_user_model().objects.get(email='owner@a.test'),
            role=OrganizationMember.Role.OWNER,
        )
        self.assertEqual(
            self.post(f'/api/organizations/{other_org.pk}/activate/').status_code, 200,
        )
        self.assertEqual(self.search('roadmap').json()['results'], [])
        self.assertNotEqual(org.pk, other_org.pk)

    def test_group_search_hides_messages_before_joining(self):
        org = self.register()
        first = self.employee(org, 'first@a.test')
        second = self.employee(org, 'second@a.test')
        late = self.employee(org, 'late@a.test')
        chat = self.post('/api/chats/', {
            'kind': 'group', 'title': 'Project',
            'emails': [first.email, second.email],
        })
        self.assertEqual(chat.status_code, 201, chat.content)
        chat_id = chat.json()['id']
        old = self.post(f'/api/chats/{chat_id}/messages/', {'body': 'Uniquegroup early'})
        added = self.post(f'/api/chats/{chat_id}/participants/', {'email': late.email})
        self.assertEqual(added.status_code, 201, added.content)
        latest = self.post(f'/api/chats/{chat_id}/messages/', {'body': 'Uniquegroup later'})
        self.assertEqual(old.status_code, 201)
        self.assertEqual(latest.status_code, 201)
        self.login(late.email)
        result = self.search('Uniquegroup')
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual([row['id'] for row in result.json()['results']], [latest.json()['id']])
        self.assertEqual(result.json()['results'][0]['chat_kind'], 'group')

    def test_channel_search_respects_team_membership_and_join_time(self):
        org = self.register()
        colleague = self.employee(org, 'colleague@a.test')
        spectator = self.employee(org, 'spectator@a.test')
        team = self.post('/api/teams/', {'name': 'Engineering'})
        self.assertEqual(team.status_code, 201, team.content)
        team_id = team.json()['id']
        channel_id = self.client.get(f'/api/teams/{team_id}/channels/').json()[0]['id']
        old = self.post(f'/api/channels/{channel_id}/messages/', {'body': 'Uniquechannel old'})
        self.assertEqual(old.status_code, 201)
        self.assertEqual(self.post(f'/api/teams/{team_id}/members/', {
            'email': colleague.email,
        }).status_code, 201)
        latest = self.post(f'/api/channels/{channel_id}/messages/', {'body': 'Uniquechannel new'})
        self.assertEqual(latest.status_code, 201)
        self.login(colleague.email)
        response = self.search('Uniquechannel', scope='channels')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual([row['id'] for row in response.json()['results']], [latest.json()['id']])
        self.assertEqual(response.json()['results'][0]['team_id'], team_id)
        self.assertEqual(self.search('Uniquechannel', scope='chats').json()['results'], [])
        self.login(spectator.email)
        self.assertEqual(self.search('Uniquechannel').json()['results'], [])

    def test_bounded_results_and_non_matching_scope(self):
        org = self.register()
        colleague = self.employee(org, 'colleague@a.test')
        chat = self.post('/api/chats/', {'kind':'direct', 'email':colleague.email})
        self.assertEqual(chat.status_code, 201)
        for number in range(52):
            self.assertEqual(self.post(
                f"/api/chats/{chat.json()['id']}/messages/",
                {'body':f'Searchable event {number}'},
            ).status_code, 201)
        results = self.search('searchable').json()['results']
        self.assertEqual(len(results), 50)
        self.assertIn('event 51', results[0]['excerpt'])
        self.assertEqual(self.search('searchable', 'channels').json()['results'], [])
