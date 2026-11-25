from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('workspace', '0021_conversation_archive')]
    operations = [
        migrations.AddField(model_name='organizationmember', name='last_seen_at', field=models.DateTimeField(blank=True, null=True)),
    ]
