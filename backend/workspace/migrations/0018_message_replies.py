from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('workspace', '0017_workspace_files')]

    operations = [
        migrations.AddField(
            model_name='message', name='reply_to',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='workspace.message'),
        ),
        migrations.AddField(
            model_name='chatmessage', name='reply_to',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='workspace.chatmessage'),
        ),
    ]
