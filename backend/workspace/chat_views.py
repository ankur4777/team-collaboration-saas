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
from rest_framework.exceptions import ValidationError
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


def publish_chat_message(chat_id, payload):
    try:
        async_to_sync(get_channel_layer().group_send)(
            f'private_chat_{chat_id}',
            {'type': 'chat.message', 'message': payload},
        )
    except Exception:
        # The message is already durable; clients can reload if Redis fails.
        logger.exception('Could not broadcast private chat event %s', chat_id)


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
        return Response(ChatConversationSerializer(conversations, many=True).data)

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
