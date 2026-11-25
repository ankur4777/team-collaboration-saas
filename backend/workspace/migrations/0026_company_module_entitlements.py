from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('workspace', '0025_platform_company_management')]
    operations = [migrations.AddField(model_name='companylicense', name='enforce_modules', field=models.BooleanField(default=False))]
