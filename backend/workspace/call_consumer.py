"""Authenticated signaling only: media travels directly between browsers/TURN."""
import asyncio
import json
import time
import uuid
from datetime import timedelta

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.utils import timezone
from django.core.exceptions import ValidationError

from .models import MeetingCallPeer
from .meeting_calls import socket_allowed, register_peer, peer_data, PEER_TTL


class MeetingCallConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.peer_id = None
        self.monitor_task = None
        self.meeting_id = self.scope['url_route']['kwargs']['meeting_id']
        self.group = 'call_'+self.meeting_id
        self.window_start, self.message_count = time.monotonic(), 0
        self.chat_start, self.chat_count = time.monotonic(), 0
        if not await database_sync_to_async(socket_allowed)(self.scope,self.meeting_id):
            await self.close(code=4403)
            return
        admission = await database_sync_to_async(register_peer)(self.scope,self.meeting_id,self.channel_name)
        if 'error' in admission:
            await self.close(code=admission['error'])
            return
        self.peer_id = admission['self']['id']
        await self.channel_layer.group_add(self.group,self.channel_name)
        await self.accept()
        await self.send_json({'type':'ready','self':admission['self'],'peers':admission['peers']})
        for old in admission['stale']:
            await self.channel_layer.group_send(self.group,{'type':'call.event','action':'left','peer_id':old})
        await self.channel_layer.group_send(self.group,{'type':'call.event','action':'joined','peer':admission['self']})
        self.monitor_task = asyncio.create_task(self.monitor())

    async def disconnect(self,code):
        task = getattr(self,'monitor_task',None)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if getattr(self,'peer_id',None):
            await database_sync_to_async(MeetingCallPeer.objects.filter(pk=self.peer_id).delete)()
            await self.channel_layer.group_discard(self.group,self.channel_name)
            await self.channel_layer.group_send(self.group,{'type':'call.event','action':'left','peer_id':self.peer_id})

    async def receive(self,text_data=None,bytes_data=None,**kwargs):
        if text_data is None or len(text_data.encode('utf-8')) > 65536:
            await self.close(code=1009)
            return
        try:
            content=json.loads(text_data)
        except (ValueError,TypeError):
            await self.close(code=1008)
            return
        if not isinstance(content,dict):
            await self.close(code=1008)
            return
        await self.receive_json(content)

    async def receive_json(self,content,**kwargs):
        if not self.peer_id or not await self.authorized():
            await self.close(code=4403)
            return
        if time.monotonic()-self.window_start > 10:
            self.window_start,self.message_count=time.monotonic(),0
        self.message_count += 1
        if self.message_count > 300:
            await self.close(code=1008)
            return
        kind=content.get('type')
        if kind=='ping':
            await database_sync_to_async(MeetingCallPeer.objects.filter(pk=self.peer_id).update)(updated_at=timezone.now())
            await self.send_json({'type':'pong'})
        elif kind=='media':
            fields = ('audio', 'video', 'hand_raised', 'screen_sharing')
            if any(type(content.get(key)) is not bool for key in ('audio','video')):
                return
            if any(key in content and type(content[key]) is not bool for key in fields):
                return
            state = {key: content.get(key, False) for key in fields}
            await database_sync_to_async(MeetingCallPeer.objects.filter(pk=self.peer_id).update)(**state)
            await self.channel_layer.group_send(self.group,{'type':'call.event','action':'media','peer_id':self.peer_id,**state})
        elif kind=='chat':
            text = content.get('text')
            if not isinstance(text,str) or not text.strip() or len(text)>2000:
                await self.send_json({'type':'notice','text':'Messages must contain 1–2000 characters.'})
                return
            if time.monotonic()-self.chat_start > 10:
                self.chat_start,self.chat_count=time.monotonic(),0
            self.chat_count += 1
            if self.chat_count > 5:
                await self.send_json({'type':'notice','text':'Please wait a few seconds before sending another message.'})
                return
            sender = await self.sender_data(self.peer_id)
            if sender:
                await self.channel_layer.group_send(self.group,{'type':'call.event','action':'chat','message':{
                    'id':str(uuid.uuid4()),'sender':sender,'text':text.strip(),'sent_at':timezone.now().isoformat()}})
        elif kind=='signal':
            target = content.get('target')
            if not isinstance(target,str) or len(target)!=36 or target==self.peer_id:
                return
            body={}
            desc=content.get('description')
            candidate=content.get('candidate')
            if isinstance(desc,dict) and desc.get('type') in ('offer','answer') and isinstance(desc.get('sdp'),str) and len(desc['sdp'])<=60000:
                body={'description':{'type':desc['type'],'sdp':desc['sdp']}}
            elif isinstance(candidate,dict) and isinstance(candidate.get('candidate'),str) and len(candidate['candidate'])<=4096:
                mid,index=candidate.get('sdpMid'),candidate.get('sdpMLineIndex')
                if mid is not None and (not isinstance(mid,str) or len(mid)>64):
                    return
                if index is not None and (type(index) is not int or not 0<=index<=128):
                    return
                body={'candidate':{'candidate':candidate['candidate'],'sdpMid':mid,'sdpMLineIndex':index}}
            if not body:
                return
            channel = await self.target_channel(target)
            if channel:
                await self.channel_layer.send(channel,{'type':'call.signal','from':self.peer_id,'body':body})

    async def call_signal(self,event):
        if not await self.authorized():
            await self.close(code=4403)
            return
        peer = await self.sender_data(event['from'])
        if peer:
            await self.send_json({'type':'signal','from':peer,**event['body']})

    async def call_event(self,event):
        if not await self.authorized():
            await self.close(code=4403)
            return
        if event.get('peer',{}).get('id')==self.peer_id or event.get('peer_id')==self.peer_id:
            return
        await self.send_json({key:value for key,value in event.items() if key!='type'} | {'type':event['action']})

    async def monitor(self):
        try:
            while True:
                await asyncio.sleep(10)
                if not await self.authorized():
                    await self.close(code=4403)
                    return
        except asyncio.CancelledError:
            return

    @database_sync_to_async
    def authorized(self):
        return socket_allowed(self.scope,self.meeting_id) and MeetingCallPeer.objects.filter(
            pk=self.peer_id,updated_at__gte=timezone.now()-timedelta(seconds=PEER_TTL)).exists()

    @database_sync_to_async
    def target_channel(self,target):
        try:
            return MeetingCallPeer.objects.filter(pk=target,meeting_id=self.meeting_id,updated_at__gte=timezone.now()-timedelta(seconds=PEER_TTL)).values_list('channel_name',flat=True).first()
        except (ValueError,ValidationError):
            return None

    @database_sync_to_async
    def sender_data(self,peer_id):
        peer=MeetingCallPeer.objects.filter(pk=peer_id,meeting_id=self.meeting_id).select_related('user').first()
        return peer_data(peer) if peer else None
