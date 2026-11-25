from django.db import migrations, models
import django.db.models.deletion
import django.utils.timezone


class Migration(migrations.Migration):
    dependencies = [('workspace', '0023_conversation_preferences')]
    operations = [
        migrations.AddField(model_name='channel', name='is_private', field=models.BooleanField(default=False)),
        migrations.CreateModel(
            name='PrivateChannelMember',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('joined_at', models.DateTimeField(default=django.utils.timezone.now)),
                ('channel', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='private_members', to='workspace.channel')),
                ('team_member', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='private_channel_memberships', to='workspace.teammember')),
            ],
            options={'constraints':[models.UniqueConstraint(fields=('channel','team_member'), name='uq_private_channel_member')]},
        ),
    ]
