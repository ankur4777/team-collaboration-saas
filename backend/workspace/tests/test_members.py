"""Membership lifecycle: roles, removal and multi-tenant boundaries."""
import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from workspace.models import Organization, OrganizationMember, TeamMember, ChatConversation, ChatParticipant, ChatMessage


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class MemberManagementTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def write(self, method, path, payload=None):
        response = self.client.generic(
            method, path, data=json.dumps(payload or {}),
            content_type='application/json', HTTP_X_CSRFTOKEN=self.csrf,
        )
        if response.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return response

    def register(self, email='owner@company-a.test', company='Company A'):
        response = self.write('POST', '/api/auth/register/', {
            'email': email, 'full_name': 'Workspace Owner',
            'password': 'SafePass123!2026', 'organization_name': company,
        })
        self.assertEqual(response.status_code, 201, response.content)
        return Organization.objects.get(id=response.json()['active_organization_id'])

    def employee(self, org, email, role='member'):
        user = get_user_model().objects.create_user(
            email=email, password='SafePass123!2026', full_name=email.split('@')[0],
        )
        member = OrganizationMember.objects.create(
            user=user, organization=org, role=role,
        )
        return user, member

    def login(self, email):
        self.assertEqual(self.write('POST', '/api/auth/logout/').status_code, 200)
        response = self.write('POST', '/api/auth/login/', {
            'email': email, 'password': 'SafePass123!2026',
        })
        self.assertEqual(response.status_code, 200, response.content)

    def member_url(self, org, membership):
        return f'/api/organizations/{org.pk}/members/{membership.pk}/'

    def test_owner_can_promote_and_demote_non_owner(self):
        org = self.register()
        owner_membership = OrganizationMember.objects.get(organization=org, role='owner')
        _, member = self.employee(org, 'staff@company-a.test')
        url = self.member_url(org, member)
        self.assertEqual(self.write('PATCH', url, {'role': 'owner'}).status_code, 400)
        self.assertEqual(self.write('PATCH', url, {'role': 'admin'}).status_code, 200)
        member.refresh_from_db()
        self.assertEqual(member.role, 'admin')
        self.assertEqual(self.write('PATCH', url, {'role': 'member'}).status_code, 200)
        member.refresh_from_db()
        self.assertEqual(member.role, 'member')
        self.assertEqual(
            self.write('PATCH', self.member_url(org, owner_membership), {'role': 'member'}).status_code,
            403,
        )

    def test_admin_can_remove_member_but_not_assign_roles_or_remove_admins(self):
        org = self.register()
        _, admin = self.employee(org, 'admin@company-a.test', role='admin')
        member_user, member = self.employee(org, 'staff@company-a.test')
        response = self.write('POST', '/api/teams/', {'name': 'Engineering'})
        self.assertEqual(response.status_code, 201)
        team_id = response.json()['id']
        response = self.write('POST', f'/api/teams/{team_id}/members/', {'email': member_user.email})
        self.assertEqual(response.status_code, 201)
        self.login('admin@company-a.test')
        self.assertEqual(self.write('PATCH', self.member_url(org, member), {'role': 'admin'}).status_code, 403)
        self.assertEqual(self.write('DELETE', self.member_url(org, admin)).status_code, 403)
        self.assertEqual(self.write('POST', f'/api/organizations/{org.id}/invitations/',
                                    {'email': 'new@company-a.test', 'role': 'admin'}).status_code, 403)
        self.assertEqual(self.write('DELETE', self.member_url(org, member)).status_code, 204)
        self.assertFalse(OrganizationMember.objects.filter(pk=member.pk).exists())
        self.assertFalse(TeamMember.objects.filter(user=member_user).exists())
        self.assertTrue(get_user_model().objects.filter(pk=member_user.pk).exists())

    def test_team_owner_must_transfer_ownership_before_org_removal(self):
        org = self.register()
        member_user, member = self.employee(org, 'staff@company-a.test')
        self.login(member_user.email)
        self.assertEqual(self.write('POST', '/api/teams/', {'name': 'Owned by staff'}).status_code, 201)
        self.login('owner@company-a.test')
        response = self.write('DELETE', self.member_url(org, member))
        self.assertEqual(response.status_code, 409, response.content)
        self.assertTrue(OrganizationMember.objects.filter(pk=member.pk).exists())

    def test_other_organization_cannot_change_or_remove_members(self):
        first_org = self.register()
        _, member = self.employee(first_org, 'staff@company-a.test')
        self.assertEqual(self.write('POST', '/api/auth/logout/').status_code, 200)
        second_org = self.register(email='owner@company-b.test', company='Company B')
        self.assertNotEqual(first_org.pk, second_org.pk)
        self.assertEqual(self.write('PATCH', self.member_url(first_org, member),
                                    {'role': 'admin'}).status_code, 403)
        self.assertEqual(self.write('DELETE', self.member_url(first_org, member)).status_code, 403)
        self.assertTrue(OrganizationMember.objects.filter(pk=member.pk).exists())
        self.assertEqual(self.client.patch(
            self.member_url(second_org, member), data=json.dumps({'role': 'admin'}),
            content_type='application/json',
        ).status_code, 403)

    def test_group_owner_must_transfer_before_workspace_removal(self):
        org = self.register()
        staff, membership = self.employee(org, 'staff@company-a.test')
        first, _ = self.employee(org, 'first@company-a.test')
        second, _ = self.employee(org, 'second@company-a.test')
        self.login(staff.email)
        result = self.write('POST', '/api/chats/', {
            'kind': 'group', 'title': 'Operations', 'emails': [first.email, second.email],
        })
        self.assertEqual(result.status_code, 201, result.content)
        chat_id = result.json()['id']
        base = f'/api/chats/{chat_id}/'
        self.assertEqual(self.write('POST', base + 'messages/', {'body': 'Keep history'}).status_code, 201)
        self.login('owner@company-a.test')
        url = self.member_url(org, membership)
        self.assertEqual(self.write('DELETE', url).status_code, 409)
        self.assertTrue(OrganizationMember.objects.filter(pk=membership.pk).exists())
        self.assertTrue(ChatParticipant.objects.filter(conversation_id=chat_id, user=staff).exists())
        self.login(staff.email)
        self.assertEqual(self.write('POST', base + 'ownership/', {'user_id': str(first.pk)}).status_code, 204)
        self.login('owner@company-a.test')
        self.assertEqual(self.write('DELETE', url).status_code, 204)
        self.assertFalse(OrganizationMember.objects.filter(pk=membership.pk).exists())
        self.assertFalse(ChatParticipant.objects.filter(conversation_id=chat_id, user=staff).exists())
        self.assertEqual(ChatConversation.objects.get(pk=chat_id).created_by_id, first.pk)
        self.assertTrue(ChatMessage.objects.filter(conversation_id=chat_id, body='Keep history').exists())
        self.login(first.email)
        self.assertEqual(self.client.get(base + 'messages/').status_code, 200)
