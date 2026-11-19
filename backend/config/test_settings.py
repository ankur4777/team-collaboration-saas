"""Deterministic tests without MySQL/Redis; production config remains unchanged."""
import os
os.environ.setdefault("DJANGO_SECRET_KEY", "test-only-mail-module-key-not-for-production")
from .settings import *

DEBUG = True
ALLOWED_HOSTS = ["testserver", "localhost", "127.0.0.1"]
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "test-dev.sqlite3"}}
CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
MAIL_LOCAL_ENABLED = True
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]


WEBSOCKET_ALLOWED_ORIGINS = ['http://localhost:5173','http://127.0.0.1:5173']
CSRF_TRUSTED_ORIGINS = WEBSOCKET_ALLOWED_ORIGINS
