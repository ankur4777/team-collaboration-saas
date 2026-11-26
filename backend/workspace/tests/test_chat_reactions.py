"""Regression coverage for emoji reactions on direct and group chat messages."""
import json

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings
from workspace.models import ChatReaction, Organization, OrganizationMember


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class ChatReactionTests(TestCase):
    def setUp(self):
        self.client=Client(enforce_csrf_checks=True)
        self.csrf=self.client.get('/api/auth/csrf/').json()['csrf_token']

    def post(self,url,data=None):
        res=self.client.post(
            url,data=json.dumps(data or {}),content_type='application/json',
            HTTP_X_CSRFTOKEN=self.csrf,
        )
        if res.status_code<300:
            self.csrf=self.client.get('/api/auth/csrf/').json()['csrf_token']
        return res

    def register(self):
        res=self.post('/api/auth/register/', {
            'email':'owner@first.test','password':'GoodPassword123!',
            'full_name':'Owner','organization_name':'First Company',
        })
        self.assertEqual(res.status_code,201,res.content)
        return Organization.objects.get(pk=res.json()['active_organization_id'])

    def employee(self,org,email):
        user=get_user_model().objects.create_user(
            email=email,password='GoodPassword123!',full_name=email.split('@')[0],
        )
        OrganizationMember.objects.create(organization=org,user=user)
        return user

    def login(self,email):
        self.assertEqual(self.post('/api/auth/logout/').status_code,200)
        res=self.post('/api/auth/login/',{'email':email,'password':'GoodPassword123!'})
        self.assertEqual(res.status_code,200,res.content)

    def test_toggle_reaction_and_history(self):
        org=self.register()
        friend=self.employee(org,'friend@first.test')
        chat=self.post('/api/chats/',{'kind':'direct','email':friend.email})
        self.assertEqual(chat.status_code,201,chat.content)
        cid=chat.json()['id']
        message=self.post(f'/api/chats/{cid}/messages/',{'body':'Test emoji'}).json()
        endpoint=f"/api/chats/{cid}/messages/{message['id']}/reactions/"
        self.assertEqual(self.post(endpoint,{'emoji':'😈'}).status_code,400)
        first=self.post(endpoint,{'emoji':'👍'})
        self.assertEqual(first.status_code,200,first.content)
        self.assertEqual(first.json()['reactions'][0]['count'],1)
        self.assertEqual(ChatReaction.objects.count(),1)
        history=self.client.get(f'/api/chats/{cid}/messages/').json()
        self.assertEqual(history[0]['reactions'][0]['emoji'],'👍')
        self.login(friend.email)
        second=self.post(endpoint,{'emoji':'👍'})
        self.assertEqual(second.status_code,200,second.content)
        self.assertEqual(second.json()['reactions'][0]['count'],2)
        self.assertEqual(ChatReaction.objects.count(),2)
        undone=self.post(endpoint,{'emoji':'👍'})
        self.assertEqual(undone.status_code,200,undone.content)
        self.assertEqual(undone.json()['reactions'][0]['count'],1)

    def test_other_employee_cannot_react(self):
        org=self.register()
        friend=self.employee(org,'friend@first.test')
        outside=self.employee(org,'outsider@first.test')
        chat=self.post('/api/chats/',{'kind':'direct','email':friend.email}).json()
        message=self.post(f"/api/chats/{chat['id']}/messages/",{'body':'private'}).json()
        endpoint=f"/api/chats/{chat['id']}/messages/{message['id']}/reactions/"
        self.login(outside.email)
        self.assertEqual(self.post(endpoint,{'emoji':'❤️'}).status_code,404)
        self.assertEqual(ChatReaction.objects.count(),0)

    def test_group_newcomer_cannot_react_to_prejoin_message(self):
        org=self.register()
        a=self.employee(org,'a@first.test')
        b=self.employee(org,'b@first.test')
        late=self.employee(org,'late@first.test')
        group=self.post('/api/chats/',{
            'kind':'group','title':'Team','emails':[a.email,b.email],
        })
        self.assertEqual(group.status_code,201,group.content)
        cid=group.json()['id']
        old=self.post(f'/api/chats/{cid}/messages/',{'body':'before'}).json()
        self.assertEqual(self.post(f'/api/chats/{cid}/participants/',{'email':late.email}).status_code,201)
        self.login(late.email)
        endpoint=f"/api/chats/{cid}/messages/{old['id']}/reactions/"
        self.assertEqual(self.post(endpoint,{'emoji':'👍'}).status_code,403)
        self.assertEqual(ChatReaction.objects.count(),0)

    def test_active_workspace_boundary_blocks_reactions(self):
        self.register()
        org=Organization.objects.get(name='First Company')
        friend=self.employee(org,'friend@first.test')
        owner=get_user_model().objects.get(email='owner@first.test')
        chat=self.post('/api/chats/',{'kind':'direct','email':friend.email}).json()
        message=self.post(f"/api/chats/{chat['id']}/messages/",{'body':'workspace note'}).json()
        company_b=Organization.objects.create(
            name='Second Company',slug='reaction-second-company',created_by=owner,
        )
        OrganizationMember.objects.create(
            organization=company_b,user=owner,role=OrganizationMember.Role.OWNER,
        )
        self.assertEqual(self.post(f'/api/organizations/{company_b.pk}/activate/').status_code,200)
        result=self.post(f"/api/chats/{chat['id']}/messages/{message['id']}/reactions/",{'emoji':'👍'})
        self.assertIn(result.status_code,(403,404))
        self.assertEqual(ChatReaction.objects.count(),0)

    def test_offboarded_member_cannot_react(self):
        org=self.register()
        friend=self.employee(org,'friend@first.test')
        chat=self.post('/api/chats/',{'kind':'direct','email':friend.email}).json()
        message=self.post(f"/api/chats/{chat['id']}/messages/",{'body':'private message'}).json()
        self.login(friend.email)
        OrganizationMember.objects.filter(organization=org,user=friend).delete()
        result=self.post(f"/api/chats/{chat['id']}/messages/{message['id']}/reactions/",{'emoji':'😂'})
        self.assertIn(result.status_code,(403,404))
        self.assertEqual(ChatReaction.objects.count(),0)

    def test_cannot_react_deleted_message(self):
        org=self.register()
        friend=self.employee(org,'friend@first.test')
        chat=self.post('/api/chats/',{'kind':'direct','email':friend.email}).json()
        message=self.post(f"/api/chats/{chat['id']}/messages/",{'body':'Delete me'}).json()
        endpoint=f"/api/chats/{chat['id']}/messages/{message['id']}/reactions/"
        self.assertEqual(self.post(endpoint,{'emoji':'🎉'}).status_code,200)
        self.assertEqual(ChatReaction.objects.count(),1)
        deleted=self.client.delete(
            f"/api/chats/{chat['id']}/messages/{message['id']}/",
            HTTP_X_CSRFTOKEN=self.csrf,
        )
        self.assertEqual(deleted.status_code,204,deleted.content)
        self.assertEqual(ChatReaction.objects.count(),0)
        res=self.post(endpoint,{'emoji':'👍'})
        self.assertEqual(res.status_code,400,res.content)

    def test_workplace_reactions_are_persisted_and_toggleable(self):
        org=self.register()
        friend=self.employee(org,'colleague@first.test')
        chat=self.post('/api/chats/',{'kind':'direct','email':friend.email}).json()
        message=self.post(f"/api/chats/{chat['id']}/messages/",{'body':'Project update'}).json()
        endpoint=f"/api/chats/{chat['id']}/messages/{message['id']}/reactions/"
        for emoji in ('✅', '👏', '🙏', '🤝', '💡', '👌', '💯'):
            with self.subTest(emoji=emoji):
                result=self.post(endpoint,{'emoji':emoji})
                self.assertEqual(result.status_code,200,result.content)
                self.assertTrue(ChatReaction.objects.filter(emoji=emoji).exists())
                self.assertEqual(self.post(endpoint,{'emoji':emoji}).status_code,200)
                self.assertFalse(ChatReaction.objects.filter(emoji=emoji).exists())
