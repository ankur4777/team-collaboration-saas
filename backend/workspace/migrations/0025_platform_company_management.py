from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('workspace', '0024_private_channels')]
    operations = [
        migrations.CreateModel(
            name='CompanyLicense',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('contact_email', models.EmailField(blank=True, max_length=254)),
                ('plan', models.CharField(blank=True, max_length=80)),
                ('status', models.CharField(choices=[('unassigned','Unassigned'),('trial','Trial'),('active','Active'),('suspended','Suspended'),('cancelled','Cancelled')], default='unassigned', max_length=16)),
                ('seat_limit', models.PositiveIntegerField(blank=True, null=True)),
                ('starts_on', models.DateField(blank=True, null=True)),
                ('ends_on', models.DateField(blank=True, null=True)),
                ('modules', models.JSONField(blank=True, default=list)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('organization', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='license', to='workspace.organization')),
            ],
        ),
        migrations.CreateModel(
            name='PlatformAuditEntry',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('action', models.CharField(max_length=40)),
                ('changes', models.JSONField(default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('actor', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='platform_audit_entries', to='workspace.user')),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='platform_audit_entries', to='workspace.organization')),
            ],
            options={'ordering':['-created_at','-pk']},
        ),
    ]
