from channels.db import database_sync_to_async
from django.utils.dateparse import parse_datetime
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from .models import Channel, TeamMember, OrganizationMember, ChatConversation, ChatParticipant


class ChannelConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        user = self.scope.get('user')
        channel_id = self.scope['url_route']['kwargs']['channel_id']
        active_org = self.scope['session'].get('active_organization_id')
        if not user or not user.is_authenticated or not active_org:
            await self.close(code=4401)
            return
        if not await self.allowed(user.pk, channel_id, active_org):
            await self.close(code=4403)
            return
        self.group_name = f'channel_{channel_id}'
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        if hasattr(self, 'group_name'):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content, **kwargs):
        # Messages are only created through authenticated, CSRF-protected REST POSTs.
        # The WebSocket only receives server-published chat events.
        if content.get('type') == 'ping':
            await self.send_json({'type': 'pong'})

    async def chat_message(self, event):
        # Membership can change while a socket is open; recheck before sending.
        channel_id = self.scope['url_route']['kwargs']['channel_id']
        user = self.scope.get('user')
        active_org = self.scope['session'].get('active_organization_id')
        if not await self.allowed(user.pk, channel_id, active_org):
            await self.close(code=4403)
            return
        await self.send_json({'type': 'message', 'message': event['message']})

    @database_sync_to_async
    def allowed(self, user_id, channel_id, organization_id):
        return (Channel.objects.filter(
            id=channel_id, team__organization_id=organization_id,
            team__members__user_id=user_id,
            team__organization__members__user_id=user_id,
        ).exists())



class PrivateChatConsumer(AsyncJsonWebsocketConsumer):
    """Read-only WebSocket: only REST may write private messages."""

    async def connect(self):
        user = self.scope.get('user')
        chat_id = self.scope['url_route']['kwargs']['chat_id']
        organization_id = self.scope['session'].get('active_organization_id')
        if not user or not user.is_authenticated or not organization_id:
            await self.close(code=4401)
            return
        if not await self.allowed(user.pk, chat_id, organization_id):
            await self.close(code=4403)
            return
        self.group_name = f'private_chat_{chat_id}'
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        if hasattr(self, 'group_name'):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content, **kwargs):
        if content.get('type') == 'ping':
            await self.send_json({'type': 'pong'})

    async def chat_message(self, event):
        user = self.scope.get('user')
        organization_id = self.scope['session'].get('active_organization_id')
        chat_id = self.scope['url_route']['kwargs']['chat_id']
        # Membership is checked for every event, so an employee removed from
        # an organization or conversation cannot receive further messages.
        if not user or not await self.allowed(user.pk, chat_id, organization_id):
            await self.close(code=4403)
            return
        # Do not reveal edits/deletions of messages sent before this user
        # joined an existing group conversation.
        if not await self.can_see_message(user.pk, chat_id, event['message']['created_at']):
            return
        await self.send_json({
            'type': event.get('action', 'message'),
            'message': event['message'],
        })

    async def chat_participants(self, event):
        user = self.scope.get('user')
        chat_id = self.scope['url_route']['kwargs']['chat_id']
        organization_id = self.scope['session'].get('active_organization_id')
        if not user or not await self.allowed(user.pk, chat_id, organization_id):
            await self.close(code=4403)
            return
        await self.send_json({'type': 'participants_changed'})

    @database_sync_to_async
    def can_see_message(self, user_id, chat_id, created_at):
        timestamp = parse_datetime(created_at)
        if timestamp is None:
            return False
        chat = ChatConversation.objects.filter(pk=chat_id).values('kind').first()
        if not chat:
            return False
        if chat['kind'] != ChatConversation.Kind.GROUP:
            return True
        return ChatParticipant.objects.filter(
            conversation_id=chat_id,
            user_id=user_id,
            joined_at__lte=timestamp,
        ).exists()

    @database_sync_to_async
    def allowed(self, user_id, chat_id, organization_id):
        return ChatConversation.objects.filter(
            pk=chat_id,
            organization_id=organization_id,
            participants__user_id=user_id,
            organization__members__user_id=user_id,
        ).exists()
