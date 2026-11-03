from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('workspace', '0004_chatmessage_edit_delete'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatparticipant',
            name='last_read_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
