from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('workspace', '0022_workspace_presence')]
    operations = [
        migrations.AddField(model_name=model, name=field, field=models.BooleanField(default=False))
        for model in ('chatparticipant', 'channelreadcursor')
        for field in ('is_muted', 'is_pinned')
    ]
