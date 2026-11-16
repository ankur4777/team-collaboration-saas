from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import workspace.models


class Migration(migrations.Migration):
    dependencies = [
        ('workspace', '0009_account_sessions'),
    ]

    operations = [
        migrations.CreateModel(
            name='ChatReaction',
            fields=[
                ('id', models.UUIDField(default=workspace.models.make_id, editable=False, primary_key=True, serialize=False)),
                ('emoji', models.CharField(max_length=8)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('message', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='reactions', to='workspace.chatmessage')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='chat_reactions', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.AddConstraint(
            model_name='chatreaction',
            constraint=models.UniqueConstraint(fields=('message', 'user', 'emoji'), name='uq_chat_reaction_message_user_emoji'),
        ),
    ]
