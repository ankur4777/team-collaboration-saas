import importlib
import json
import tempfile
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.apps import apps
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import Client, TransactionTestCase, override_settings
from django.utils import timezone
from workspace.models import User, Organization, OrganizationMember, ChatConversation, ChatParticipant, ChatMessage, PrivateAttachment


class ChatFileMessagesTests(TransactionTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        scoped = override_settings(MEDIA_ROOT=temporary.name)
        scoped.enable()
        self.addCleanup(scoped.disable)
        self.me = User.objects.create_user(email='sender@test.invalid', full_name='Sender', password='password')
        self.peer = User.objects.create_user(email='peer@test.invalid', full_name='Peer', password='password')
        self.outsider = User.objects.create_user(email='outside@test.invalid', full_name='Outside', password='password')
        self.org = Organization.objects.create(name='Test', slug='file-test', created_by=self.me)
        for user in (self.me, self.peer, self.outsider):
            OrganizationMember.objects.create(organization=self.org, user=user, role='member')
        self.chat = ChatConversation.objects.create(organization=self.org, kind='direct', created_by=self.me)
        for user in (self.me, self.peer):
            ChatParticipant.objects.create(conversation=self.chat, user=user)
        self.client = self.login(self.me)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        self.url = f'/api/chats/{self.chat.pk}/attachments/'

    def login(self, user):
        client = Client(enforce_csrf_checks=True)
        client.force_login(user)
        session = client.session
        session['active_organization_id'] = str(self.org.pk)
        session.save()
        return client

    def upload(self, name='photo.png', content=b'\x89PNG\r\n\x1a\nimage', **fields):
        return self.client.post(self.url, {'file':SimpleUploadedFile(name, content), **fields}, HTTP_X_CSRFTOKEN=self.csrf)

    def test_send_creates_history_message_and_unread_notification(self):
        with patch('workspace.private_attachments.publish_chat_message') as live, patch('workspace.private_attachments.publish_notification_refresh') as notices:
            result = self.upload(caption='Project photo')
        self.assertEqual(result.status_code, 201, result.content)
        payload = result.json()
        message = ChatMessage.objects.get(pk=payload['message']['id'])
        self.assertEqual(message.body, 'Project photo')
        self.assertEqual(message.file_attachment.pk, PrivateAttachment.objects.get(pk=payload['id']).pk)
        live.assert_called_once()
        notices.assert_called_once()
        self.assertEqual(payload['message']['attachment']['name'], 'photo.png')
        peer = self.login(self.peer)
        history = peer.get(f'/api/chats/{self.chat.pk}/messages/').json()
        self.assertEqual(history[0]['attachment']['id'], payload['id'])
        self.assertEqual(peer.get('/api/chats/').json()[0]['unread_count'], 1)

    def test_no_caption_uses_filename_and_can_reply(self):
        original = ChatMessage.objects.create(conversation=self.chat, sender=self.peer, body='Send the document')
        result = self.upload(name='notes.txt', content=b'Notes', reply_to_id=str(original.pk))
        self.assertEqual(result.status_code, 201)
        self.assertEqual(result.json()['message']['body'], 'notes.txt')
        self.assertEqual(result.json()['message']['reply_to_id'], str(original.pk))

    def test_validation_does_not_create_messages_or_store_invalid_files(self):
        for kwargs in ({'content':b'bad image'}, {'caption':'x'*4001}, {'reply_to_id':str(self.outsider.pk)}):
            result = self.upload(**kwargs)
            self.assertEqual(result.status_code, 400, result.content)
        self.assertEqual(ChatMessage.objects.count(), 0)
        self.assertEqual(PrivateAttachment.objects.count(), 0)

    def test_preview_is_authenticated_and_only_images_render_inline(self):
        result = self.upload().json()
        url = f"/api/attachments/{result['id']}/download/?preview=1"
        received = self.client.get(url)
        self.assertEqual(received.status_code, 200)
        self.assertEqual(received['Content-Type'], 'image/png')
        self.assertIn('inline', received['Content-Disposition'])
        self.assertEqual(received['Cache-Control'], 'private, no-store')
        received.close()
        self.assertEqual(Client().get(url).status_code, 403)
        self.assertEqual(self.login(self.outsider).get(url).status_code, 404)
        document = self.upload(name='notes.pdf', content=b'%PDF-1.4 test').json()
        received = self.client.get(f"/api/attachments/{document['id']}/download/?preview=1")
        self.assertEqual(received['Content-Type'], 'application/octet-stream')
        self.assertIn('attachment', received['Content-Disposition'])
        received.close()

    def test_deleted_message_hides_file_and_blocks_download(self):
        result = self.upload().json()
        deleted = self.client.delete(f"/api/chats/{self.chat.pk}/messages/{result['message']['id']}/", HTTP_X_CSRFTOKEN=self.csrf)
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(self.client.get(self.url).json(), [])
        self.assertEqual(self.client.get(f"/api/attachments/{result['id']}/download/?preview=1").status_code, 403)
        self.assertIsNone(self.client.get(f'/api/chats/{self.chat.pk}/messages/').json()[0]['attachment'])

    def test_new_group_members_cannot_see_old_file_messages(self):
        self.chat.kind='group'
        self.chat.save(update_fields=['kind'])
        result = self.upload().json()
        ChatParticipant.objects.create(conversation=self.chat, user=self.outsider)
        newcomer = self.login(self.outsider)
        self.assertEqual(newcomer.get(f'/api/chats/{self.chat.pk}/messages/').json(), [])
        self.assertEqual(newcomer.get(self.url).json(), [])
        self.assertEqual(newcomer.get(f"/api/attachments/{result['id']}/download/").status_code, 403)

    def test_legacy_files_are_backfilled_once_at_the_original_time(self):
        attachment = PrivateAttachment.objects.create(organization=self.org, chat=self.chat, uploaded_by=self.me,
            file=SimpleUploadedFile('legacy.txt', b'legacy'), original_name='legacy.txt', size=6, content_type='text/plain')
        original_time = timezone.now()-timedelta(days=10)
        PrivateAttachment.objects.filter(pk=attachment.pk).update(created_at=original_time)
        migration = importlib.import_module('workspace.migrations.0034_chat_file_messages')
        migration.attach_existing_chat_files(apps, SimpleNamespace(connection=connection))
        migration.attach_existing_chat_files(apps, SimpleNamespace(connection=connection))
        attachment.refresh_from_db()
        self.assertEqual(ChatMessage.objects.count(), 1)
        self.assertEqual(attachment.chat_message.created_at, original_time)
        self.assertEqual(attachment.chat_message.body, 'legacy.txt')
