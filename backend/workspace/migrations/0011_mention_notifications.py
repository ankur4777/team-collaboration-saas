from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import workspace.models


class Migration(migrations.Migration):
    dependencies = [
        ('workspace', '0010_chat_reactions'),
    ]

    operations = [
        migrations.CreateModel(
            name='MentionNotification',
            fields=[
                ('id', models.UUIDField(default=workspace.models.make_id, editable=False, primary_key=True, serialize=False)),
                ('read_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='mention_notifications', to='workspace.organization')),
                ('recipient', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='mention_notifications', to=settings.AUTH_USER_MODEL)),
                ('chat_message', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='mention_notifications', to='workspace.chatmessage')),
                ('channel_message', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='mention_notifications', to='workspace.message')),
            ],
            options={
                'indexes': [
                    models.Index(fields=['organization', 'recipient', 'created_at'], name='idx_mention_org_user_date'),
                ],
                'constraints': [
                    models.CheckConstraint(
                        condition=(
                            models.Q(chat_message__isnull=False, channel_message__isnull=True)
                            | models.Q(chat_message__isnull=True, channel_message__isnull=False)
                        ),
                        name='ck_mention_single_message',
                    ),
                    models.UniqueConstraint(fields=('recipient', 'chat_message'), name='uq_mention_chat_recipient'),
                    models.UniqueConstraint(fields=('recipient', 'channel_message'), name='uq_mention_channel_recipient'),
                ],
            },
        ),
    ]
