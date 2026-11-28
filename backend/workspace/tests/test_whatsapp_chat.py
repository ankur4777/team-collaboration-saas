import tempfile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TransactionTestCase, override_settings
from workspace.models import User, Organization, OrganizationMember, ChatConversation, ChatParticipant, ChatMessage, PrivateAttachment


class WhatsAppChatTests(TransactionTestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        scoped=override_settings(MEDIA_ROOT=temporary.name)
        scoped.enable()
        self.addCleanup(scoped.disable)
        self.me=User.objects.create_user(email='sender@chat.test',full_name='Sender',password='password')
        self.peer=User.objects.create_user(email='peer@chat.test',full_name='Peer',password='password')
        self.org=Organization.objects.create(name='Company',slug='whatsapp-tests',created_by=self.me)
        for user in (self.me,self.peer):
            OrganizationMember.objects.create(organization=self.org,user=user)
        self.chat=ChatConversation.objects.create(organization=self.org,kind='direct',created_by=self.me)
        self.destination=ChatConversation.objects.create(organization=self.org,kind='group',title='Project',created_by=self.me)
        for chat in (self.chat,self.destination):
            for user in (self.me,self.peer):
                ChatParticipant.objects.create(conversation=chat,user=user)
        self.client=Client(enforce_csrf_checks=True)
        self.client.force_login(self.me)
        session=self.client.session
        session['active_organization_id']=str(self.org.pk)
        session.save()
        self.csrf=self.client.get('/api/auth/csrf/').json()['csrf_token']

    def upload(self,name,contents,caption=''):
        return self.client.post(f'/api/chats/{self.chat.pk}/attachments/',{'file':SimpleUploadedFile(name,contents),'caption':caption},HTTP_X_CSRFTOKEN=self.csrf)

    def test_voice_formats_and_private_audio_playback(self):
        for name,content,mime in [('note.webm',b'\x1aE\xdf\xa3audio','audio/webm'),('note.ogg',b'OggSaudio','audio/ogg'),('note.m4a',b'\0\0\0\x18ftypM4A ','audio/mp4'),('note.mp3',b'ID3audio','audio/mpeg')]:
            with self.subTest(name=name):
                result=self.upload(name,content)
                self.assertEqual(result.status_code,201,result.content)
                self.assertEqual(result.json()['message']['attachment']['content_type'],mime)
                received=self.client.get(f"/api/attachments/{result.json()['id']}/download/?preview=1")
                self.assertEqual(received.status_code,200)
                self.assertEqual(received['Content-Type'],mime)
                received.close()
        self.assertEqual(self.upload('bad.webm',b'html').status_code,400)

    def test_search_includes_filenames_and_is_conversation_scoped(self):
        uploaded=self.upload('release-notes.txt',b'notes',caption='Project handover').json()
        ChatMessage.objects.create(conversation=self.destination,sender=self.me,body='Project secret')
        result=self.client.get(f'/api/chats/{self.chat.pk}/messages/',{'page':'1','q':'release-notes'}).json()
        self.assertEqual([row['id'] for row in result['items']],[uploaded['message']['id']])
        result=self.client.get(f'/api/chats/{self.chat.pk}/messages/',{'page':'1','q':'secret'}).json()
        self.assertEqual(result['items'],[])
        self.assertEqual(self.client.get(f'/api/chats/{self.chat.pk}/messages/',{'q':'x'*101}).status_code,400)

    def test_media_pages_do_not_repeat_or_skip_files(self):
        PrivateAttachment.objects.bulk_create([PrivateAttachment(organization=self.org,chat=self.chat,uploaded_by=self.me,file='dummy.txt',original_name=f'File {i}.txt',content_type='text/plain',size=1) for i in range(51)])
        first=self.client.get(f'/api/chats/{self.chat.pk}/attachments/',{'page':'1'}).json()
        self.assertEqual(len(first['items']),50)
        second=self.client.get(f'/api/chats/{self.chat.pk}/attachments/',{'page':'1',**first['next_cursor']}).json()
        self.assertEqual(len(second['items']),1)
        self.assertIsNone(second['next_cursor'])
        self.assertFalse({row['id'] for row in first['items']} & {row['id'] for row in second['items']})

    def test_forwarding_copies_file_bytes_caption_and_ownership_to_destination(self):
        source=self.upload('guide.txt',b'private bytes',caption='Read this guide').json()
        response=self.client.post('/api/messages/forward/',{'source_kind':'chat','source_id':str(self.chat.pk),'message_id':source['message']['id'],'destination_kind':'chat','destination_id':str(self.destination.pk)},content_type='application/json',HTTP_X_CSRFTOKEN=self.csrf)
        self.assertEqual(response.status_code,201,response.content)
        message=response.json()['message']
        self.assertEqual(message['body'],'Read this guide')
        self.assertTrue(message['is_forwarded'])
        self.assertNotEqual(message['attachment']['id'],source['id'])
        copied=PrivateAttachment.objects.get(pk=message['attachment']['id'])
        self.assertEqual(copied.chat_id,self.destination.pk)
        with copied.file.open('rb') as stored:
            self.assertEqual(stored.read(),b'private bytes')

    def test_group_search_and_media_hide_history_before_join(self):
        self.chat.kind='group'
        self.chat.save(update_fields=['kind'])
        self.upload('old.txt',b'old',caption='Earlier history')
        from django.utils import timezone
        ChatParticipant.objects.filter(conversation=self.chat,user=self.me).update(joined_at=timezone.now())
        self.assertEqual(self.client.get(f'/api/chats/{self.chat.pk}/messages/',{'page':'1','q':'Earlier'}).json()['items'],[])
        self.assertEqual(self.client.get(f'/api/chats/{self.chat.pk}/attachments/',{'page':'1'}).json()['items'],[])
