from datetime import timedelta
from unittest.mock import patch
from django.test import TestCase, Client
from django.utils import timezone
from rest_framework.test import APIClient
from workspace.models import Organization, OrganizationMember, User, Team, TeamMember, Channel, Meeting

class MeetingTests(TestCase):
    def setUp(self):
        self.owner=User.objects.create_user('owner@a.test','SafePassword123!',full_name='Owner')
        self.org=Organization.objects.create(name='A',slug='a',created_by=self.owner)
        OrganizationMember.objects.create(organization=self.org,user=self.owner,role='owner')
        self.member=User.objects.create_user('member@a.test','SafePassword123!',full_name='Member')
        OrganizationMember.objects.create(organization=self.org,user=self.member)
        self.stranger=User.objects.create_user('stranger@a.test','SafePassword123!',full_name='Stranger')
        OrganizationMember.objects.create(organization=self.org,user=self.stranger)
        self.other=User.objects.create_user('owner@b.test','SafePassword123!',full_name='Other')
        self.org_b=Organization.objects.create(name='B',slug='b',created_by=self.other)
        OrganizationMember.objects.create(organization=self.org_b,user=self.other,role='owner')
        self.client=APIClient();self.login(self.owner)
        self.payload={'title':'Review','agenda':'Discuss work','starts_at':(timezone.now()+timedelta(hours=2)).isoformat(),
          'ends_at':(timezone.now()+timedelta(hours=3)).isoformat(),'time_zone':'Asia/Kolkata',
          'meeting_url':'https://meet.example.test/room','attendee_ids':[str(self.member.pk)]}
    def login(self,user,org=None):
        self.client=APIClient()
        self.client.force_authenticate(user)
        s=self.client.session;s['active_organization_id']=str((org or self.org).pk);s.save()
    def create(self,**extra):
        r=self.client.post('/api/meetings/',{**self.payload,**extra},format='json')
        self.assertEqual(r.status_code,201,r.content);return r.json()
    def test_invitation_rsvp_and_notifications(self):
        row=self.create();self.assertEqual(row['my_response'],'accepted');self.login(self.member)
        self.assertEqual(self.client.get('/api/meetings/notifications/').json()['results'][0]['kind'],'invited')
        r=self.client.post(f"/api/meetings/{row['id']}/rsvp/",{'response':'tentative'},format='json')
        self.assertEqual(r.status_code,200,r.content);self.assertEqual(r.json()['my_response'],'tentative')
        self.assertEqual(self.client.get('/api/meetings/notifications/').json()['results'],[])
        self.login(self.owner);self.assertEqual(self.client.get('/api/meetings/notifications/').json()['results'][0]['kind'],'response')
    def test_tenant_and_invitee_access(self):
        row=self.create()
        for user,org in [(self.stranger,self.org),(self.other,self.org_b)]:
            self.login(user,org);self.assertEqual(self.client.get('/api/meetings/').json()['results'],[])
            for suffix in ['','calendar.ics']:
                self.assertEqual(self.client.get(f"/api/meetings/{row['id']}/"+suffix).status_code,404)
            for suffix in ['cancel/','rsvp/','read/','actions/']:
                self.assertEqual(self.client.post(f"/api/meetings/{row['id']}/"+suffix,{'response':'accepted','title':'Task'},format='json').status_code,404)
        self.login(self.owner)
        self.assertEqual(self.client.post('/api/meetings/',{**self.payload,'attendee_ids':[str(self.other.pk)]},format='json').status_code,400)
    def test_organizer_revision_and_cancel_permissions(self):
        row=self.create();data={**self.payload,'revision':1,'title':'Changed'};self.login(self.member)
        self.assertEqual(self.client.patch(f"/api/meetings/{row['id']}/",data,format='json').status_code,403)
        self.assertEqual(self.client.post(f"/api/meetings/{row['id']}/cancel/",{'revision':1},format='json').status_code,403)
        self.login(self.owner);r=self.client.patch(f"/api/meetings/{row['id']}/",data,format='json')
        self.assertEqual(r.status_code,200,r.content)
        self.assertEqual(self.client.patch(f"/api/meetings/{row['id']}/",data,format='json').status_code,409)
        cancelled=self.client.post(f"/api/meetings/{row['id']}/cancel/",{'revision':r.json()['revision']},format='json')
        self.assertTrue(cancelled.json()['cancelled']);self.login(self.member)
        self.assertEqual(self.client.get('/api/meetings/notifications/').json()['results'][0]['kind'],'cancelled')
        self.assertEqual(self.client.post(f"/api/meetings/{row['id']}/rsvp/",{'response':'accepted'},format='json').status_code,400)
    def test_dates_zone_and_links_validated(self):
        for change in [{'meeting_url':'javascript:alert(1)'},{'meeting_url':'http://example.com'},{'meeting_url':'https://user:pass@example.com'},
          {'time_zone':'Invalid/Time'},{'starts_at':'2028-01-01T10:00:00'},{'ends_at':self.payload['starts_at']},
          {'starts_at':(timezone.now()-timedelta(days=2)).isoformat()}]:
            self.assertEqual(self.client.post('/api/meetings/',{**self.payload,**change},format='json').status_code,400,change)
        self.assertEqual(Meeting.objects.count(),0)
    def test_reading_invitation_does_not_suppress_later_reminder(self):
        row=self.create();self.login(self.member);self.client.post(f"/api/meetings/{row['id']}/read/",{},format='json')
        meeting=Meeting.objects.get(pk=row['id'])
        with patch('workspace.meetings.timezone.now',return_value=meeting.starts_at-timedelta(minutes=10)):
            self.assertEqual(self.client.get('/api/meetings/notifications/').json()['results'][0]['kind'],'reminder')
            self.client.post(f"/api/meetings/{row['id']}/read/",{},format='json')
            self.assertEqual(self.client.get('/api/meetings/notifications/').json()['results'],[])
        self.login(self.owner)
        moved={**self.payload,'revision':1,'starts_at':(meeting.starts_at+timedelta(days=1)).isoformat(),'ends_at':(meeting.ends_at+timedelta(days=1)).isoformat()}
        self.assertEqual(self.client.patch(f"/api/meetings/{row['id']}/",moved,format='json').status_code,200)
        self.login(self.member)
        with patch('workspace.meetings.timezone.now',return_value=meeting.starts_at+timedelta(days=1,minutes=-10)):
            self.assertEqual(self.client.get('/api/meetings/notifications/').json()['results'][0]['kind'],'reminder')
    def test_offboarding_and_rejoin_does_not_restore_history(self):
        row=self.create();OrganizationMember.objects.filter(organization=self.org,user=self.member).delete();self.login(self.member)
        self.assertEqual(self.client.get(f"/api/meetings/{row['id']}/").status_code,403)
        OrganizationMember.objects.create(organization=self.org,user=self.member)
        self.assertEqual(self.client.get(f"/api/meetings/{row['id']}/").status_code,404)
        self.login(self.owner)
        self.assertEqual(self.client.patch(f"/api/meetings/{row['id']}/",{**self.payload,'revision':1},format='json').status_code,200)
        self.login(self.member);self.assertEqual(self.client.get(f"/api/meetings/{row['id']}/").status_code,200)
    def test_channel_invites_and_revoked_team_access(self):
        team=Team.objects.create(organization=self.org,name='Engineering',created_by=self.owner)
        TeamMember.objects.create(team=team,user=self.owner,role='owner');TeamMember.objects.create(team=team,user=self.member)
        channel=Channel.objects.create(team=team,name='General');row=self.create(channel_id=str(channel.pk),attendee_ids=[],invite_channel=True)
        self.assertEqual({a['user']['id'] for a in row['attendees']},{str(self.owner.pk),str(self.member.pk)})
        TeamMember.objects.filter(team=team,user=self.member).delete();self.login(self.member)
        self.assertEqual(self.client.get(f"/api/meetings/{row['id']}/").status_code,404)
        TeamMember.objects.create(team=team,user=self.member)
        self.assertEqual(self.client.get(f"/api/meetings/{row['id']}/").status_code,404)
        self.login(self.owner)
        r=self.client.patch(f"/api/meetings/{row['id']}/",{**self.payload,'channel_id':str(channel.pk),'revision':1},format='json')
        self.assertEqual(r.status_code,200,r.content)
        self.login(self.member);self.assertEqual(self.client.get(f"/api/meetings/{row['id']}/").status_code,200)
    def test_action_item_assignment_and_completion(self):
        row=self.create(attendee_ids=[str(self.member.pk),str(self.stranger.pk)]);path=f"/api/meetings/{row['id']}/actions/"
        self.assertEqual(self.client.post(path,{'title':'Test','assignee_id':str(self.other.pk)},format='json').status_code,400)
        r=self.client.post(path,{'title':'Prepare notes','assignee_id':str(self.member.pk)},format='json');self.assertEqual(r.status_code,201,r.content)
        item=r.json()['action_items'][0];self.login(self.stranger)
        self.assertEqual(self.client.patch(path+item['id']+'/',{'done':True},format='json').status_code,403)
        self.login(self.member);done=self.client.patch(path+item['id']+'/',{'done':True},format='json')
        self.assertTrue(done.json()['action_items'][0]['done'])
        self.assertEqual(self.client.post(path,{'title':'Cannot add'},format='json').status_code,403)
    def test_shared_calendar_range_and_ics(self):
        row=self.create(title='Review, planning; next\\steps\nMore')
        q={'from':(timezone.now()-timedelta(days=1)).isoformat(),'to':(timezone.now()+timedelta(days=1)).isoformat()}
        self.assertEqual(self.client.get('/api/meetings/',q).json()['results'][0]['id'],row['id'])
        r=self.client.get(f"/api/meetings/{row['id']}/calendar.ics");self.assertEqual(r.status_code,200)
        self.assertIn('SUMMARY:Review\\, planning\\; next\\\\steps\\nMore',r.content.decode());self.assertIn('Cache-Control',r)
        self.assertEqual(self.client.get('/api/meetings/',{'from':'bad','to':'bad'}).status_code,400)
    def test_auth_and_csrf(self):
        import json
        client=Client(enforce_csrf_checks=True);client.force_login(self.owner)
        s=client.session;s['active_organization_id']=str(self.org.pk);s.save()
        self.assertEqual(client.post('/api/meetings/',json.dumps(self.payload),content_type='application/json').status_code,403)
        self.client.force_authenticate(None);self.assertEqual(self.client.get('/api/meetings/').status_code,403)

    def test_invitation_broadcast_and_attendee_removal(self):
        with patch('workspace.meetings.publish_notification_refresh') as publish:
            with self.captureOnCommitCallbacks(execute=True):
                row=self.create()
            publish.assert_called_once()
            self.assertEqual(set(publish.call_args.args[1]),{self.owner.pk,self.member.pk})
        r=self.client.patch(f"/api/meetings/{row['id']}/",{**self.payload,'attendee_ids':[],'revision':1},format='json')
        self.assertEqual(r.status_code,200,r.content)
        self.login(self.member)
        self.assertEqual(self.client.get(f"/api/meetings/{row['id']}/").status_code,404)
        self.assertEqual(self.client.get('/api/meetings/notifications/').json()['results'],[])
