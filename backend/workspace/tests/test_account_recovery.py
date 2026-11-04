"""Account verification and password reset security tests."""
import json
import time
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.test import Client, TestCase, override_settings


@override_settings(
    EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend',
    FRONTEND_ORIGIN='http://localhost:5173',
)
class AccountRecoveryTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def post(self, path, data=None, csrf=True):
        kwargs = {'HTTP_X_CSRFTOKEN': self.csrf} if csrf else {}
        res = self.client.post(
            path, data=json.dumps(data or {}), content_type='application/json',
            **kwargs,
        )
        if res.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return res

    def register(self, email='owner@workspace.test'):
        res = self.post('/api/auth/register/', {
            'email': email, 'password': 'ExampleStrongPassword2026!',
            'full_name': 'Workspace Owner', 'organization_name': 'Example Workspace',
        })
        self.assertEqual(res.status_code, 201, res.content)
        return res

    def link_fields(self, message):
        link = next(line.strip() for line in message.body.splitlines()
                    if line.strip().startswith('http://localhost:5173/'))
        parsed = urlparse(link)
        return parsed.path, parse_qs(parsed.query)

    def test_register_verify_once_and_session_state(self):
        session = self.register()
        self.assertFalse(session.json()['user']['email_verified'])
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn('Verify your TeamWorkspace', mail.outbox[0].subject)
        path, params = self.link_fields(mail.outbox[0])
        self.assertEqual(path, '/verify-email')
        token = params['token'][0]
        self.assertEqual(self.post('/api/auth/verify-email/', {'token':token}, csrf=False).status_code, 403)
        self.assertEqual(self.post('/api/auth/verify-email/', {'token':token+'tampered'}).status_code, 400)
        verified = self.post('/api/auth/verify-email/', {'token':token})
        self.assertEqual(verified.status_code, 200, verified.content)
        self.assertTrue(self.client.get('/api/auth/me/').json()['user']['email_verified'])
        self.assertEqual(self.post('/api/auth/verify-email/', {'token':token}).status_code, 400)

    def test_token_expires_and_resend_is_authenticated_and_throttled(self):
        self.register()
        _, params = self.link_fields(mail.outbox[0])
        token = params['token'][0]
        from django.core import signing
        future = time.time() + 25*60*60
        with patch.object(signing.time, 'time', return_value=future):
            res = self.post('/api/auth/verify-email/', {'token':token})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(self.post('/api/auth/verify-email/resend/', {}, csrf=False).status_code, 403)
        for _ in range(3):
            self.assertEqual(self.post('/api/auth/verify-email/resend/').status_code, 200)
        self.assertEqual(self.post('/api/auth/verify-email/resend/').status_code, 429)
        self.post('/api/auth/logout/')
        self.assertEqual(self.post('/api/auth/verify-email/resend/').status_code, 401)

    def test_reset_is_generic_single_use_and_revokes_current_session(self):
        self.register()
        before = len(mail.outbox)
        unknown = self.post('/api/auth/password-reset/request/', {'email':'unknown@workspace.test'})
        known = self.post('/api/auth/password-reset/request/', {'email':'owner@workspace.test'})
        self.assertEqual(unknown.status_code, 200)
        self.assertEqual(known.status_code, 200)
        self.assertEqual(unknown.json(), known.json())
        self.assertEqual(len(mail.outbox), before + 1)

        path, params = self.link_fields(mail.outbox[-1])
        self.assertEqual(path, '/reset-password')
        uid, token = params['uid'][0], params['token'][0]
        self.assertEqual(self.post('/api/auth/password-reset/confirm/', {
            'uid':uid, 'token':token, 'password':'NewStrongPassword2026!',
        }, csrf=False).status_code, 403)
        self.assertEqual(self.post('/api/auth/password-reset/confirm/', {
            'uid':uid, 'token':token+'x', 'password':'NewStrongPassword2026!',
        }).status_code, 400)
        self.assertEqual(self.post('/api/auth/password-reset/confirm/', {
            'uid':uid, 'token':token, 'password':'12345',
        }).status_code, 400)
        changed = self.post('/api/auth/password-reset/confirm/', {
            'uid':uid, 'token':token, 'password':'NewStrongPassword2026!',
        })
        self.assertEqual(changed.status_code, 200, changed.content)
        self.assertEqual(self.post('/api/auth/password-reset/confirm/', {
            'uid':uid, 'token':token, 'password':'AnotherStrongPassword2026!',
        }).status_code, 400)
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 401)

        old_login = self.post('/api/auth/login/', {
            'email':'owner@workspace.test', 'password':'ExampleStrongPassword2026!',
        })
        self.assertEqual(old_login.status_code, 401)
        new_login = self.post('/api/auth/login/', {
            'email':'owner@workspace.test', 'password':'NewStrongPassword2026!',
        })
        self.assertEqual(new_login.status_code, 200, new_login.content)

    def test_reset_rate_limit_and_bad_ids(self):
        self.register()
        self.assertEqual(self.post('/api/auth/password-reset/request/', {'email':'owner@workspace.test'}, csrf=False).status_code, 403)
        for _ in range(3):
            self.assertEqual(self.post('/api/auth/password-reset/request/', {'email':'owner@workspace.test'}).status_code, 200)
        self.assertEqual(self.post('/api/auth/password-reset/request/', {'email':'owner@workspace.test'}).status_code, 429)
        self.assertEqual(self.post('/api/auth/password-reset/confirm/', {
            'uid':'bad', 'token':'bogus', 'password':'NewStrongPassword2026!',
        }).status_code, 400)

    def test_invitation_redemption_confirms_mailbox(self):
        session = self.register('admin@company.test')
        org_id = session.json()['active_organization_id']
        invite = self.post(f'/api/organizations/{org_id}/invitations/', {
            'email':'invitee@company.test',
        })
        self.assertEqual(invite.status_code, 201, invite.content)
        link = invite.json().get('development_invite_url')
        if not link:
            link = next(line.strip() for line in mail.outbox[-1].body.splitlines()
                        if line.strip().startswith('http'))
        token = parse_qs(urlparse(link).query)['token'][0]
        self.post('/api/auth/logout/')
        accepted = self.post(f'/api/invitations/{token}/accept/', {
            'full_name':'Invited Teammate',
            'password':'InvitedPassword2026!',
        })
        self.assertEqual(accepted.status_code, 200, accepted.content)
        self.assertTrue(accepted.json()['user']['email_verified'])
        self.assertIsNotNone(get_user_model().objects.get(email='invitee@company.test').email_verified_at)
