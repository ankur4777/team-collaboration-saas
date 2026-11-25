from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('workspace', '0018_message_replies')]
    operations = [
        migrations.AddField(model_name='message', name='is_forwarded', field=models.BooleanField(default=False)),
        migrations.AddField(model_name='chatmessage', name='is_forwarded', field=models.BooleanField(default=False)),
    ]
