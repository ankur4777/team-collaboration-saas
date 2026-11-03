# Generated to bring the original hand-written initial migration into sync
# with the Django 5.2 User model and its PermissionsMixin fields.
# This migration is safe to apply to an existing development database.
from django.db import migrations, models
import workspace.models


class Migration(migrations.Migration):
    dependencies = [
        ('workspace', '0001_initial'),
    ]

    operations = [
        migrations.AlterModelManagers(
            name='user',
            managers=[('objects', workspace.models.UserManager())],
        ),
        migrations.AlterField(
            model_name='user',
            name='groups',
            field=models.ManyToManyField(
                blank=True,
                help_text=(
                    'The groups this user belongs to. A user will get all permissions '
                    'granted to each of their groups.'
                ),
                related_name='user_set',
                related_query_name='user',
                to='auth.group',
                verbose_name='groups',
            ),
        ),
    ]
