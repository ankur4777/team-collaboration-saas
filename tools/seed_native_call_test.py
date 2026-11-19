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
for i,user in enumerate(users):OrganizationMember.objects.get_or_create(organization=org,user=user,defaults={'role':'owner' if i==0 else 'member'})
meeting,_=Meeting.objects.update_or_create(pk='11111111-1111-4111-8111-111111111111',defaults={'organization':org,'organizer':users[0],'title':'Native browser test','starts_at':timezone.now(),'ends_at':timezone.now()+timedelta(hours=1),'call_ended_at':None,'cancelled':False})
for user in users:MeetingAttendee.objects.get_or_create(meeting=meeting,user=user)
print('Native call fixture ready.')
