"""Tenant-scoped direct and group chat APIs.

Chats are visible only to active organization members who are explicit
participants. All writes use authenticated session/CSRF via DRF.
"""
import hashlib
import logging
from uuid import UUID

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ChatConversation, ChatMessage, ChatParticipant, ChatReaction, OrganizationMember
from .permissions import get_active_membership
from .notification_events import publish_notification_refresh
from .mentions import create_mentions
from .message_replies import resolve_reply_target
from .serializers import ChatConversationSerializer, ChatMessageSerializer


logger = logging.getLogger(__name__)


def accessible_chat(request, chat_id):
    from .license_access import require_module
    membership = get_active_membership(request)
    require_module(membership.organization_id, 'chats')
    return get_object_or_404(
        ChatConversation.objects.filter(
            organization_id=membership.organization_id,
            participants__user=request.user,
        ),
        pk=chat_id,
    )


def chat_key(org_id, first_id, second_id):
    ids = sorted((str(first_id), str(second_id)))
    return hashlib.sha256(f'{org_id}:{ids[0]}:{ids[1]}'.encode()).hexdigest()


def publish_chat_message(chat_id, payload, action='message'):
    try:
        async_to_sync(get_channel_layer().group_send)(
            f'private_chat_{chat_id}',
            {'type': 'chat.message', 'message': payload, 'action': action},
        )
    except Exception:
        # The message is already durable; clients can reload if Redis fails.
        logger.exception('Could not broadcast private chat event %s', chat_id)


def publish_chat_read(chat_id, user_id, read_at):
    try:
        async_to_sync(get_channel_layer().group_send)(
            f'private_chat_{chat_id}',
            {'type': 'chat.read', 'user_id': str(user_id), 'read_at': read_at.isoformat()},
        )
    except Exception:
        logger.exception('Could not broadcast read receipt %s', chat_id)


def publish_chat_participants(chat_id):
    try:
        async_to_sync(get_channel_layer().group_send)(
            f'private_chat_{chat_id}', {'type': 'chat.participants'},
        )
    except Exception:
        logger.exception('Could not broadcast chat participants %s', chat_id)


def manage_group(request, chat_id):
    chat = accessible_chat(request, chat_id)
    chat = ChatConversation.objects.select_for_update().get(pk=chat.pk)
    if not ChatParticipant.objects.filter(conversation=chat, user=request.user).exists():
        raise PermissionDenied('Group membership required')
    if chat.kind != ChatConversation.Kind.GROUP:
        raise ValidationError({'detail': 'Only group chats support participant management'})
    if chat.created_by_id != request.user.id:
        raise PermissionDenied('Only the group creator can manage participants')
    return chat


class ChatParticipantsView(APIView):
    @transaction.atomic
    def post(self, request, chat_id):
        chat = manage_group(request, chat_id)
        email = str(request.data.get('email', '')).strip().lower()
        membership = (OrganizationMember.objects.select_related('user')
                      .filter(organization_id=chat.organization_id,
                              user__email__iexact=email, user__is_active=True).first())
        if not membership:
            raise ValidationError({'email': 'Choose an active employee of this workspace'})
        with transaction.atomic():
            ChatConversation.objects.select_for_update().get(pk=chat.pk)
            if ChatParticipant.objects.filter(conversation=chat, user=membership.user).exists():
                raise ValidationError({'email': 'Employee is already a group participant'})
            if ChatParticipant.objects.filter(conversation=chat).count() >= 25:
                raise ValidationError({'email': 'Groups are limited to 25 participants'})
            ChatParticipant.objects.create(conversation=chat, user=membership.user)
            transaction.on_commit(lambda: publish_chat_participants(chat.pk))
        chat = ChatConversation.objects.prefetch_related('participants__user').get(pk=chat.pk)
        return Response(ChatConversationSerializer(chat).data, status=status.HTTP_201_CREATED)


class ChatParticipantDetailView(APIView):
    @transaction.atomic
    def delete(self, request, chat_id, user_id):
        chat = manage_group(request, chat_id)
        if chat.created_by_id == user_id:
            raise PermissionDenied('Group creator cannot be removed')
        with transaction.atomic():
            ChatConversation.objects.select_for_update().get(pk=chat.pk)
            participant = get_object_or_404(ChatParticipant, conversation=chat, user_id=user_id)
            participant.delete()
            transaction.on_commit(lambda: publish_chat_participants(chat.pk))
        return Response(status=status.HTTP_204_NO_CONTENT)


class ChatGroupDetailView(APIView):
    @transaction.atomic
    def delete(self, request, chat_id):
        from .directory import can_delete_group
        actor = get_active_membership(request)
        chat = accessible_chat(request, chat_id)
        chat = ChatConversation.objects.select_for_update().get(pk=chat.pk)
        if not can_delete_group(actor, chat):
            raise PermissionDenied('Only the creating Senior, an owner, or an admin can delete a project group.')
        chat_id, org_id = chat.pk, chat.organization_id
        recipients = list(chat.participants.values_list('user_id', flat=True))
        files = [(row.file.storage, row.file.name) for row in chat.attachments.all()]
        chat.delete()
        for storage, name in files:
            transaction.on_commit(lambda storage=storage, name=name: storage.delete(name), robust=True)
        transaction.on_commit(lambda: publish_chat_participants(chat_id))
        transaction.on_commit(lambda: publish_notification_refresh(org_id, recipients))
        return Response(status=status.HTTP_204_NO_CONTENT)

    @transaction.atomic
    def patch(self, request, chat_id):
        chat = manage_group(request, chat_id)
        title = request.data.get('title')
        if not isinstance(title, str) or not 2 <= len(title.strip()) <= 100:
            raise ValidationError({'title': 'Group name must be 2–100 characters'})
        chat.title = title.strip()
        chat.save(update_fields=['title'])
        transaction.on_commit(lambda: publish_chat_participants(chat.pk))
        return Response(ChatConversationSerializer(chat, context={'request': request}).data)


class ChatOwnershipView(APIView):
    @transaction.atomic
    def post(self, request, chat_id):
        chat = manage_group(request, chat_id)
        try:
            target_id = UUID(str(request.data.get('user_id', '')))
        except (ValueError, TypeError):
            raise ValidationError({'user_id': 'Choose a valid participant'})
        if target_id == request.user.pk or not ChatParticipant.objects.filter(
            conversation=chat, user_id=target_id, user__is_active=True,
            user__organization_memberships__organization_id=chat.organization_id,
        ).exists():
            raise ValidationError({'user_id': 'Choose another active group participant'})
        chat.created_by_id = target_id
        chat.save(update_fields=['created_by'])
        transaction.on_commit(lambda: publish_chat_participants(chat.pk))
        return Response(status=status.HTTP_204_NO_CONTENT)


class ChatLeaveView(APIView):
    @transaction.atomic
    def post(self, request, chat_id):
        chat = accessible_chat(request, chat_id)
        chat = ChatConversation.objects.select_for_update().get(pk=chat.pk)
        if chat.kind != ChatConversation.Kind.GROUP:
            raise ValidationError({'detail': 'Only group chats can be left'})
        participant = get_object_or_404(ChatParticipant, conversation=chat, user=request.user)
        if chat.created_by_id == request.user.pk:
            raise ValidationError({'detail': 'Transfer group ownership before leaving'})
        participant.delete()
        transaction.on_commit(lambda: publish_chat_participants(chat.pk))
        transaction.on_commit(lambda: publish_notification_refresh(chat.organization_id, [request.user.pk]))
        return Response(status=status.HTTP_204_NO_CONTENT)


class ChatArchiveView(APIView):
    @transaction.atomic
    def post(self, request, chat_id):
        chat = accessible_chat(request, chat_id)
        desired = request.data.get('archived')
        if type(desired) is not bool:
            raise ValidationError({'archived': 'Provide true or false'})
        participant = get_object_or_404(ChatParticipant.objects.select_for_update(),
                                       conversation=chat, user=request.user)
        if bool(participant.archived_at) != desired:
            participant.archived_at = timezone.now() if desired else None
            participant.save(update_fields=['archived_at'])
        return Response({'archived_at': participant.archived_at})


class ChatsView(APIView):
    def get(self, request):
        membership = get_active_membership(request)
        conversations = (
            ChatConversation.objects.filter(
                organization_id=membership.organization_id,
                participants__user=request.user,
            )
            .prefetch_related('participants__user')
            .order_by('-updated_at', '-created_at')[:200]
        )
        return Response(ChatConversationSerializer(conversations, many=True, context={'request': request}).data)

    def post(self, request):
        membership = get_active_membership(request)
        kind = request.data.get('kind')
        if kind == ChatConversation.Kind.DIRECT:
            email = str(request.data.get('email', '')).lower().strip()
            target = (OrganizationMember.objects.select_related('user')
                      .filter(organization_id=membership.organization_id,
                              user__email__iexact=email, user__is_active=True).first())
            if not target or target.user_id == request.user.id:
                raise ValidationError({'email': 'Choose another employee in this workspace'})
            key = chat_key(membership.organization_id, request.user.id, target.user_id)
            with transaction.atomic():
                chat, created = ChatConversation.objects.get_or_create(
                    direct_key=key,
                    defaults={
                        'organization_id': membership.organization_id,
                        'kind': ChatConversation.Kind.DIRECT,
                        'created_by': request.user,
                    },
                )
                if created:
                    ChatParticipant.objects.bulk_create([
                        ChatParticipant(conversation=chat, user=request.user),
                        ChatParticipant(conversation=chat, user=target.user),
                    ])
            ChatParticipant.objects.filter(conversation=chat, user=request.user).update(archived_at=None)
            chat = ChatConversation.objects.prefetch_related('participants__user').get(pk=chat.pk)
            if created:
                publish_notification_refresh(chat.organization_id, [request.user.pk, target.user_id])
            return Response(
                ChatConversationSerializer(chat).data,
                status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
            )

        if kind == ChatConversation.Kind.GROUP:
            from .directory import is_senior
            if not is_senior(membership):
                raise PermissionDenied('Only employees with the Senior role, owners, and admins can create project groups.')
            title = str(request.data.get('title', '')).strip()
            emails = request.data.get('emails')
            if len(title) < 2 or len(title) > 100:
                raise ValidationError({'title': 'Group name must be 2–100 characters'})
            if not isinstance(emails, list):
                raise ValidationError({'emails': 'Provide a list of employee email addresses'})
            if not 2 <= len(emails) <= 24 or not all(isinstance(e, str) for e in emails):
                raise ValidationError({'emails': 'Choose 2–24 teammates for a group'})
            addresses = [e.strip().lower() for e in emails]
            if (len(set(addresses)) != len(addresses)
                    or request.user.email.lower() in addresses
                    or any(not e or len(e) > 254 for e in addresses)):
                raise ValidationError({'emails': 'Use unique teammate emails, excluding your own'})
            members = list(
                OrganizationMember.objects.select_related('user')
                .filter(organization_id=membership.organization_id,
                        user__email__in=addresses, user__is_active=True)
            )
            if len(members) != len(addresses):
                raise ValidationError({'emails': 'Every teammate must belong to this workspace'})

            with transaction.atomic():
                chat = ChatConversation.objects.create(
                    organization=membership.organization,
                    kind=ChatConversation.Kind.GROUP,
                    title=title,
                    created_by=request.user,
                )
                ChatParticipant.objects.bulk_create(
                    [ChatParticipant(conversation=chat, user=request.user)] +
                    [ChatParticipant(conversation=chat, user=m.user) for m in members]
                )
            chat = ChatConversation.objects.prefetch_related('participants__user').get(pk=chat.pk)
            publish_notification_refresh(
                chat.organization_id, [request.user.pk] + [m.user_id for m in members],
            )
            return Response(ChatConversationSerializer(chat).data, status=status.HTTP_201_CREATED)

        raise ValidationError({'kind': 'Choose direct or group chat'})


class ChatMessagesView(APIView):
    def get(self, request, chat_id):
        chat = accessible_chat(request, chat_id)
        records = ChatMessage.objects.filter(conversation=chat).select_related('sender', 'file_attachment__uploaded_by').prefetch_related('reactions')
        # Newly invited group participants see messages from their join date,
        # not the historical conversation that existed before their invitation.
        if chat.kind == ChatConversation.Kind.GROUP:
            participant = ChatParticipant.objects.get(conversation=chat, user=request.user)
            records = records.filter(created_at__gte=participant.joined_at)
        before = request.query_params.get('before')
        before_id = request.query_params.get('before_id')
        paged = request.query_params.get('page')
        if paged is not None and paged != '1':
            raise ValidationError({'page': 'Use page=1 to request a paginated response'})
        if before_id is not None and not before:
            raise ValidationError({'before_id': 'Provide before with before_id'})
        if before is not None:
            try:
                value = parse_datetime(before)
            except ValueError:
                value = None
            if value is None or timezone.is_naive(value):
                raise ValidationError({'before': 'Use an ISO 8601 timestamp with timezone'})
            if before_id is not None:
                try:
                    cursor_id = UUID(before_id)
                except (TypeError, ValueError, AttributeError):
                    raise ValidationError({'before_id': 'Provide a valid message UUID'})
                records = records.filter(
                    Q(created_at__lt=value) | Q(created_at=value, id__lt=cursor_id)
                )
            else:
                records = records.filter(created_at__lt=value)
        rows = list(records.order_by('-created_at', '-id')[:51 if paged else 50])
        if paged:
            has_more = len(rows) > 50
            rows = rows[:50]
            oldest = rows[-1] if rows else None
            cursor = ({
                'before': oldest.created_at.isoformat(),
                'before_id': str(oldest.pk),
            } if has_more and oldest else None)
            rows.reverse()
            return Response({
                'items': ChatMessageSerializer(rows, many=True).data,
                'has_more': has_more,
                'next_cursor': cursor,
            })
        rows.reverse()
        return Response(ChatMessageSerializer(rows, many=True).data)

    def post(self, request, chat_id):
        chat = accessible_chat(request, chat_id)
        body = str(request.data.get('body', '')).strip()
        if not body or len(body) > 4000:
            raise ValidationError({'body': 'Message must contain 1–4000 characters'})
        with transaction.atomic():
            reply_id = resolve_reply_target(request, visible_chat_messages(request, chat))
            message = ChatMessage.objects.create(conversation=chat, sender=request.user, body=body, reply_to_id=reply_id)
            ChatConversation.objects.filter(pk=chat.pk).update(updated_at=timezone.now())
            payload = ChatMessageSerializer(message).data
            transaction.on_commit(lambda: publish_chat_message(chat.pk, payload))
            active_participants = list(ChatParticipant.objects.filter(
                conversation=chat,
                user__organization_memberships__organization_id=chat.organization_id,
                user__is_active=True,
            ).select_related('user').distinct())
            create_mentions(
                organization_id=chat.organization_id, sender_id=request.user.pk,
                body=body, eligible_users=[participant.user for participant in active_participants],
                chat_message=message,
            )
            recipients = [participant.user_id for participant in active_participants]
            transaction.on_commit(
                lambda: publish_notification_refresh(chat.organization_id, recipients)
            )
        return Response(payload, status=status.HTTP_201_CREATED)


def visible_chat_messages(request, chat):
    records = ChatMessage.objects.filter(conversation=chat)
    if chat.kind == ChatConversation.Kind.GROUP:
        participant = get_object_or_404(ChatParticipant, conversation=chat, user=request.user)
        records = records.filter(created_at__gte=participant.joined_at)
    return records


class ChatMessageDetailView(APIView):
    """Only the author may edit or soft-delete a message in a chat they can access."""

    def patch(self, request, chat_id, message_id):
        chat = accessible_chat(request, chat_id)
        body = str(request.data.get('body', '')).strip()
        if not body or len(body) > 4000:
            raise ValidationError({'body': 'Message must contain 1–4000 characters'})
        with transaction.atomic():
            message = get_object_or_404(
                visible_chat_messages(request, chat).select_for_update().select_related('sender'),
                pk=message_id,
            )
            if message.sender_id != request.user.id:
                raise PermissionDenied('Only the author can edit this message')
            if message.deleted_at:
                raise ValidationError({'detail': 'Deleted messages cannot be edited'})
            message.body = body
            message.edited_at = timezone.now()
            message.save(update_fields=['body', 'edited_at'])
            payload = ChatMessageSerializer(message).data
            transaction.on_commit(
                lambda: publish_chat_message(chat.pk, payload, action='message.updated')
            )
        return Response(payload)

    def delete(self, request, chat_id, message_id):
        chat = accessible_chat(request, chat_id)
        with transaction.atomic():
            message = get_object_or_404(
                visible_chat_messages(request, chat).select_for_update().select_related('sender'),
                pk=message_id,
            )
            if message.sender_id != request.user.id:
                raise PermissionDenied('Only the author can delete this message')
            if message.deleted_at is None:
                # Soft-delete without retaining deleted message contents.
                message.body = ''
                message.deleted_at = timezone.now()
                message.pinned_at = None
                message.save(update_fields=['body', 'deleted_at', 'pinned_at'])
                message.reactions.all().delete()
                payload = ChatMessageSerializer(message).data
                transaction.on_commit(
                    lambda: publish_chat_message(chat.pk, payload, action='message.deleted')
                )
        return Response(status=status.HTTP_204_NO_CONTENT)


class ChatReactionView(APIView):
    """Toggle a supported emoji on a message visible to the active chat member."""
    ALLOWED_EMOJIS = ('👍', '✅', '👏', '🙏', '🤝', '🎉', '💡', '👌', '💯', '❤️', '😂', '👀')

    def post(self, request, chat_id, message_id):
        chat = accessible_chat(request, chat_id)
        emoji = request.data.get('emoji')
        if not isinstance(emoji, str) or emoji not in self.ALLOWED_EMOJIS:
            raise ValidationError({'emoji': 'Choose one of the supported reaction emojis'})
        with transaction.atomic():
            message = get_object_or_404(
                ChatMessage.objects.select_for_update(), pk=message_id, conversation=chat,
            )
            if message.deleted_at is not None:
                raise ValidationError({'detail': 'Cannot react to a deleted message'})
            if chat.kind == ChatConversation.Kind.GROUP:
                participant = ChatParticipant.objects.get(conversation=chat, user=request.user)
                if message.created_at < participant.joined_at:
                    raise PermissionDenied('This message predates your group membership')
            # Serialize changes under the message lock: one reaction per user.
            own = ChatReaction.objects.filter(message=message, user=request.user)
            same = own.filter(emoji=emoji).exists()
            own.delete()
            if not same:
                ChatReaction.objects.create(message=message, user=request.user, emoji=emoji)
            updated = ChatMessage.objects.select_related('sender').prefetch_related('reactions').get(pk=message.pk)
            payload = ChatMessageSerializer(updated).data
            transaction.on_commit(
                lambda: publish_chat_message(chat.pk, payload, action='message.updated')
            )
        return Response(payload)


class ChatReadView(APIView):
    """A read receipt advances only to a message the member actually names.

    The browser calls this after displaying the message. Never mark a whole
    conversation read just because its list endpoint was polled.
    """

    def post(self, request, chat_id):
        chat = accessible_chat(request, chat_id)
        message_id = request.data.get('message_id')
        if not message_id:
            raise ValidationError({'message_id': 'Provide the last displayed message ID'})
        message = get_object_or_404(
            ChatMessage, pk=message_id, conversation=chat,
        )
        with transaction.atomic():
            participant = ChatParticipant.objects.select_for_update().get(
                conversation=chat, user=request.user,
            )
            if message.created_at < participant.joined_at:
                raise ValidationError({'message_id': 'Message predates your membership'})
            if participant.last_read_at is None or message.created_at > participant.last_read_at:
                participant.last_read_at = message.created_at
                participant.save(update_fields=['last_read_at'])
                updated = True
            else:
                updated = False
            read_at = participant.last_read_at
            if updated:
                transaction.on_commit(
                    lambda: publish_chat_read(chat.pk, request.user.pk, read_at)
                )
        return Response({'last_read_at': read_at.isoformat()})

