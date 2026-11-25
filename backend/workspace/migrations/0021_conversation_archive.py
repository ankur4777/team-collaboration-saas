from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('workspace', '0020_message_pins')]
    operations = [
        migrations.AddField(model_name='team', name='archived_at', field=models.DateTimeField(blank=True, null=True)),
        migrations.AddField(model_name='channel', name='archived_at', field=models.DateTimeField(blank=True, null=True)),
        migrations.AddField(model_name='chatparticipant', name='archived_at', field=models.DateTimeField(blank=True, null=True)),
    ]
