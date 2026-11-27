"""Shared file deletion requires CSRF, active tenant access and management rights."""
import tempfile
import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TransactionTestCase, override_settings

from workspace.models import CompanyLicense, Organization, OrganizationMember, WorkspaceFile


class SharedFileDeleteTests(TransactionTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        media = override_settings(MEDIA_ROOT=self.temp.name)
        media.enable()
        self.addCleanup(media.disable)
        self.owner = self.user('owner')
        self.member = self.user('member')
        self.admin = self.user('admin')
        self.other = self.user('other')
        self.org = Organization.objects.create(name='Example', slug='shared-files', created_by=self.owner)
        for user, role in [(self.owner, 'owner'), (self.member, 'member'), (self.admin, 'admin'), (self.other, 'member')]:
            OrganizationMember.objects.create(organization=self.org, user=user, role=role)
        self.client = Client(enforce_csrf_checks=True)
        self.login(self.member)

    def user(self, name):
        return get_user_model().objects.create_user(email=f'{name}@test.invalid', password='StrongPassword123!', full_name=name)

    def login(self, user, org=None):
        self.client.force_login(user)
        session = self.client.session
        session['active_organization_id'] = str((org or self.org).pk)
        session.save()
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def file(self, user=None):
        return WorkspaceFile.objects.create(
            organization=self.org, uploaded_by=user or self.member,
            original_name='notes.txt', content_type='text/plain', size=5,
            file=SimpleUploadedFile('notes.txt', b'Notes', content_type='text/plain'),
        )

    def delete(self, file_id):
        return self.client.delete(f'/api/files/{file_id}/', HTTP_X_CSRFTOKEN=self.csrf)

    def test_uploader_deletes_record_and_stored_bytes(self):
        row = self.file()
        storage, name = row.file.storage, row.file.name
        self.assertTrue(storage.exists(name))
        self.assertEqual(self.delete(row.pk).status_code, 204)
        self.assertFalse(WorkspaceFile.objects.filter(pk=row.pk).exists())
        self.assertFalse(storage.exists(name))
        self.assertEqual(self.client.get('/api/files/').json()['results'], [])
        self.assertEqual(self.client.get(f'/api/files/{row.pk}/download/').status_code, 404)

    def test_regular_member_cannot_delete_another_members_file(self):
        row = self.file(self.other)
        self.assertEqual(self.delete(row.pk).status_code, 403)
        self.assertTrue(WorkspaceFile.objects.filter(pk=row.pk).exists())
        self.assertTrue(row.file.storage.exists(row.file.name))

    def test_owners_and_admins_can_delete_other_members_files(self):
        for manager in (self.owner, self.admin):
            with self.subTest(role=manager.full_name):
                row = self.file(self.other)
                self.login(manager)
                self.assertEqual(self.delete(row.pk).status_code, 204)
                self.assertFalse(WorkspaceFile.objects.filter(pk=row.pk).exists())

    def test_list_and_upload_report_delete_permission(self):
        own, other = self.file(), self.file(self.other)
        permissions = {row['id']: row['can_delete'] for row in self.client.get('/api/files/').json()['results']}
        self.assertTrue(permissions[str(own.pk)])
        self.assertFalse(permissions[str(other.pk)])
        upload = self.client.post('/api/files/', {'file': SimpleUploadedFile('new.txt', b'New')}, HTTP_X_CSRFTOKEN=self.csrf)
        self.assertEqual(upload.status_code, 201)
        self.assertTrue(upload.json()['can_delete'])
        self.login(self.admin)
        self.assertTrue(all(row['can_delete'] for row in self.client.get('/api/files/').json()['results']))

    def test_even_uploader_cannot_delete_from_another_active_workspace(self):
        row = self.file()
        other_org = Organization.objects.create(name='Other', slug='other-shared-files', created_by=self.member)
        OrganizationMember.objects.create(organization=other_org, user=self.member, role='admin')
        self.login(self.member, other_org)
        self.assertEqual(self.delete(row.pk).status_code, 404)
        self.assertTrue(WorkspaceFile.objects.filter(pk=row.pk).exists())

    def test_missing_csrf_and_unauthenticated_requests_do_not_delete(self):
        row = self.file()
        self.assertEqual(self.client.delete(f'/api/files/{row.pk}/').status_code, 403)
        self.client.logout()
        self.assertEqual(self.delete(row.pk).status_code, 403)
        self.assertTrue(WorkspaceFile.objects.filter(pk=row.pk).exists())

    def test_removed_members_and_disabled_file_module_cannot_delete(self):
        row = self.file()
        OrganizationMember.objects.filter(organization=self.org, user=self.member).delete()
        self.assertEqual(self.delete(row.pk).status_code, 403)
        self.login(self.owner)
        CompanyLicense.objects.create(organization=self.org, enforce_modules=True, modules=['chats'])
        self.assertEqual(self.delete(row.pk).status_code, 403)
        self.assertTrue(WorkspaceFile.objects.filter(pk=row.pk).exists())

    def test_nonexistent_files_and_read_requests_do_not_delete(self):
        row = self.file()
        self.assertEqual(self.delete(uuid.uuid4()).status_code, 404)
        self.assertEqual(self.client.get(f'/api/files/{row.pk}/').status_code, 405)
        self.assertTrue(WorkspaceFile.objects.filter(pk=row.pk).exists())

    def test_storage_is_unchanged_when_database_deletion_fails(self):
        row = self.file()
        with patch.object(WorkspaceFile, 'delete', side_effect=RuntimeError('Database failure')):
            with self.assertRaises(RuntimeError):
                self.delete(row.pk)
        self.assertTrue(WorkspaceFile.objects.filter(pk=row.pk).exists())
        self.assertTrue(row.file.storage.exists(row.file.name))
