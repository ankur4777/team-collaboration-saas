from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('workspace', '0026_company_module_entitlements')]
    operations = [
        migrations.CreateModel(
            name='SubscriptionRenewal',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('request_id', models.UUIDField()),
                ('days', models.PositiveIntegerField()),
                ('previous_start', models.DateField(blank=True, null=True)),
                ('previous_end', models.DateField(blank=True, null=True)),
                ('previous_status', models.CharField(max_length=16)),
                ('new_start', models.DateField()),
                ('new_end', models.DateField()),
                ('new_status', models.CharField(max_length=16)),
                ('reactivate', models.BooleanField(default=False)),
                ('note', models.CharField(blank=True, max_length=500)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('actor', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='subscription_renewals', to='workspace.user')),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='subscription_renewals', to='workspace.organization')),
            ],
            options={'ordering':['-created_at','-pk'],'constraints':[models.UniqueConstraint(fields=('organization','request_id'),name='uq_company_renewal_request')]},
        ),
    ]
