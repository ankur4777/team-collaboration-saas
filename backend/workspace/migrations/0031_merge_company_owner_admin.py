from django.db import migrations, models


def merge_owner_into_admin(apps, schema_editor):
    for name in ('OrganizationMember', 'Invitation'):
        model = apps.get_model('workspace', name)
        model.objects.using(schema_editor.connection.alias).filter(role='owner').update(role='admin')


class Migration(migrations.Migration):
    dependencies = [('workspace', '0030_company_profile')]
    operations = [
        migrations.RunPython(merge_owner_into_admin),
        migrations.AlterField(model_name='organizationmember', name='role', field=models.CharField(choices=[('admin','Admin'),('member','Member')],default='member',max_length=16)),
        migrations.AlterField(model_name='invitation', name='role', field=models.CharField(choices=[('admin','Admin'),('member','Member')],default='member',max_length=16)),
    ]
