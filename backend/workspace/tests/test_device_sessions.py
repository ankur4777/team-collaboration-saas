"""Account-wide device session revocation and migration-safe logout tests."""
import json

from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.test import Client, TestCase, override_settings

from workspace.device_sessions import GENERATION_KEY, live_websocket_session
from workspace.models import AccountSession, Organization, OrganizationMember


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class AccountSessionTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        self.email = 'owner@alpha.test'
        self.password = 'SafePassword12345!'

    def write(self, client, method, path, body=None, csrf=None):
        if csrf is None:
            csrf = client.get('/api/auth/csrf/').json()['csrf_token']
        return client.generic(
            method, path, data=json.dumps(body or {}),
            content_type='application/json',
            HTTP_X_CSRFTOKEN=csrf,
        )

    def register(self):
        result = self.write(self.client, 'POST', '/api/auth/register/', {
            'email': self.email, 'password': self.password,
            'full_name': 'Owner', 'organization_name': 'Alpha Workspace',
        }, csrf=self.csrf)
        self.assertEqual(result.status_code, 201, result.content)
        return result

    def other_client(self, agent='Firefox Test Browser'):
        client = Client(enforce_csrf_checks=True, HTTP_USER_AGENT=agent)
        result = self.write(client, 'POST', '/api/auth/login/', {
            'email': self.email, 'password': self.password,
        })
        self.assertEqual(result.status_code, 200, result.content)
        return client

    def test_lists_two_sessions_without_disclosing_session_keys(self):
        self.register()
        second = self.other_client()
        result = self.client.get('/api/auth/sessions/')
        self.assertEqual(result.status_code, 200, result.content)
        entries = result.json()
        self.assertEqual(len(entries), 2, entries)
        self.assertEqual(sum(item['current'] for item in entries), 1)
        self.assertTrue(any('Firefox' in item['user_agent'] for item in entries))
        self.assertNotIn('session_key', result.content.decode())
        self.assertEqual(len(second.get('/api/auth/sessions/').json()), 2)

    def test_revoke_selected_device_blocks_http_and_websocket_data(self):
        self.register()
        second = self.other_client()
        sessions = self.client.get('/api/auth/sessions/').json()
        other = next(item for item in sessions if not item['current'])
        old_key = second.session.session_key
        self.assertTrue(Session.objects.filter(session_key=old_key).exists())
        owner = get_user_model().objects.get(email=self.email)
        self.assertTrue(live_websocket_session(owner.pk, old_key, 0))
        path = f'/api/auth/sessions/{other["id"]}/'
        self.assertEqual(self.write(self.client, 'DELETE', path, csrf='bogus').status_code, 403)
        self.assertEqual(self.write(self.client, 'DELETE', path).status_code, 204)
        self.assertFalse(Session.objects.filter(session_key=old_key).exists())
        self.assertFalse(live_websocket_session(owner.pk, old_key, 0))
        self.assertEqual(second.get('/api/auth/me/').status_code, 401)
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 200)
        self.assertEqual(self.write(self.client, 'DELETE', path).status_code, 404)

    def test_sign_out_other_devices_invalidates_untracked_preupgrade_sessions(self):
        self.register()
        second = self.other_client()
        old_key = second.session.session_key
        # Simulate a session from before this feature was deployed: no version.
        old_session = second.session
        old_session.pop(GENERATION_KEY, None)
        old_session.save()
        # Older browsers also may not have a metadata registry row.
        AccountSession.objects.filter(session_key=old_key).delete()
        entry = self.client.get('/api/auth/sessions/').json()
        self.assertEqual(len(entry), 1)
        self.assertTrue(Session.objects.filter(session_key=old_key).exists())
        response = self.write(
            self.client, 'POST', '/api/auth/sessions/sign-out-others/',
            csrf='bad',
        )
        self.assertEqual(response.status_code, 403)
        response = self.write(
            self.client, 'POST', '/api/auth/sessions/sign-out-others/',
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 200)
        self.assertEqual(second.get('/api/auth/me/').status_code, 401)
        self.assertFalse(live_websocket_session(
            get_user_model().objects.get(email=self.email).pk, old_key, 0,
        ))
        self.assertEqual(len(self.client.get('/api/auth/sessions/').json()), 1)
        self.assertEqual(get_user_model().objects.get(email=self.email).session_generation, 1)
        # The same credentials can create a fresh, valid post-rotation session.
        new_client = self.other_client('Edge Fresh Browser')
        self.assertEqual(new_client.get('/api/auth/me/').status_code, 200)
        self.assertEqual(len(self.client.get('/api/auth/sessions/').json()), 2)

    def test_revoke_self_rejected_and_other_account_isolated(self):
        self.register()
        owner_id = self.client.get('/api/auth/sessions/').json()[0]['id']
        response = self.write(self.client, 'DELETE', f'/api/auth/sessions/{owner_id}/')
        self.assertEqual(response.status_code, 400, response.content)
        user = get_user_model().objects.create_user(
            email='outsider@beta.test', password='OutsiderPassword123!',
            full_name='Outsider',
        )
        # Different company, different account. Nobody can enumerate or
        # revoke the owner's devices by supplying a guessed UUID.
        org = Organization.objects.create(
            name='Beta Workspace', slug='beta-workspace', created_by=user,
        )
        OrganizationMember.objects.create(
            organization=org, user=user, role=OrganizationMember.Role.OWNER,
        )
        another = Client(enforce_csrf_checks=True)
        self.write(another, 'POST', '/api/auth/login/', {
            'email':user.email,'password':'OutsiderPassword123!',
        })
        self.assertEqual(len(another.get('/api/auth/sessions/').json()), 1)
        self.assertEqual(self.write(
            another, 'DELETE', f'/api/auth/sessions/{owner_id}/',
        ).status_code, 404)
        self.assertIsNone(AccountSession.objects.get(pk=owner_id).revoked_at)

    def test_logout_marks_record_revoked_and_password_change_rotates_session(self):
        self.register()
        other = self.other_client()
        old_key = other.session.session_key
        current_key = self.client.session.session_key
        response = self.write(self.client, 'POST', '/api/auth/password-change/', {
            'current_password':self.password,'new_password':'NewPasswordStrong123!',
        })
        self.assertEqual(response.status_code, 200, response.content)
        self.assertNotEqual(self.client.session.session_key, current_key)
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 200)
        self.assertEqual(other.get('/api/auth/me/').status_code, 401)
        self.assertFalse(Session.objects.filter(session_key=old_key).exists())
        self.assertEqual(len(self.client.get('/api/auth/sessions/').json()), 1)
        current_record = self.client.get('/api/auth/sessions/').json()[0]
        self.assertTrue(current_record['current'])
        self.assertEqual(self.write(self.client, 'POST', '/api/auth/logout/').status_code, 200)
        self.assertIsNotNone(AccountSession.objects.get(pk=current_record['id']).revoked_at)
