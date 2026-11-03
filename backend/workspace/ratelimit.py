"""Simple local authentication throttle; Redis-backed cache recommended in production.

This protects common login attempts but is NOT a distributed DoS mitigation.
"""
import hashlib
from django.core.cache import cache
from django.http import JsonResponse


def login_throttled(request, email):
    ip = (request.META.get('REMOTE_ADDR') or 'unknown')
    digest = hashlib.sha256(f'{ip}:{email.lower().strip()}'.encode()).hexdigest()
    key = f'login-attempts:{digest}'
    attempts = cache.get(key, 0)
    if attempts >= 8:
        return JsonResponse({'detail': 'Too many login attempts; try again later.'}, status=429)
    return None


def record_login_failure(request, email):
    ip = request.META.get('REMOTE_ADDR') or 'unknown'
    digest = hashlib.sha256(f'{ip}:{email.lower().strip()}'.encode()).hexdigest()
    key = f'login-attempts:{digest}'
    if cache.add(key, 1, timeout=900):
        return
    try:
        cache.incr(key)
    except ValueError:
        cache.set(key, 1, timeout=900)
