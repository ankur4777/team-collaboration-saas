"""Settings security: current-password proof, CSRF, session invalidation, tenant scoping."""
import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from workspace.models import NotificationPreference, Organization, OrganizationMember


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class AccountSettingsTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        self.email = 'owner@first.test'
        self.password = 'StrongOldPassword2026!'

    def write(self, method, path, data=None, csrf=True, client=None, token=None):
        client = client or self.client
        kwargs = {'HTTP_X_CSRFTOKEN': token or self.csrf} if csrf else {}
        response = client.generic(
            method, path, data=json.dumps(data or {}),
            content_type='application/json', **kwargs,
        )
        if client is self.client and response.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return response

    def register(self):
        result = self.write('POST', '/api/auth/register/', {
            'email': self.email, 'password': self.password, 'full_name': 'Owner',
            'organization_name': 'First Company',
        })
        self.assertEqual(result.status_code, 201, result.content)
        return Organization.objects.get(pk=result.json()['active_organization_id'])

    def test_password_change_requires_auth_current_password_and_csrf(self):
        self.assertEqual(self.write('POST', '/api/auth/password-change/', {
            'current_password': 'incorrect', 'new_password': 'AnotherSafePassword2026!',
        }).status_code, 401)
        self.register()
        url = '/api/auth/password-change/'
        valid = {'current_password': self.password, 'new_password': 'NewSafePassword2026!'}
        self.assertEqual(self.write('POST', url, valid, csrf=False).status_code, 403)
        self.assertEqual(self.write('POST', url, {'current_password': 'wrong',
                            'new_password': valid['new_password']}).status_code, 400)
        self.assertEqual(self.write('POST', url, {'current_password': self.password,
                            'new_password': self.password}).status_code, 400)
        self.assertEqual(self.write('POST', url, {'current_password': self.password,
                            'new_password': 'short'}).status_code, 400)
        changed = self.write('POST', url, valid)
        self.assertEqual(changed.status_code, 200, changed.content)
        self.assertTrue(get_user_model().objects.get(email=self.email).check_password(valid['new_password']))
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 200)
        self.assertEqual(self.write('POST', url, valid).status_code, 400)
        self.assertEqual(self.write('POST', '/api/auth/logout/').status_code, 200)
        self.assertEqual(self.write('POST', '/api/auth/login/', {
            'email':self.email, 'password':self.password,
        }).status_code, 401)
        self.assertEqual(self.write('POST', '/api/auth/login/', {
            'email':self.email, 'password':valid['new_password'],
        }).status_code, 200)

    def test_other_authenticated_sessions_are_invalidated(self):
        self.register()
        second = Client(enforce_csrf_checks=True)
        token = second.get('/api/auth/csrf/').json()['csrf_token']
        login = self.write('POST', '/api/auth/login/', {
            'email':self.email, 'password':self.password,
        },client=second,token=token)
        self.assertEqual(login.status_code, 200, login.content)
        self.assertEqual(second.get('/api/auth/me/').status_code, 200)
        result = self.write('POST', '/api/auth/password-change/', {
            'current_password':self.password, 'new_password':'ChangedUniquePassword2026!',
        })
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 200)
        self.assertEqual(second.get('/api/auth/me/').status_code, 401)

    def test_notification_preferences_defaults_validation_and_persistence(self):
        org = self.register()
        url = '/api/notification-preferences/'
        self.assertEqual(self.client.get(url).json(), {
            'direct_chats':True,'group_chats':True,'team_channels':True,
        })
        self.assertEqual(self.write('PATCH', url, {'group_chats':False},csrf=False).status_code, 403)
        self.assertEqual(self.write('PATCH', url, {'group_chats':0}).status_code, 400)
        self.assertEqual(self.write('PATCH', url, {'mystery':True}).status_code, 400)
        self.assertEqual(self.write('PATCH', url, {}).status_code, 400)
        result = self.write('PATCH', url, {'group_chats':False, 'team_channels':False})
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual(result.json(), {
            'direct_chats':True,'group_chats':False,'team_channels':False,
        })
        self.assertEqual(self.client.get(url).json(), result.json())
        self.assertEqual(
            NotificationPreference.objects.filter(organization=org, user__email=self.email).count(),1,
        )

    def test_preferences_follow_active_organization_without_cross_tenant_leak(self):
        first = self.register()
        self.assertEqual(self.write('PATCH', '/api/notification-preferences/', {
            'direct_chats':False,
        }).status_code, 200)
        user = get_user_model().objects.get(email=self.email)
        other = Organization.objects.create(
            name='Other Company',slug='other-company',created_by=user,
        )
        OrganizationMember.objects.create(
            organization=other,user=user,role=OrganizationMember.Role.OWNER,
        )
        switched = self.write('POST', f'/api/organizations/{other.pk}/activate/')
        self.assertEqual(switched.status_code, 200, switched.content)
        self.assertEqual(self.client.get('/api/notification-preferences/').json()['direct_chats'], True)
        self.assertEqual(self.write('PATCH', '/api/notification-preferences/', {
            'team_channels':False,
        }).status_code, 200)
        self.write('POST', f'/api/organizations/{first.pk}/activate/')
        first_prefs = self.client.get('/api/notification-preferences/').json()
        self.assertEqual(first_prefs['direct_chats'],False)
        self.assertEqual(first_prefs['team_channels'],True)
        second_prefs = NotificationPreference.objects.get(organization=other,user=user)
        self.assertFalse(second_prefs.team_channels)

    def test_another_user_cannot_read_or_modify_my_preferences(self):
        org = self.register()
        self.write('PATCH','/api/notification-preferences/',{'direct_chats':False})
        second_user = get_user_model().objects.create_user(
            email='other@first.test',password='SomeStrongPassword2026!',full_name='Colleague',
        )
        OrganizationMember.objects.create(user=second_user,organization=org)
        self.write('POST','/api/auth/logout/')
        self.assertEqual(self.write('POST','/api/auth/login/', {
            'email':'other@first.test','password':'SomeStrongPassword2026!',
        }).status_code,200)
        self.assertEqual(self.client.get('/api/notification-preferences/').json()['direct_chats'], True)
        self.assertEqual(self.write('PATCH','/api/notification-preferences/',{'group_chats':False}).status_code,200)
        owner_prefs = NotificationPreference.objects.get(organization=org,user__email=self.email)
        self.assertFalse(owner_prefs.direct_chats)
        self.assertTrue(owner_prefs.group_chats)
