from datetime import timedelta
from unittest.mock import patch
from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from workspace.models import User, Organization, OrganizationMember, Meeting, MeetingAttendee, MeetingCallPeer
from workspace.call_consumer import MeetingCallConsumer
from workspace.meeting_calls import register_peer, ice_configuration


class CallFixture:
    def setup_call(self):
        self.owner=User.objects.create_user('call-owner@example.test','TestOnly123!',full_name='Owner')
        self.member=User.objects.create_user('call-member@example.test','TestOnly123!',full_name='Member')
        self.outsider=User.objects.create_user('call-outsider@example.test','TestOnly123!',full_name='Outsider')
        self.org=Organization.objects.create(name='Call Test',slug='call-test',created_by=self.owner)
        for user in (self.owner,self.member,self.outsider):
            OrganizationMember.objects.create(organization=self.org,user=user)
        self.meeting=Meeting.objects.create(organization=self.org,organizer=self.owner,title='Native room',starts_at=timezone.now(),ends_at=timezone.now()+timedelta(hours=1))
        for user in (self.owner,self.member):
            MeetingAttendee.objects.create(meeting=self.meeting,user=user)
        self.clients={}
        for user in (self.owner,self.member,self.outsider):
            client=Client();client.force_login(user);s=client.session;s['active_organization_id']=str(self.org.pk);s.save();self.clients[user.pk]=client
    def scope(self,user):
        return {'user':user,'session':self.clients[user.pk].session}
    def socket(self,user):
        c=WebsocketCommunicator(MeetingCallConsumer.as_asgi(),'/ws/meetings/'+str(self.meeting.pk)+'/call/')
        c.scope.update(self.scope(user));c.scope['url_route']={'kwargs':{'meeting_id':str(self.meeting.pk)}}
        return c


class CallConfigTests(CallFixture,TestCase):
    def setUp(self):self.setup_call()
    @override_settings(CALL_TURN_URLS=['turn:relay.example.test:3478'],CALL_TURN_SHARED_SECRET='test-only-shared-secret',CALL_STUN_URLS=[])
    def test_authenticated_short_lived_relay_credentials(self):
        r=self.clients[self.owner.pk].get(f'/api/meetings/{self.meeting.pk}/call/')
        self.assertEqual(r.status_code,200,r.content)
        self.assertNotIn('test-only-shared-secret',r.content.decode())
        rtc=r.json()['rtc'];self.assertTrue(rtc['iceServers'][0]['username'].endswith(str(self.owner.pk)))
        self.assertTrue(rtc['iceServers'][0]['credential']);self.assertEqual(r['Cache-Control'],'no-store')
        self.assertEqual(self.clients[self.outsider.pk].get(f'/api/meetings/{self.meeting.pk}/call/').status_code,404)
    def test_only_organizer_can_end_and_ended_room_cannot_be_joined(self):
        path=f'/api/meetings/{self.meeting.pk}/call/'
        self.assertEqual(self.clients[self.member.pk].post(path+'end/').status_code,403)
        self.assertEqual(self.clients[self.owner.pk].post(path+'end/').status_code,200)
        self.assertEqual(self.clients[self.member.pk].get(path).status_code,400)
    def test_capacity_duplicate_and_stale_presence(self):
        own=self.scope(self.owner)
        first=register_peer(own,self.meeting.pk,'test-channel-owner')
        self.assertIn('self',first)
        self.assertEqual(register_peer(own,self.meeting.pk,'duplicate')['error'],4409)
        for i in range(5):
            u=User.objects.create_user(f'peer{i}@example.test','TestOnly123!',full_name='Peer')
            OrganizationMember.objects.create(organization=self.org,user=u);MeetingAttendee.objects.create(meeting=self.meeting,user=u)
            c=Client();c.force_login(u);s=c.session;s['active_organization_id']=str(self.org.pk);s.save()
            self.assertIn('self',register_peer({'user':u,'session':s},self.meeting.pk,f'peer-channel-{i}'))
        self.assertEqual(register_peer(self.scope(self.member),self.meeting.pk,'full')['error'],4429)
        MeetingCallPeer.objects.filter(pk=first['self']['id']).update(updated_at=timezone.now()-timedelta(seconds=100))
        self.assertIn('self',register_peer(self.scope(self.member),self.meeting.pk,'after-expiry'))
    @override_settings(CALL_ICE_TRANSPORT_POLICY='relay',CALL_TURN_URLS=[])
    def test_relay_only_requires_a_relay(self):
        from rest_framework.exceptions import ValidationError
        with self.assertRaises(ValidationError):ice_configuration(self.owner.pk)


class CallSocketTests(CallFixture,TransactionTestCase):
    def setUp(self):self.setup_call()
    def test_roster_targeted_signaling_and_media_identity(self):
        a,b=self.socket(self.owner),self.socket(self.member)
        async def scenario():
            self.assertTrue((await a.connect())[0]);ready_a=await a.receive_json_from();aid=ready_a['self']['id']
            self.assertTrue((await b.connect())[0]);ready_b=await b.receive_json_from();bid=ready_b['self']['id']
            self.assertEqual(ready_b['peers'][0]['id'],aid);self.assertEqual((await a.receive_json_from())['type'],'joined')
            await a.send_json_to({'type':'signal','target':bid,'from':'forged','description':{'type':'offer','sdp':'v=0\r\n'}})
            signal=await b.receive_json_from();self.assertEqual(signal['from']['id'],aid);self.assertEqual(signal['description']['type'],'offer')
            await a.send_json_to({'type':'media','peer_id':bid,'audio':False,'video':False})
            state=await b.receive_json_from();self.assertEqual(state['peer_id'],aid);self.assertFalse(state['audio'])
            await a.send_json_to({'type':'signal','target':'00000000-0000-0000-0000-000000000000','description':{'type':'offer','sdp':'v=0'}})
            self.assertTrue(await b.receive_nothing(timeout=.1))
            await a.disconnect();self.assertEqual((await b.receive_json_from())['type'],'left');await b.disconnect()
        async_to_sync(scenario)();self.assertEqual(MeetingCallPeer.objects.count(),0)
    def test_uninvited_and_wrong_workspace_cannot_connect(self):
        outsider=self.socket(self.outsider)
        async def scenario():
            self.assertFalse((await outsider.connect())[0]);await outsider.disconnect()
        async_to_sync(scenario)()
        c=self.clients[self.member.pk];s=c.session;s['active_organization_id']='00000000-0000-0000-0000-000000000000';s.save()
        member=self.socket(self.member)
        async def denied():
            self.assertFalse((await member.connect())[0]);await member.disconnect()
        async_to_sync(denied)()
    def test_membership_revocation_stops_open_socket(self):
        a=self.socket(self.member)
        async def scenario():
            self.assertTrue((await a.connect())[0]);await a.receive_json_from()
            await database_sync_to_async(OrganizationMember.objects.filter(organization=self.org,user=self.member).delete)()
            await a.send_json_to({'type':'ping'});closed=await a.receive_output();self.assertEqual(closed['type'],'websocket.close');self.assertEqual(closed['code'],4403)
            await a.disconnect()
        async_to_sync(scenario)()
    def test_ending_call_stops_open_socket(self):
        a=self.socket(self.member)
        async def scenario():
            self.assertTrue((await a.connect())[0]);await a.receive_json_from()
            await database_sync_to_async(Meeting.objects.filter(pk=self.meeting.pk).update)(call_ended_at=timezone.now())
            await a.send_json_to({'type':'ping'});self.assertEqual((await a.receive_output())['code'],4403);await a.disconnect()
        async_to_sync(scenario)()
    def test_oversized_signaling_is_rejected(self):
        a=self.socket(self.member)
        async def scenario():
            self.assertTrue((await a.connect())[0]);await a.receive_json_from();await a.send_to(text_data='x'*65537)
            self.assertEqual((await a.receive_output())['code'],1009);await a.disconnect()
        async_to_sync(scenario)()
