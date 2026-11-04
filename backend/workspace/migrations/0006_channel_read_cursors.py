# Team join dates anchor unread counts to authorized team membership.
# Existing memberships receive the deployment-time timestamp because their
# historical join time was not recorded in earlier schema versions.
import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models
import workspace.models


class Migration(migrations.Migration):
    dependencies = [
        ('workspace', '0005_chatparticipant_read_cursor'),
    ]

    operations = [
        migrations.AddField(
            model_name='teammember',
            name='joined_at',
            field=models.DateTimeField(default=django.utils.timezone.now),
        ),
        migrations.CreateModel(
            name='ChannelReadCursor',
            fields=[
                ('id', models.UUIDField(default=workspace.models.make_id, editable=False, primary_key=True, serialize=False)),
                ('last_read_at', models.DateTimeField(blank=True, null=True)),
                ('channel', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='read_cursors', to='workspace.channel')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='channel_read_cursors', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.AddConstraint(
            model_name='channelreadcursor',
            constraint=models.UniqueConstraint(fields=('channel', 'user'), name='uq_channel_read_user'),
        ),
    ]
