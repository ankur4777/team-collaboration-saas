"""Low-sensitivity, user-scoped notification refresh signals.

The transport never includes message text, email addresses, unread totals or
membership data. Recipients re-fetch the existing tenant-scoped REST APIs.
"""
import logging

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

logger = logging.getLogger(__name__)


def notification_group(organization_id, user_id):
    return f'alerts_{organization_id}_{user_id}'


def publish_notification_refresh(organization_id, recipient_ids):
    """Best-effort fanout; durable messages do not depend on Redis availability."""
    layer = get_channel_layer()
    for user_id in set(recipient_ids):
        try:
            async_to_sync(layer.group_send)(
                notification_group(organization_id, user_id),
                {'type': 'notification.refresh'},
            )
        except Exception:
            logger.exception('Notification refresh broadcast failed')
