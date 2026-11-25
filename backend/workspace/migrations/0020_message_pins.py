from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('workspace', '0019_message_forwarding')]
    operations = [
        migrations.AddField(model_name='message', name='pinned_at', field=models.DateTimeField(blank=True, null=True)),
        migrations.AddField(model_name='chatmessage', name='pinned_at', field=models.DateTimeField(blank=True, null=True)),
    ]
