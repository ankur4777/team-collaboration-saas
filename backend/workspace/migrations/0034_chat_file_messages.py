from django.db import migrations, models
import django.db.models.deletion


def attach_existing_chat_files(apps, schema_editor):
    Attachment = apps.get_model('workspace', 'PrivateAttachment')
    Message = apps.get_model('workspace', 'ChatMessage')
    Conversation = apps.get_model('workspace', 'ChatConversation')
    database = schema_editor.connection.alias
    for attachment in Attachment.objects.using(database).filter(chat__isnull=False, chat_message__isnull=True).iterator():
        message = Message.objects.using(database).create(conversation_id=attachment.chat_id,
            sender_id=attachment.uploaded_by_id, body=attachment.original_name)
        Message.objects.using(database).filter(pk=message.pk).update(created_at=attachment.created_at)
        Attachment.objects.using(database).filter(pk=attachment.pk).update(chat_message_id=message.pk)
        Conversation.objects.using(database).filter(pk=attachment.chat_id, updated_at__lt=attachment.created_at).update(updated_at=attachment.created_at)


class Migration(migrations.Migration):
    dependencies = [('workspace', '0033_user_profile_avatar')]
    operations = [
        migrations.AddField(model_name='privateattachment', name='chat_message',
            field=models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE,
                related_name='file_attachment', to='workspace.chatmessage')),
        migrations.RunPython(attach_existing_chat_files, migrations.RunPython.noop),
    ]
