import json
import tempfile
from io import BytesIO

from PIL import Image
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TransactionTestCase, override_settings
from django.test.client import encode_multipart, BOUNDARY, MULTIPART_CONTENT

from workspace.models import ChatConversation, ChatParticipant, Organization, OrganizationMember, User


class ProfileTests(TransactionTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        scoped = override_settings(MEDIA_ROOT=temporary.name)
        scoped.enable()
        self.addCleanup(scoped.disable)
        self.user = User.objects.create_user(email='profile@example.com', full_name='Original', password='password')
        self.other = User.objects.create_user(email='other@example.com', full_name='Other', password='password')
        self.client = Client(enforce_csrf_checks=True)
        self.client.force_login(self.user)
        self.token = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def patch(self, data):
        return self.client.patch('/api/auth/profile/', json.dumps(data), content_type='application/json', HTTP_X_CSRFTOKEN=self.token)

    def upload(self, image, **fields):
        return self.client.patch('/api/auth/profile/', encode_multipart(BOUNDARY, {'avatar': image, **fields}),
                                 content_type=MULTIPART_CONTENT, HTTP_X_CSRFTOKEN=self.token)

    def image(self, kind='PNG', suffix='png', size=(16, 16)):
        data = BytesIO()
        Image.new('RGB', size, '#e73535').save(data, format=kind)
        return SimpleUploadedFile(f'personal-photo.{suffix}', data.getvalue(), content_type=f'image/{suffix}')

    def test_own_profile_and_name_update_without_workspace(self):
        self.assertEqual(self.client.get('/api/auth/profile/').json()['full_name'], 'Original')
        result = self.patch({'full_name': '  New Name  '})
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual(result.json()['full_name'], 'New Name')
        self.assertIsNone(result.json()['avatar_url'])
        self.user.refresh_from_db()
        self.other.refresh_from_db()
        self.assertEqual(self.user.full_name, 'New Name')
        self.assertEqual(self.other.full_name, 'Other')
        self.assertEqual(self.client.get('/api/auth/me/').json()['user']['full_name'], 'New Name')

    def test_only_display_name_and_photo_can_be_changed(self):
        for data in ({'email': 'changed@example.com'}, {'is_staff': True}, {'is_superuser': True},
                     {'is_senior': True}, {'id': str(self.other.pk)}, {'role': 'admin'},
                     {'full_name': '   '}, {'full_name': 'x' * 151}, {'full_name': None}, {}):
            with self.subTest(data=data):
                self.assertEqual(self.patch(data).status_code, 400)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, 'profile@example.com')
        self.assertFalse(self.user.is_staff)
        self.assertFalse(self.user.is_superuser)
        self.assertEqual(self.user.full_name, 'Original')

    def test_image_formats_private_read_replace_and_remove(self):
        previous = None
        for kind, suffix, content_type in [('PNG', 'png', 'image/png'), ('JPEG', 'jpg', 'image/jpeg'), ('WEBP', 'webp', 'image/webp')]:
            result = self.upload(self.image(kind, suffix), full_name='With photo')
            self.assertEqual(result.status_code, 200, result.content)
            self.user.refresh_from_db()
            storage = self.user.avatar.storage
            self.assertTrue(storage.exists(self.user.avatar.name))
            if previous:
                self.assertFalse(storage.exists(previous))
            previous = self.user.avatar.name
            url = result.json()['avatar_url']
            self.assertNotIn('personal-photo', url)
            received = self.client.get(url)
            self.assertEqual(received.status_code, 200)
            self.assertEqual(received['Content-Type'], content_type)
            self.assertEqual(received['Cache-Control'], 'private, no-store')
            self.assertTrue(b''.join(received.streaming_content))
            received.close()
            other_client = Client()
            other_client.force_login(self.other)
            self.assertEqual(other_client.get(url).status_code, 404)
        result = self.patch({'remove_avatar': True})
        self.assertEqual(result.status_code, 200)
        self.assertIsNone(result.json()['avatar_url'])
        self.assertFalse(storage.exists(previous))
        self.assertEqual(self.client.get('/api/auth/profile/avatar/').status_code, 404)

    def test_invalid_images_leave_existing_profile_unchanged(self):
        self.assertEqual(self.upload(self.image()).status_code, 200)
        self.user.refresh_from_db()
        original_photo = self.user.avatar.name
        invalid = [SimpleUploadedFile('bad.svg', b'<svg/>'), SimpleUploadedFile('bad.png', b'<html>bad</html>'),
                   SimpleUploadedFile('empty.png', b''), SimpleUploadedFile('large.png', b'x' * (2 * 1024 * 1024 + 1)),
                   self.image('PNG', 'jpg'), self.image(size=(4097, 1))]
        for image in invalid:
            with self.subTest(image=image.name):
                result = self.upload(image, full_name='Must not save')
                self.assertEqual(result.status_code, 400, result.content)
        self.assertEqual(self.upload(self.image(), remove_avatar='true').status_code, 400)
        self.user.refresh_from_db()
        self.assertEqual(self.user.full_name, 'Original')
        self.assertEqual(self.user.avatar.name, original_photo)

    def test_requires_login_and_csrf(self):
        anonymous = Client()
        for url in ('/api/auth/profile/', '/api/auth/profile/avatar/'):
            self.assertEqual(anonymous.get(url).status_code, 403)
        result = self.client.patch('/api/auth/profile/', json.dumps({'full_name': 'No token'}), content_type='application/json')
        self.assertEqual(result.status_code, 403)
        self.user.refresh_from_db()
        self.assertEqual(self.user.full_name, 'Original')

    def test_chat_photo_requires_current_chat_participation(self):
        workspace = Organization.objects.create(name='Workspace', slug='profile-test', created_by=self.user)
        outsider = User.objects.create_user(email='outside@example.com', full_name='Outside')
        for user in (self.user, self.other, outsider):
            OrganizationMember.objects.create(organization=workspace, user=user)
        chat = ChatConversation.objects.create(organization=workspace, kind='direct', created_by=self.user)
        for user in (self.user, self.other):
            ChatParticipant.objects.create(conversation=chat, user=user)

        self.assertEqual(self.upload(self.image()).status_code, 200)

        def client_for(user):
            client = Client()
            client.force_login(user)
            session = client.session
            session['active_organization_id'] = str(workspace.pk)
            session.save()
            return client

        peer = client_for(self.other)
        participant = next(row['user'] for row in peer.get('/api/chats/').json()[0]['participants']
                           if row['user']['id'] == str(self.user.pk))
        url = participant['avatar_url']
        response = peer.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'image/png')
        response.close()
        self.assertEqual(client_for(outsider).get(url).status_code, 404)
        OrganizationMember.objects.filter(organization=workspace, user=self.user).delete()
        self.assertEqual(peer.get(url).status_code, 404)
