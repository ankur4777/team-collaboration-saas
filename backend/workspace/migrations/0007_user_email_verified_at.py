"""Record verified addresses without locking out existing workspace owners.

Accounts created before this release are marked verified to preserve existing
login sessions and organization access. New users start unverified.
"""
from django.db import migrations, models
from django.utils import timezone


def grandfather_existing_users(apps, schema_editor):
    User = apps.get_model('workspace', 'User')
    User.objects.using(schema_editor.connection.alias).filter(
        email_verified_at__isnull=True
    ).update(email_verified_at=timezone.now())


class Migration(migrations.Migration):
    dependencies = [('workspace', '0006_channel_read_cursors')]

    operations = [
        migrations.AddField(
            model_name='user',
            name='email_verified_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(grandfather_existing_users, migrations.RunPython.noop),
    ]
