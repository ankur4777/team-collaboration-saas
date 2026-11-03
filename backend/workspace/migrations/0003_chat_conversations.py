# Chat conversation schema: direct messages and private group chats.
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
import workspace.models


class Migration(migrations.Migration):
    dependencies = [
        ('workspace', '0002_alter_user_managers_alter_user_groups'),
    ]

    operations = [
        migrations.CreateModel(
            name='ChatConversation',
            fields=[
                ('id', models.UUIDField(default=workspace.models.make_id, editable=False, primary_key=True, serialize=False)),
                ('kind', models.CharField(choices=[('direct', 'Direct'), ('group', 'Group')], max_length=8)),
                ('title', models.CharField(blank=True, max_length=100)),
                ('direct_key', models.CharField(blank=True, max_length=64, null=True, unique=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('created_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='chats_created', to=settings.AUTH_USER_MODEL)),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='chat_conversations', to='workspace.organization')),
            ],
            options={'ordering': ['-updated_at', '-created_at']},
        ),
        migrations.CreateModel(
            name='ChatParticipant',
            fields=[
                ('id', models.UUIDField(default=workspace.models.make_id, editable=False, primary_key=True, serialize=False)),
                ('joined_at', models.DateTimeField(auto_now_add=True)),
                ('conversation', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='participants', to='workspace.chatconversation')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='chat_memberships', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='ChatMessage',
            fields=[
                ('id', models.UUIDField(default=workspace.models.make_id, editable=False, primary_key=True, serialize=False)),
                ('body', models.TextField(max_length=4000)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('conversation', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='messages', to='workspace.chatconversation')),
                ('sender', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='private_messages_sent', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['created_at', 'id']},
        ),
        migrations.AddConstraint(
            model_name='chatparticipant',
            constraint=models.UniqueConstraint(fields=('conversation', 'user'), name='uq_chat_participant'),
        ),
    ]
