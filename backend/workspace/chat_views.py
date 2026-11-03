"""Tenant-scoped direct and group chat APIs.

Chats are visible only to active organization members who are explicit
participants. All writes use authenticated session/CSRF via DRF.
"""
import hashlib
import logging

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import ChatConversation, ChatMessage, ChatParticipant, OrganizationMember
from .permissions import get_active_membership
from .serializers import ChatConversationSerializer, ChatMessageSerializer


logger = logging.getLogger(__name__)


def accessible_chat(request, chat_id):
    membership = get_active_membership(request)
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
    if chat.kind != ChatConversation.Kind.GROUP:
        raise ValidationError({'detail': 'Only group chats support participant management'})
    if chat.created_by_id != request.user.id:
        raise PermissionDenied('Only the group creator can manage participants')
    return chat


class ChatParticipantsView(APIView):
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
            chat = ChatConversation.objects.prefetch_related('participants__user').get(pk=chat.pk)
            return Response(
                ChatConversationSerializer(chat).data,
                status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
            )

        if kind == ChatConversation.Kind.GROUP:
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
            return Response(ChatConversationSerializer(chat).data, status=status.HTTP_201_CREATED)

        raise ValidationError({'kind': 'Choose direct or group chat'})


class ChatMessagesView(APIView):
    def get(self, request, chat_id):
        chat = accessible_chat(request, chat_id)
        records = ChatMessage.objects.filter(conversation=chat).select_related('sender')
        # Newly invited group participants see messages from their join date,
        # not the historical conversation that existed before their invitation.
        if chat.kind == ChatConversation.Kind.GROUP:
            participant = ChatParticipant.objects.get(conversation=chat, user=request.user)
            records = records.filter(created_at__gte=participant.joined_at)
        before = request.query_params.get('before')
        if before:
            value = parse_datetime(before)
            if value is None or timezone.is_naive(value):
                raise ValidationError({'before': 'Use an ISO 8601 timestamp with timezone'})
            records = records.filter(created_at__lt=value)
        records = list(records.order_by('-created_at', '-id')[:50])
        records.reverse()
        return Response(ChatMessageSerializer(records, many=True).data)

    def post(self, request, chat_id):
        chat = accessible_chat(request, chat_id)
        body = str(request.data.get('body', '')).strip()
        if not body or len(body) > 4000:
            raise ValidationError({'body': 'Message must contain 1–4000 characters'})
        with transaction.atomic():
            message = ChatMessage.objects.create(conversation=chat, sender=request.user, body=body)
            ChatConversation.objects.filter(pk=chat.pk).update(updated_at=timezone.now())
            payload = ChatMessageSerializer(message).data
            transaction.on_commit(lambda: publish_chat_message(chat.pk, payload))
        return Response(payload, status=status.HTTP_201_CREATED)


class ChatMessageDetailView(APIView):
    """Only the author may edit or soft-delete a message in a chat they can access."""

    def patch(self, request, chat_id, message_id):
        chat = accessible_chat(request, chat_id)
        body = str(request.data.get('body', '')).strip()
        if not body or len(body) > 4000:
            raise ValidationError({'body': 'Message must contain 1–4000 characters'})
        with transaction.atomic():
            message = get_object_or_404(
                ChatMessage.objects.select_for_update().select_related('sender'),
                pk=message_id, conversation=chat,
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
                ChatMessage.objects.select_for_update().select_related('sender'),
                pk=message_id, conversation=chat,
            )
            if message.sender_id != request.user.id:
                raise PermissionDenied('Only the author can delete this message')
            if message.deleted_at is None:
                # Soft-delete without retaining deleted message contents.
                message.body = ''
                message.deleted_at = timezone.now()
                message.save(update_fields=['body', 'deleted_at'])
                payload = ChatMessageSerializer(message).data
                transaction.on_commit(
                    lambda: publish_chat_message(chat.pk, payload, action='message.deleted')
                )
        return Response(status=status.HTTP_204_NO_CONTENT)


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
