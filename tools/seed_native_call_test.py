"""CI-only fake users/room for the native WebRTC browser test."""
import os
import sys
from pathlib import Path
if os.environ.get('DJANGO_SETTINGS_MODULE') != 'config.test_settings':
    raise RuntimeError('This fixture must only run with config.test_settings')
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
import django
django.setup()
from datetime import timedelta
from django.utils import timezone
from workspace.models import User,Organization,OrganizationMember,Meeting,MeetingAttendee
users=[]
for email,name in [('call-owner@example.test','Call Owner'),('call-member@example.test','Call Member')]:
    user,_=User.objects.get_or_create(email=email,defaults={'full_name':name})
    user.set_password('BrowserTestOnly123!');user.email_verified_at=timezone.now();user.save();users.append(user)
org,_=Organization.objects.get_or_create(slug='native-call-ci',defaults={'name':'Native Call CI','created_by':users[0]})
for i,user in enumerate(users):OrganizationMember.objects.get_or_create(organization=org,user=user,defaults={'role':'admin' if i==0 else 'member'})
meeting,_=Meeting.objects.update_or_create(pk='11111111-1111-4111-8111-111111111111',defaults={'organization':org,'organizer':users[0],'title':'Native browser test','starts_at':timezone.now(),'ends_at':timezone.now()+timedelta(hours=1),'call_ended_at':None,'cancelled':False})
for user in users:MeetingAttendee.objects.get_or_create(meeting=meeting,user=user)
print('Native call fixture ready.')

# Additional CI-only calendar fixtures exercise overlap, overnight and invited rows.
base=timezone.now().replace(hour=10,minute=0,second=0,microsecond=0)
for number,title,begin,end,host in [
    (2,'Product planning',base,base+timedelta(hours=1),users[0]),
    (3,'Design review',base+timedelta(minutes=30),base+timedelta(minutes=90),users[0]),
    (4,'Project check-in',base+timedelta(days=1,hours=4),base+timedelta(days=1,hours=5),users[1]),
    (5,'Global handover',base.replace(hour=0)-timedelta(minutes=30),base.replace(hour=0)+timedelta(minutes=30),users[0]),
]:
    key=f'{number}'*8+'-'+f'{number}'*4+'-4'+f'{number}'*3+'-8'+f'{number}'*3+'-'+f'{number}'*12
    item,_=Meeting.objects.update_or_create(pk=key,defaults={'organization':org,'organizer':host,'title':title,'starts_at':begin,'ends_at':end,'cancelled':False,'call_ended_at':None})
    for user in users:MeetingAttendee.objects.get_or_create(meeting=item,user=user,defaults={'response':'accepted' if user==host else 'pending'})
