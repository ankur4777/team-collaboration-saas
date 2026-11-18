"""Private attachments must remain readable only to authorized workspace members."""
import json
import tempfile

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings

from workspace.models import (
    Channel, Organization, OrganizationMember, PrivateAttachment, Team, TeamMember,
)


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class PrivateAttachmentTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        scoped = override_settings(MEDIA_ROOT=self.temp.name)
        scoped.enable()
        self.addCleanup(scoped.disable)
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        result = self.json_post('/api/auth/register/', {
            'email':'owner@test.invalid', 'password':'StrongPassword123!',
            'full_name':'Owner', 'organization_name':'Example',
        })
        self.assertEqual(result.status_code, 201, result.content)
        self.owner = get_user_model().objects.get(email='owner@test.invalid')
        self.org = Organization.objects.get(pk=result.json()['active_organization_id'])
        self.team = Team.objects.create(organization=self.org, created_by=self.owner, name='Engineering')
        TeamMember.objects.create(team=self.team, user=self.owner, role=TeamMember.Role.OWNER)
        self.channel = Channel.objects.create(team=self.team, name='General')

    def json_post(self, url, data=None):
        result = self.client.post(url, data=json.dumps(data or {}),
                                  content_type='application/json',
                                  HTTP_X_CSRFTOKEN=self.csrf)
        if result.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return result

    def login(self, email):
        self.assertEqual(self.json_post('/api/auth/logout/').status_code, 200)
        result = self.json_post('/api/auth/login/', {
            'email':email, 'password':'StrongPassword123!',
        })
        self.assertEqual(result.status_code, 200, result.content)

    def employee(self, email, name, *, org=None, team=False):
        user = get_user_model().objects.create_user(
            email=email, password='StrongPassword123!', full_name=name,
        )
        OrganizationMember.objects.create(organization=org or self.org, user=user)
        if team:
            TeamMember.objects.create(team=self.team, user=user)
        return user

    def post_file(self, url, upload):
        return self.client.post(url, {'file':upload}, HTTP_X_CSRFTOKEN=self.csrf)

    def upload_txt(self, destination, value=b'Private information'):
        return self.post_file(destination, SimpleUploadedFile(
            'notes.txt', value, content_type='text/plain',
        ))

    def test_channel_upload_and_private_download(self):
        uploaded = self.upload_txt(f'/api/channels/{self.channel.pk}/attachments/')
        self.assertEqual(uploaded.status_code, 201, uploaded.content)
        data = uploaded.json()
        self.assertEqual(data['name'], 'notes.txt')
        listed = self.client.get(f'/api/channels/{self.channel.pk}/attachments/')
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.json()), 1)
        received = self.client.get(f"/api/attachments/{data['id']}/download/")
        self.assertEqual(received.status_code, 200)
        self.assertEqual(b''.join(received.streaming_content), b'Private information')
        self.assertIn('attachment', received['Content-Disposition'])
        self.assertEqual(received['Cache-Control'], 'private, no-store')
        self.assertEqual(received['X-Content-Type-Options'], 'nosniff')

    def test_disallow_disguised_or_oversized_uploads(self):
        url = f'/api/channels/{self.channel.pk}/attachments/'
        for filename, content in [
            ('malware.pdf', b'<html>wrong</html>'),
            ('app.svg', b'<svg/>'),
            ('script.js', b'alert(1)'),
            ('large.txt', b'x' * (5*1024*1024+1)),
        ]:
            response = self.post_file(url, SimpleUploadedFile(filename, content))
            self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(PrivateAttachment.objects.count(), 0)

    def test_removed_team_member_cannot_list_or_download(self):
        alice = self.employee('alice@test.invalid', 'Alice', team=True)
        uploaded = self.upload_txt(f'/api/channels/{self.channel.pk}/attachments/')
        self.assertEqual(uploaded.status_code, 201, uploaded.content)
        attachment_id = uploaded.json()['id']
        self.login(alice.email)
        self.assertEqual(
            self.client.get(f'/api/attachments/{attachment_id}/download/').status_code, 200,
        )
        TeamMember.objects.filter(team=self.team, user=alice).delete()
        self.assertIn(
            self.client.get(f'/api/attachments/{attachment_id}/download/').status_code,
            (403,404),
        )
        self.assertIn(
            self.client.get(f'/api/channels/{self.channel.pk}/attachments/').status_code,
            (403,404),
        )

    def test_chat_attachment_participants_only(self):
        alice = self.employee('alice@test.invalid', 'Alice')
        outsider = self.employee('outsider@test.invalid', 'Outsider')
        chat = self.json_post('/api/chats/', {'kind':'direct', 'email':alice.email})
        self.assertEqual(chat.status_code, 201, chat.content)
        chat_id = chat.json()['id']
        uploaded = self.upload_txt(f'/api/chats/{chat_id}/attachments/')
        self.assertEqual(uploaded.status_code, 201, uploaded.content)
        attachment_id = uploaded.json()['id']
        self.login(outsider.email)
        self.assertEqual(self.client.get(f'/api/chats/{chat_id}/attachments/').status_code, 404)
        self.assertEqual(self.client.get(f'/api/attachments/{attachment_id}/download/').status_code, 404)
        self.login(alice.email)
        self.assertEqual(len(self.client.get(f'/api/chats/{chat_id}/attachments/').json()), 1)
        downloaded = self.client.get(f'/api/attachments/{attachment_id}/download/')
        self.assertEqual(downloaded.status_code, 200)
        downloaded.close()

    def test_different_active_organization_cannot_access_files(self):
        alice = self.employee('alice@test.invalid', 'Alice', team=True)
        uploaded = self.upload_txt(f'/api/channels/{self.channel.pk}/attachments/')
        self.assertEqual(uploaded.status_code, 201)
        attachment_id = uploaded.json()['id']
        other = Organization.objects.create(name='Another', slug='other-attachments-org', created_by=self.owner)
        OrganizationMember.objects.create(organization=other, user=alice)
        self.login(alice.email)
        self.assertEqual(self.client.get(f'/api/attachments/{attachment_id}/download/').status_code, 200)
        switched = self.json_post(f'/api/organizations/{other.pk}/activate/')
        self.assertEqual(switched.status_code, 200, switched.content)
        self.assertEqual(self.client.get(f'/api/attachments/{attachment_id}/download/').status_code, 404)
