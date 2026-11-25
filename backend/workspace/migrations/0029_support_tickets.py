from django.db import migrations, models
import django.db.models.deletion
import workspace.models


class Migration(migrations.Migration):
    dependencies = [('workspace', '0028_company_billing')]
    operations = [
        migrations.CreateModel(
            name='SupportTicket',
            fields=[
                ('id',models.UUIDField(default=workspace.models.make_id,editable=False,primary_key=True,serialize=False)),
                ('subject',models.CharField(max_length=160)),
                ('priority',models.CharField(choices=[('normal','Normal'),('high','High')],default='normal',max_length=10)),
                ('status',models.CharField(choices=[('open','Open'),('in_progress','In progress'),('resolved','Resolved'),('closed','Closed')],default='open',max_length=20)),
                ('created_at',models.DateTimeField(auto_now_add=True)),
                ('updated_at',models.DateTimeField(auto_now=True)),
                ('organization',models.ForeignKey(on_delete=django.db.models.deletion.PROTECT,related_name='support_tickets',to='workspace.organization')),
                ('requester',models.ForeignKey(on_delete=django.db.models.deletion.PROTECT,related_name='support_requests',to='workspace.user')),
            ], options={'ordering':['-updated_at','-pk']},
        ),
        migrations.CreateModel(
            name='SupportReply',
            fields=[
                ('id',models.BigAutoField(auto_created=True,primary_key=True,serialize=False,verbose_name='ID')),
                ('from_provider',models.BooleanField(default=False)),
                ('body',models.TextField()),
                ('created_at',models.DateTimeField(auto_now_add=True)),
                ('author',models.ForeignKey(on_delete=django.db.models.deletion.PROTECT,related_name='support_replies',to='workspace.user')),
                ('ticket',models.ForeignKey(on_delete=django.db.models.deletion.CASCADE,related_name='replies',to='workspace.supportticket')),
            ],options={'ordering':['created_at','pk']},
        ),
    ]
