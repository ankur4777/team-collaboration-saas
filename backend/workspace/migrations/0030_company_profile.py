from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('workspace', '0029_support_tickets')]
    operations = [
        migrations.AddField(model_name='organizationmember',name='contact_phone',field=models.CharField(blank=True,max_length=16)),
        migrations.AddField(model_name='companylicense',name='country',field=models.CharField(blank=True,max_length=80)),
        migrations.AddField(model_name='companylicense',name='country_code',field=models.CharField(blank=True,max_length=5)),
        migrations.AddField(model_name='companylicense',name='phone',field=models.CharField(blank=True,max_length=15)),
        migrations.AddField(model_name='companylicense',name='website',field=models.URLField(blank=True,max_length=250)),
        migrations.AddField(model_name='companylicense',name='tax_number',field=models.CharField(blank=True,max_length=60)),
        migrations.AddField(model_name='companylicense',name='address',field=models.CharField(blank=True,max_length=500)),
    ]
