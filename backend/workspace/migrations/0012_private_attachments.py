import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
import workspace.models


class Migration(migrations.Migration):
    dependencies = [('workspace', '0011_mention_notifications')]

    operations = [
        migrations.CreateModel(
            name='PrivateAttachment',
            fields=[
                ('id', models.UUIDField(default=workspace.models.make_id, editable=False, primary_key=True, serialize=False)),
                ('file', models.FileField(upload_to=workspace.models.private_attachment_path)),
                ('original_name', models.CharField(max_length=120)),
                ('content_type', models.CharField(max_length=100)),
                ('size', models.PositiveIntegerField()),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='private_attachments', to='workspace.organization')),
                ('uploaded_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='uploaded_attachments', to=settings.AUTH_USER_MODEL)),
                ('chat', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='attachments', to='workspace.chatconversation')),
                ('channel', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='attachments', to='workspace.channel')),
            ],
            options={
                'indexes': [
                    models.Index(fields=['organization', 'chat', 'created_at'], name='idx_file_org_chat_date'),
                    models.Index(fields=['organization', 'channel', 'created_at'], name='idx_file_org_chan_date'),
                ],
                'constraints': [
                    models.CheckConstraint(
                        condition=(models.Q(chat__isnull=False, channel__isnull=True) | models.Q(chat__isnull=True, channel__isnull=False)),
                        name='ck_private_file_single_source',
                    ),
                ],
            },
        ),
    ]
