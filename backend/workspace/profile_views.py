"""Authenticated self-service name and private profile-photo updates."""
from pathlib import Path
from PIL import Image, UnidentifiedImageError
from django.db import transaction
from django.http import FileResponse
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from .auth_views import auth_payload
from .models import User

AVATAR_TYPES = {'.png': ('PNG', 'image/png'), '.jpg': ('JPEG', 'image/jpeg'),
                '.jpeg': ('JPEG', 'image/jpeg'), '.webp': ('WEBP', 'image/webp')}
MAX_AVATAR_BYTES = 2 * 1024 * 1024


def validate_avatar(upload):
    suffix = Path(upload.name).suffix.lower()
    if suffix not in AVATAR_TYPES:
        raise ValidationError({'avatar': 'Choose a PNG, JPEG, or WebP image.'})
    if not 0 < upload.size <= MAX_AVATAR_BYTES:
        raise ValidationError({'avatar': 'Profile photos must be between 1 byte and 2 MB.'})
    try:
        with Image.open(upload) as image:
            if image.format != AVATAR_TYPES[suffix][0]:
                raise ValidationError({'avatar': 'The image content does not match its filename.'})
            if image.width > 4096 or image.height > 4096:
                raise ValidationError({'avatar': 'Use a photo no larger than 4096 × 4096 pixels.'})
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise ValidationError({'avatar': 'This image could not be read. Choose a valid image.'})
    finally:
        upload.seek(0)


def profile_response(request):
    response = Response(auth_payload(request)['user'])
    response['Cache-Control'] = 'private, no-store'
    return response


class ProfileView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return profile_response(request)

    def patch(self, request):
        data = request.data
        if not data or set(data) - {'full_name', 'avatar', 'remove_avatar'}:
            raise ValidationError({'detail': 'Only display name and profile photo can be changed here.'})
        name = data.get('full_name')
        if 'full_name' in data and (not isinstance(name, str) or not 1 <= len(name.strip()) <= 150):
            raise ValidationError({'full_name': 'Enter a display name between 1 and 150 characters.'})
        remove = data.get('remove_avatar', False)
        if remove not in (True, False, 'true', 'false', '1', '0'):
            raise ValidationError({'remove_avatar': 'Use true or false.'})
        remove = remove in (True, 'true', '1')
        upload = request.FILES.get('avatar')
        if 'avatar' in data and upload is None:
            raise ValidationError({'avatar': 'Choose an image file.'})
        if remove and upload:
            raise ValidationError({'avatar': 'Choose a photo or remove the current photo, not both.'})
        if upload:
            validate_avatar(upload)
        field = User._meta.get_field('avatar')
        storage, new_name = field.storage, None
        if upload:
            new_name = storage.save(field.generate_filename(request.user, upload.name), upload)
        try:
            with transaction.atomic():
                user = User.objects.select_for_update().get(pk=request.user.pk)
                old_name, fields = user.avatar.name, []
                if 'full_name' in data:
                    user.full_name = name.strip()
                    fields.append('full_name')
                if new_name or remove:
                    user.avatar = new_name or ''
                    fields.append('avatar')
                if fields:
                    user.save(update_fields=fields)
                if old_name and (new_name or remove):
                    transaction.on_commit(lambda: storage.delete(old_name), robust=True)
                request.user.full_name, request.user.avatar = user.full_name, user.avatar
        except Exception:
            if new_name:
                storage.delete(new_name)
            raise
        return profile_response(request)


class ProfileAvatarView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        avatar = request.user.avatar
        kind = AVATAR_TYPES.get(Path(avatar.name).suffix.lower()) if avatar else None
        if not kind:
            raise NotFound('No profile photo has been set.')
        try:
            stream = avatar.open('rb')
        except (FileNotFoundError, OSError):
            raise NotFound('Profile photo is unavailable.')
        response = FileResponse(stream, content_type=kind[1])
        response['Cache-Control'] = 'private, no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        response['Content-Security-Policy'] = "default-src 'none'; sandbox"
        return response
