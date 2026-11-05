"""Account-wide login-device metadata (not a replacement for Django sessions)."""
import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models
import workspace.models


class Migration(migrations.Migration):
    dependencies = [
        ('workspace', '0008_notification_preferences'),
    ]

    operations = [
        migrations.CreateModel(
            name='AccountSession',
            fields=[
                ('id', models.UUIDField(default=workspace.models.make_id, editable=False, primary_key=True, serialize=False)),
                ('session_key', models.CharField(max_length=40, unique=True)),
                ('user_agent', models.CharField(blank=True, max_length=255)),
                ('ip_address', models.GenericIPAddressField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('last_seen_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('revoked_at', models.DateTimeField(blank=True, null=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='account_sessions', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['-last_seen_at', '-created_at']},
        ),
    ]
