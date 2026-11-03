import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
from django.core.asgi import get_asgi_application
application_http = get_asgi_application()
from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import OriginValidator
from django.conf import settings
from workspace.routing import websocket_urlpatterns

application = ProtocolTypeRouter({
    'http': application_http,
    'websocket': OriginValidator(
        AuthMiddlewareStack(URLRouter(websocket_urlpatterns)),
        settings.WEBSOCKET_ALLOWED_ORIGINS,
    ),
})
