"""One authenticated WebSocket per user/workspace to invalidate bell data."""
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.contrib.sessions.models import Session

from .device_sessions import GENERATION_KEY, live_websocket_session
from .models import OrganizationMember
from .notification_events import notification_group


class NotificationConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        user = self.scope.get('user')
        session = self.scope.get('session')
        organization_id = session.get('active_organization_id') if session else None
        if not user or not user.is_authenticated or not organization_id:
            await self.close(code=4401)
            return
        if not await self.authorized(user.pk, organization_id):
            await self.close(code=4403)
            return
        self.organization_id = organization_id
        self.group_name = notification_group(organization_id, user.pk)
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        if hasattr(self, 'group_name'):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content, **kwargs):
        if not await self.check_access():
            await self.close(code=4403)
            return
        if content.get('type') == 'ping':
            await self.send_json({'type': 'pong'})

    async def notification_refresh(self, event):
        # Membership, device validity and active workspace may have changed
        # since the socket was first authorized.
        if not await self.check_access():
            await self.close(code=4403)
            return
        await self.send_json({'type': 'refresh'})

    async def check_access(self):
        user = self.scope.get('user')
        if not user or not user.is_authenticated:
            return False
        return await self.authorized(user.pk, self.organization_id)

    @database_sync_to_async
    def authorized(self, user_id, organization_id):
        session = self.scope.get('session')
        if not session or not live_websocket_session(
            user_id, session.session_key, session.get(GENERATION_KEY),
        ):
            return False
        # A different tab may switch the active workspace while this socket
        # remains open. Check the current persisted session rather than trusting
        # the copied ASGI scope from the original handshake.
        stored = Session.objects.filter(session_key=session.session_key).first()
        if stored is None or str(stored.get_decoded().get('active_organization_id')) != str(organization_id):
            return False
        if not OrganizationMember.objects.filter(
            user_id=user_id, organization_id=organization_id,
            user__is_active=True,
        ).exists():
            return False
        return True
