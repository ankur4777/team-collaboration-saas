"""Run: python manage.py test workspace --verbosity 2"""
import json
from django.test import TestCase, Client, override_settings
from django.contrib.auth import get_user_model
from workspace.models import Organization, OrganizationMember, Team, TeamMember, Channel, Message


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class WorkspaceAPITests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def post(self, path, data):
        result = self.client.post(path, data=json.dumps(data), content_type='application/json',
                                  HTTP_X_CSRFTOKEN=self.csrf)
        # Logging in regenerates the CSRF secret: refresh before next write.
        if result.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return result

    def register(self, email='owner@company-a.test', org='Company A'):
        result = self.post('/api/auth/register/', {'email': email, 'password': 'SecurePass123!',
                                                  'full_name': 'Owner', 'organization_name': org})
        self.assertEqual(result.status_code, 201, result.content)
        return result.json()

    def test_registration_creates_owner_and_csrf_logout(self):
        session = self.register()
        org_id = session['active_organization_id']
        self.assertEqual(OrganizationMember.objects.get(organization_id=org_id).role, 'admin')
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 200)
        self.assertEqual(self.post('/api/auth/logout/', {}).status_code, 200)
        self.assertEqual(self.client.get('/api/auth/me/').status_code, 401)
        self.assertEqual(self.client.post('/api/auth/login/', data='{}', content_type='application/json').status_code, 403)

    def test_team_chat_and_tenant_isolation(self):
        company_a = self.register()
        first = self.post('/api/teams/', {'name': 'Engineering'})
        self.assertEqual(first.status_code, 201, first.content)
        team_id = first.json()['id']
        channels = self.client.get(f'/api/teams/{team_id}/channels/').json()
        self.assertEqual(len(channels), 1)
        channel_id = channels[0]['id']
        msg = self.post(f'/api/channels/{channel_id}/messages/', {'body': 'Hello team!'})
        self.assertEqual(msg.status_code, 201, msg.content)
        self.assertEqual(Message.objects.count(), 1)

        self.post('/api/auth/logout/', {})
        company_b = self.register(email='owner@company-b.test', org='Company B')
        self.assertNotEqual(company_a['active_organization_id'], company_b['active_organization_id'])
        self.assertEqual(self.client.get('/api/teams/').json(), [])
        self.assertEqual(self.client.get(f'/api/teams/{team_id}/channels/').status_code, 403)
        self.assertEqual(self.client.get(f'/api/channels/{channel_id}/messages/').status_code, 403)
        self.assertEqual(self.post(f'/api/channels/{channel_id}/messages/', {'body': 'unauthorized'}).status_code, 403)
        self.assertEqual(self.post(f'/api/organizations/{company_a["active_organization_id"]}/activate/', {}).status_code, 403)

    def test_invitation_membership_and_team_access(self):
        owner = self.register()
        org_id = owner['active_organization_id']
        response = self.post(f'/api/organizations/{org_id}/invitations/', {'email': 'colleague@example.test'})
        self.assertEqual(response.status_code, 201, response.content)
        import urllib.parse
        invite_url = response.json()['development_invite_url'] if 'development_invite_url' in response.json() else None
        if invite_url is None:
            from django.core import mail
            invite_url = mail.outbox[-1].body.split('http://')[-1].splitlines()[0]
            invite_url = 'http://' + invite_url
        token = urllib.parse.parse_qs(urllib.parse.urlparse(invite_url).query)['token'][0]
        self.post('/api/auth/logout/', {})
        accepted = self.post(f'/api/invitations/{token}/accept/', {'full_name': 'Colleague', 'password': 'OtherSafePass123!'})
        self.assertEqual(accepted.status_code, 200, accepted.content)
        self.assertEqual(OrganizationMember.objects.filter(organization_id=org_id).count(), 2)
        self.assertEqual(self.post(f'/api/invitations/{token}/accept/', {}).status_code, 410)
        self.assertEqual(self.post('/api/teams/', {'name': 'Design'}).status_code, 201)

    def test_member_cannot_send_invites(self):
        owner = self.register()
        org = Organization.objects.get(id=owner['active_organization_id'])
        user = get_user_model().objects.create_user('staff@company-a.test', 'SecurePass123!', full_name='Staff')
        OrganizationMember.objects.create(organization=org, user=user, role='member')
        self.post('/api/auth/logout/', {})
        self.assertEqual(self.post('/api/auth/login/', {'email': user.email, 'password': 'SecurePass123!'}).status_code, 200)
        self.assertEqual(self.post(f'/api/organizations/{org.pk}/invitations/', {'email': 'new@example.test'}).status_code, 403)

    def test_team_management_transfer_rename_and_remove(self):
        session = self.register()
        org = Organization.objects.get(pk=session['active_organization_id'])
        staff = get_user_model().objects.create_user('staff@company-a.test', 'SecurePass123!', full_name='Staff')
        peer = get_user_model().objects.create_user('peer@company-a.test', 'SecurePass123!', full_name='Peer')
        for user in (staff, peer):
            OrganizationMember.objects.create(organization=org, user=user)
        team_id = self.post('/api/teams/', {'name': 'Before'}).json()['id']
        base = f'/api/teams/{team_id}/'
        channel_id = self.client.get(base + 'channels/').json()[0]['id']
        for user in (staff, peer):
            self.assertEqual(self.post(base + 'members/', {'email': user.email}).status_code, 201)
        def patch(path, data):
            return self.client.patch(path, data=json.dumps(data), content_type='application/json', HTTP_X_CSRFTOKEN=self.csrf)
        self.assertEqual(patch(base, {'name': 'After'}).status_code, 200)
        self.assertEqual(patch(base + f'channels/{channel_id}/', {'name':'Updates'}).status_code, 200)
        self.assertEqual(self.post(base + 'ownership/', {'user_id': str(staff.pk)}).status_code, 204)
        self.assertEqual(TeamMember.objects.get(team_id=team_id, user=staff).role, 'owner')
        self.assertEqual(self.client.delete(base + f'members/{staff.pk}/', HTTP_X_CSRFTOKEN=self.csrf).status_code, 403)
        self.assertEqual(self.client.delete(base + f'members/{peer.pk}/', HTTP_X_CSRFTOKEN=self.csrf).status_code, 204)
        self.assertTrue(OrganizationMember.objects.filter(organization=org, user=peer).exists())
        self.post('/api/auth/logout/', {})
        self.post('/api/auth/login/', {'email': peer.email, 'password':'SecurePass123!'})
        self.assertEqual(self.client.get(base + 'channels/').status_code, 403)
        self.assertEqual(patch(base, {'name':'Unauthorized'}).status_code, 403)

    def test_archive_restore_preserves_channel_history(self):
        session = self.register()
        team = self.post('/api/teams/', {'name':'Archive example'}).json()
        base = f"/api/teams/{team['id']}/"
        channel = self.client.get(base+'channels/').json()[0]
        messages = f"/api/channels/{channel['id']}/messages/"
        original = self.post(messages, {'body':'Keep history'}).json()
        archive_channel = base+f"channels/{channel['id']}/archive/"
        self.assertEqual(self.post(archive_channel, {'archived':True}).status_code,200)
        self.assertEqual(self.post(messages, {'body':'Blocked'}).status_code,403)
        self.assertEqual(self.client.get(messages).json()[0]['id'],original['id'])
        self.assertEqual(self.post(archive_channel, {'archived':False}).status_code,200)
        self.assertEqual(self.post(base+'archive/', {'archived':True}).status_code,200)
        self.assertEqual(self.post(messages, {'body':'Blocked'}).status_code,403)
        self.assertEqual(self.post(base+'channels/', {'name':'Blocked'}).status_code,403)
        self.assertEqual(self.post(base+'archive/', {'archived':False}).status_code,200)
        self.assertEqual(self.post(messages, {'body':'Restored'}).status_code,201)
        self.assertEqual(Message.objects.filter(channel_id=channel['id']).count(),2)

    def test_leave_team_revokes_access_preserves_workspace_and_history(self):
        from workspace.models import ChannelReadCursor
        session = self.register()
        org = Organization.objects.get(pk=session['active_organization_id'])
        staff = get_user_model().objects.create_user('staff@company-a.test', 'SecurePass123!', full_name='Staff')
        OrganizationMember.objects.create(organization=org, user=staff)
        team_id = self.post('/api/teams/', {'name':'Leave example'}).json()['id']
        base = f'/api/teams/{team_id}/'
        channel_id = self.client.get(base+'channels/').json()[0]['id']
        channel_url = f'/api/channels/{channel_id}/'
        self.assertEqual(self.post(base+'leave/', {}).status_code,403)
        self.assertEqual(self.post(base+'members/', {'email':staff.email}).status_code,201)
        self.post('/api/auth/logout/', {})
        self.post('/api/auth/login/', {'email':staff.email,'password':'SecurePass123!'})
        original = self.post(channel_url+'messages/', {'body':'Keep this unique history'}).json()
        self.assertEqual(self.post(channel_url+'read/', {'message_id':original['id']}).status_code,200)
        self.assertEqual(self.post(base+'leave/', {}).status_code,204)
        self.assertTrue(OrganizationMember.objects.filter(organization=org,user=staff).exists())
        self.assertFalse(TeamMember.objects.filter(team_id=team_id,user=staff).exists())
        self.assertFalse(ChannelReadCursor.objects.filter(channel_id=channel_id,user=staff).exists())
        self.assertEqual(self.client.get('/api/teams/').json(),[])
        self.assertEqual(self.client.get(channel_url+'messages/').status_code,403)
        self.assertEqual(self.client.get(channel_url+'attachments/').status_code,403)
        self.assertEqual(self.client.get(channel_url+'pins/').status_code,403)
        self.assertEqual(self.client.get('/api/search/messages/', {'q':'unique history'}).json()['results'],[])
        self.assertTrue(Message.objects.filter(pk=original['id']).exists())
        self.post('/api/auth/logout/', {})
        self.post('/api/auth/login/', {'email':'owner@company-a.test','password':'SecurePass123!'})
        self.assertEqual(self.post(base+'members/', {'email':staff.email}).status_code,201)
        self.post('/api/auth/logout/', {})
        self.post('/api/auth/login/', {'email':staff.email,'password':'SecurePass123!'})
        self.assertEqual(self.client.get(channel_url+'messages/').json(),[])

    def test_presence_heartbeat_is_workspace_scoped_and_expires(self):
        from datetime import timedelta
        from django.utils import timezone
        session = self.register()
        org = Organization.objects.get(pk=session['active_organization_id'])
        owner = OrganizationMember.objects.get(organization=org, role='admin')
        staff = get_user_model().objects.create_user('presence@company-a.test', 'SecurePass123!', full_name='Staff')
        employee = OrganizationMember.objects.create(organization=org, user=staff)
        other = Organization.objects.create(name='Presence other', slug='presence-other', created_by=owner.user)
        other_membership = OrganizationMember.objects.create(organization=other, user=owner.user, role='admin')
        path = f'/api/organizations/{org.pk}/presence/'
        response = self.post(path, {'user_id':str(staff.pk)})
        self.assertEqual(response.status_code,200,response.content)
        rows = {row['user_id']:row for row in response.json()['members']}
        self.assertTrue(rows[str(owner.user_id)]['online'])
        self.assertFalse(rows[str(staff.pk)]['online'])
        self.assertIsNone(rows[str(staff.pk)]['last_seen_at'])
        employee.refresh_from_db()
        self.assertIsNone(employee.last_seen_at)
        OrganizationMember.objects.filter(pk=employee.pk).update(last_seen_at=timezone.now()-timedelta(seconds=91))
        rows = {row['user_id']:row for row in self.post(path,{}).json()['members']}
        self.assertFalse(rows[str(staff.pk)]['online'])
        self.assertIsNotNone(rows[str(staff.pk)]['last_seen_at'])
        OrganizationMember.objects.filter(pk=employee.pk).update(last_seen_at=timezone.now()-timedelta(seconds=10))
        rows = {row['user_id']:row for row in self.post(path,{}).json()['members']}
        self.assertTrue(rows[str(staff.pk)]['online'])
        self.assertEqual(self.post(f'/api/organizations/{other.pk}/presence/',{}).status_code,403)
        other_membership.refresh_from_db()
        self.assertIsNone(other_membership.last_seen_at)
        self.assertEqual(self.post(f'/api/organizations/{other.pk}/activate/',{}).status_code,200)
        self.assertEqual(self.post(path,{}).status_code,403)
        rows = self.post(f'/api/organizations/{other.pk}/presence/',{}).json()['members']
        self.assertEqual([row['user_id'] for row in rows],[str(owner.user_id)])
        self.assertEqual(self.client.post(path,data='{}',content_type='application/json').status_code,403)

    def test_private_channels_isolate_search_history_and_access(self):
        session = self.register()
        org = Organization.objects.get(pk=session['active_organization_id'])
        staff = get_user_model().objects.create_user('private@company-a.test','SecurePass123!',full_name='Private Staff')
        OrganizationMember.objects.create(organization=org,user=staff)
        team = self.post('/api/teams/',{'name':'Restricted'}).json()
        base = f"/api/teams/{team['id']}/"
        self.assertEqual(self.post(base+'members/',{'email':staff.email}).status_code,201)
        channel = self.post(base+'channels/',{'name':'Confidential','is_private':True}).json()
        url = f"/api/channels/{channel['id']}/"
        first = self.post(url+'messages/',{'body':'Confidential alpha'}).json()
        def login(email):
            self.post('/api/auth/logout/',{})
            self.assertEqual(self.post('/api/auth/login/',{'email':email,'password':'SecurePass123!'}).status_code,200)
        login(staff.email)
        self.assertNotIn(channel['id'],[r['id'] for r in self.client.get(base+'channels/').json()])
        for route in ('messages/','attachments/','pins/','members/'):
            self.assertEqual(self.client.get(url+route).status_code,403)
        self.assertEqual(self.client.get('/api/search/messages/',{'q':'Confidential'}).json()['results'],[])
        self.assertNotIn(channel['id'],[r['channel_id'] for r in self.client.get('/api/channel-notifications/').json()])
        self.assertNotIn(channel['id'],[r['id'] for r in self.client.get('/api/messages/forward/destinations/').json()])
        login('owner@company-a.test')
        self.assertEqual(self.post(url+'members/',{'email':staff.email}).status_code,201)
        second = self.post(url+'messages/',{'body':'Confidential beta'}).json()
        login(staff.email)
        self.assertEqual([r['id'] for r in self.client.get(url+'messages/').json()],[second['id']])
        self.assertEqual(self.client.get(url+'messages/'+first['id']+'/context/').status_code,404)
        self.assertEqual([r['id'] for r in self.client.get('/api/search/messages/',{'q':'Confidential'}).json()['results']],[second['id']])
        login('owner@company-a.test')
        self.assertEqual(self.client.delete(url+'members/'+str(staff.pk)+'/',HTTP_X_CSRFTOKEN=self.csrf).status_code,204)
        login(staff.email)
        self.assertEqual(self.client.get(url+'messages/').status_code,403)

    def test_channel_preferences_are_per_member_and_survive_refresh(self):
        session = self.register()
        org = Organization.objects.get(pk=session['active_organization_id'])
        staff = get_user_model().objects.create_user('settings@company-a.test','SecurePass123!',full_name='Settings')
        OrganizationMember.objects.create(organization=org,user=staff)
        team = self.post('/api/teams/',{'name':'Preferences team'}).json()
        base = f"/api/teams/{team['id']}/"
        self.assertEqual(self.post(base+'members/',{'email':staff.email}).status_code,201)
        channel_id = self.client.get(base+'channels/').json()[0]['id']
        path = f'/api/channels/{channel_id}/preferences/'
        self.assertEqual(self.post(path,{'is_muted':'true'}).status_code,400)
        self.assertEqual(self.post(path,{'is_muted':True,'is_pinned':True}).status_code,200)
        row = self.client.get('/api/channel-notifications/').json()[0]
        self.assertTrue(row['is_muted'])
        self.assertTrue(row['is_pinned'])
        self.post('/api/auth/logout/',{})
        self.assertEqual(self.post('/api/auth/login/',{'email':staff.email,'password':'SecurePass123!'}).status_code,200)
        row = self.client.get('/api/channel-notifications/').json()[0]
        self.assertFalse(row['is_muted'])
        self.assertFalse(row['is_pinned'])
