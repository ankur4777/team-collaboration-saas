"""Resolve reply targets without copying restricted history into new messages."""
from uuid import UUID

from rest_framework.exceptions import ValidationError


def resolve_reply_target(request, visible_messages):
    value = request.data.get('reply_to_id')
    if value is None:
        return None
    try:
        identity = UUID(str(value))
    except (ValueError, TypeError):
        raise ValidationError({'reply_to_id': 'Choose a valid original message'})
    target = visible_messages.select_for_update().filter(pk=identity, deleted_at__isnull=True).first()
    if target is None:
        raise ValidationError({'reply_to_id': 'Original message is unavailable in this conversation'})
    return target.pk
