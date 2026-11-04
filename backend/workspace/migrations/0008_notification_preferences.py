"""Tenant-scoped preferences for in-app notification categories."""
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
import workspace.models


class Migration(migrations.Migration):
    dependencies = [
        ('workspace', '0007_user_email_verified_at'),
    ]

    operations = [
        migrations.CreateModel(
            name='NotificationPreference',
            fields=[
                ('id', models.UUIDField(default=workspace.models.make_id, editable=False, primary_key=True, serialize=False)),
                ('direct_chats', models.BooleanField(default=True)),
                ('group_chats', models.BooleanField(default=True)),
                ('team_channels', models.BooleanField(default=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='notification_preferences', to='workspace.organization')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='notification_preferences', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.AddConstraint(
            model_name='notificationpreference',
            constraint=models.UniqueConstraint(
                fields=('organization', 'user'), name='uq_notification_preference_user_org',
            ),
        ),
    ]
