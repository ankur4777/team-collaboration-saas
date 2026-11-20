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
    def test_more_than_six_can_join_with_duplicate_and_stale_checks(self):
        own=self.scope(self.owner)
        first=register_peer(own,self.meeting.pk,'test-channel-owner')
        self.assertIn('self',first)
        self.assertEqual(register_peer(own,self.meeting.pk,'duplicate')['error'],4409)
        for i in range(10):
            u=User.objects.create_user(f'peer{i}@example.test','TestOnly123!',full_name='Peer')
            OrganizationMember.objects.create(organization=self.org,user=u);MeetingAttendee.objects.create(meeting=self.meeting,user=u)
            c=Client();c.force_login(u);s=c.session;s['active_organization_id']=str(self.org.pk);s.save()
            self.assertIn('self',register_peer({'user':u,'session':s},self.meeting.pk,f'peer-channel-{i}'))
        self.assertIn('self',register_peer(self.scope(self.member),self.meeting.pk,'twelfth-peer'))
        self.assertEqual(MeetingCallPeer.objects.filter(meeting=self.meeting).count(),12)
        self.assertIsNone(self.clients[self.owner.pk].get(f'/api/meetings/{self.meeting.pk}/call/').json()['max_peers'])
        MeetingCallPeer.objects.filter(pk=first['self']['id']).update(updated_at=timezone.now()-timedelta(seconds=100))
        self.assertIn('self',register_peer(self.scope(self.owner),self.meeting.pk,'after-expiry'))
    def test_more_than_two_hundred_workspace_members_can_be_invited(self):
        users=[User(email=f'invite-{i}@example.test',full_name=f'Invite {i}',password='!') for i in range(201)]
        User.objects.bulk_create(users)
        OrganizationMember.objects.bulk_create([OrganizationMember(organization=self.org,user=user) for user in users])
        now=timezone.now()
        payload={'title':'Larger invitation list','agenda':'','starts_at':now.isoformat(),'ends_at':(now+timedelta(hours=1)).isoformat(),
                 'time_zone':'UTC','attendee_ids':[str(u.pk) for u in users],'channel_id':None,'invite_channel':False,'notes':''}
        response=self.clients[self.owner.pk].post('/api/meetings/',payload,content_type='application/json')
        self.assertEqual(response.status_code,201,response.content)
        self.assertEqual(len(response.json()['attendees']),202)

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

    def test_hand_and_presentation_state_reach_peers_and_late_joiners(self):
        MeetingAttendee.objects.create(meeting=self.meeting,user=self.outsider)
        a,b,c=self.socket(self.owner),self.socket(self.member),self.socket(self.outsider)
        async def scenario():
            await a.connect();ready=await a.receive_json_from()
            await b.connect();await b.receive_json_from();await a.receive_json_from()
            await a.send_json_to({'type':'media','peer_id':'forged','audio':True,'video':False,'hand_raised':True,'screen_sharing':True})
            event=await b.receive_json_from()
            self.assertEqual(event['peer_id'],ready['self']['id']);self.assertTrue(event['hand_raised']);self.assertTrue(event['screen_sharing'])
            await a.send_json_to({'type':'media','audio':True,'video':False,'hand_raised':'yes','screen_sharing':True})
            self.assertTrue(await b.receive_nothing(timeout=.1))
            await c.connect();late=await c.receive_json_from()
            owner=next(p for p in late['peers'] if p['id']==ready['self']['id'])
            self.assertTrue(owner['hand_raised']);self.assertTrue(owner['screen_sharing'])
            await c.disconnect();await b.disconnect();await a.disconnect()
        async_to_sync(scenario)()

    def test_live_chat_authentic_sender_validation_and_throttle(self):
        a,b=self.socket(self.owner),self.socket(self.member)
        async def scenario():
            await a.connect();ready=await a.receive_json_from()
            await b.connect();await b.receive_json_from();await a.receive_json_from()
            await a.send_json_to({'type':'chat','text':'<script>plain text</script>','sender':{'name':'Forged'}})
            own,remote=await a.receive_json_from(),await b.receive_json_from()
            self.assertEqual(own,remote);message=remote['message']
            self.assertEqual(message['sender']['id'],ready['self']['id']);self.assertEqual(message['sender']['name'],self.owner.full_name)
            self.assertEqual(message['text'],'<script>plain text</script>');self.assertTrue(message['id']);self.assertTrue(message['sent_at'])
            await a.send_json_to({'type':'chat','text':'x'*2001});self.assertEqual((await a.receive_json_from())['type'],'notice')
            self.assertTrue(await b.receive_nothing(timeout=.1))
            for i in range(4):
                await a.send_json_to({'type':'chat','text':str(i)});await a.receive_json_from();await b.receive_json_from()
            await a.send_json_to({'type':'chat','text':'too fast'});self.assertEqual((await a.receive_json_from())['type'],'notice')
            self.assertTrue(await b.receive_nothing(timeout=.1));await b.disconnect();await a.disconnect()
        async_to_sync(scenario)()

    def test_reactions_and_captions_have_authenticated_identity_and_bounds(self):
        a,b=self.socket(self.owner),self.socket(self.member)
        async def scenario():
            await a.connect();ready=await a.receive_json_from()
            await b.connect();await b.receive_json_from();await a.receive_json_from()
            for kind,payload in [('reaction',{'emoji':'👍'}),('caption',{'text':'Hello team','language':'en-US'})]:
                await a.send_json_to({'type':kind,'sender':{'name':'Forged'},**payload})
                own,remote=await a.receive_json_from(),await b.receive_json_from()
                self.assertEqual(own,remote);self.assertEqual(remote[kind]['sender']['id'],ready['self']['id']);self.assertEqual(remote[kind]['sender']['name'],self.owner.full_name)
            await a.send_json_to({'type':'reaction','emoji':'<script>'})
            await a.send_json_to({'type':'caption','text':'x'*501,'language':'en-US'})
            await a.send_json_to({'type':'caption','text':'hello','language':'invalid'})
            self.assertTrue(await b.receive_nothing(timeout=.1))
            for _ in range(2):
                await a.send_json_to({'type':'reaction','emoji':'👏'});await a.receive_json_from();await b.receive_json_from()
            await a.send_json_to({'type':'reaction','emoji':'👍'});self.assertEqual((await a.receive_json_from())['type'],'notice')
            await a.send_json_to({'type':'media','audio':False,'video':True});await b.receive_json_from()
            await a.send_json_to({'type':'caption','text':'Muted words','language':'en-US'})
            self.assertTrue(await b.receive_nothing(timeout=.1));await b.disconnect();await a.disconnect()
        async_to_sync(scenario)()


class CallTranslationTests(CallFixture,TestCase):
    def setUp(self):
        self.setup_call()
        register_peer(self.scope(self.owner),self.meeting.pk,'translation-test')
        self.path=f'/api/meetings/{self.meeting.pk}/call/translate/'
        self.payload={'text':'Hello team','source':'en','target':'hi'}
    @override_settings(CALL_TRANSLATE_URL='')
    def test_service_unconfigured_and_nonparticipant_denied(self):
        self.assertEqual(self.clients[self.owner.pk].post(self.path,self.payload,content_type='application/json').status_code,503)
        self.assertEqual(self.clients[self.member.pk].post(self.path,self.payload,content_type='application/json').status_code,403)
        self.assertEqual(self.clients[self.outsider.pk].post(self.path,self.payload,content_type='application/json').status_code,404)
    @override_settings(CALL_TRANSLATE_URL='https://translate.example.test/translate',CALL_TRANSLATE_API_KEY='server-only-test-secret')
    def test_translation_uses_configured_service_and_secret_stays_on_server(self):
        with patch('workspace.call_access.httpx.Client') as factory:
            client=factory.return_value.__enter__.return_value
            client.post.return_value.content=b'{}';client.post.return_value.json.return_value={'translatedText':'नमस्ते टीम'}
            response=self.clients[self.owner.pk].post(self.path,self.payload,content_type='application/json')
            self.assertEqual(response.status_code,200,response.content);self.assertEqual(response.json()['text'],'नमस्ते टीम');self.assertEqual(response['Cache-Control'],'no-store')
            self.assertNotIn('server-only-test-secret',response.content.decode())
            self.assertEqual(client.post.call_args.kwargs['json']['api_key'],'server-only-test-secret')
            self.assertEqual(factory.call_args.kwargs['follow_redirects'],False)
    @override_settings(CALL_TRANSLATE_URL='https://translate.example.test/translate')
    def test_translation_validation_timeout_and_revoked_call(self):
        import httpx
        with patch('workspace.call_access.httpx.Client') as factory:
            client=factory.return_value.__enter__.return_value;client.post.side_effect=httpx.TimeoutException('test-only failure')
            self.assertEqual(self.clients[self.owner.pk].post(self.path,self.payload,content_type='application/json').status_code,502)
            self.assertEqual(self.clients[self.owner.pk].post(self.path,{**self.payload,'target':'invalid'},content_type='application/json').status_code,400)
            self.assertEqual(self.clients[self.owner.pk].post(self.path,[],content_type='application/json').status_code,400)
            Meeting.objects.filter(pk=self.meeting.pk).update(call_ended_at=timezone.now())
            self.assertEqual(self.clients[self.owner.pk].post(self.path,self.payload,content_type='application/json').status_code,403)

class LargerCallSocketTests(CallFixture,TransactionTestCase):
    def setUp(self):
        self.setup_call()
    def test_eight_invited_sockets_join_and_eighth_can_signal_first(self):
        users=[self.owner,self.member]
        for i in range(6):
            user=User.objects.create_user(f'large-peer-{i}@example.test','TestOnly123!',full_name=f'Peer {i}')
            OrganizationMember.objects.create(organization=self.org,user=user)
            MeetingAttendee.objects.create(meeting=self.meeting,user=user)
            client=Client();client.force_login(user);session=client.session
            session['active_organization_id']=str(self.org.pk);session.save();self.clients[user.pk]=client;users.append(user)
        sockets=[self.socket(user) for user in users]
        async def scenario():
            ids=[]
            for i,socket in enumerate(sockets):
                self.assertTrue((await socket.connect())[0]);ready=await socket.receive_json_from()
                ids.append(ready['self']['id']);self.assertEqual(len(ready['peers']),i)
                for old in sockets[:i]:self.assertEqual((await old.receive_json_from())['type'],'joined')
            await sockets[-1].send_json_to({'type':'signal','target':ids[0],'description':{'type':'offer','sdp':'v=0\r\n'}})
            signal=await sockets[0].receive_json_from();self.assertEqual(signal['from']['id'],ids[-1]);self.assertEqual(signal['description']['type'],'offer')
            for socket in reversed(sockets):await socket.disconnect()
        async_to_sync(scenario)()
        self.assertEqual(MeetingCallPeer.objects.filter(meeting=self.meeting).count(),0)
