"""Authenticated WebSocket routes for channels and private chats."""
from django.urls import re_path
from .consumers import ChannelConsumer, PrivateChatConsumer
from .notification_consumers import NotificationConsumer

websocket_urlpatterns = [
    re_path(r'^ws/channels/(?P<channel_id>[0-9a-f-]{36})/$', ChannelConsumer.as_asgi()),
    re_path(r'^ws/chats/(?P<chat_id>[0-9a-f-]{36})/$', PrivateChatConsumer.as_asgi()),
]
