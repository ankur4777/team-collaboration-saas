from django.db import migrations, models
import django.db.models.deletion
import workspace.models


class Migration(migrations.Migration):
    dependencies = [('workspace', '0027_subscription_renewal')]
    operations = [
        migrations.CreateModel(
            name='BillingInvoice',
            fields=[
                ('id', models.UUIDField(default=workspace.models.make_id, editable=False, primary_key=True, serialize=False)),
                ('request_id', models.UUIDField()),
                ('company_name', models.CharField(max_length=140)),
                ('contact_email', models.EmailField(blank=True, max_length=254)),
                ('issuer_name', models.CharField(max_length=140)),
                ('description', models.CharField(max_length=300)),
                ('currency', models.CharField(max_length=3)),
                ('amount', models.DecimalField(decimal_places=2, max_digits=12)),
                ('issued_on', models.DateField()),
                ('due_on', models.DateField(blank=True, null=True)),
                ('status', models.CharField(choices=[('unpaid','Unpaid'),('paid','Paid'),('void','Void')], default='unpaid', max_length=10)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('actor', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='issued_invoices', to='workspace.user')),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='billing_invoices', to='workspace.organization')),
            ],
            options={'ordering':['-created_at','-pk'],'constraints':[models.UniqueConstraint(fields=('organization','request_id'), name='uq_invoice_request')]},
        ),
        migrations.CreateModel(
            name='BillingPayment',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('paid_on', models.DateField()),
                ('method', models.CharField(max_length=20)),
                ('reference', models.CharField(max_length=120)),
                ('note', models.CharField(blank=True, max_length=300)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('actor', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='recorded_payments', to='workspace.user')),
                ('invoice', models.OneToOneField(on_delete=django.db.models.deletion.PROTECT, related_name='payment', to='workspace.billinginvoice')),
            ],
        ),
    ]
