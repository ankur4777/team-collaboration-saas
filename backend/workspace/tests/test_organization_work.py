import json
import tempfile
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from workspace.models import (Department, Organization, OrganizationMember, Team, TeamMember,
                              ChatConversation, ChatMessage, PrivateAttachment, EmployeeTask, CompanyLicense)


class OrganizationWorkTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.owner = self.user('owner')
        self.senior = self.user('senior')
        self.employee = self.user('employee')
        self.other = self.user('other')
        self.org = Organization.objects.create(name='Example', slug='org-work', created_by=self.owner)
        for user, role in [(self.owner,'admin'),(self.senior,'member'),(self.employee,'member'),(self.other,'member')]:
            OrganizationMember.objects.create(organization=self.org,user=user,role=role,is_senior=user==self.senior,
                                               job_title='Project Manager' if user==self.senior else 'Developer',position_rank=1 if user==self.senior else 10)
        self.department = Department.objects.create(organization=self.org, name='Engineering')
        self.team = Team.objects.create(organization=self.org, department=self.department, name='Platform', created_by=self.employee)
        TeamMember.objects.create(team=self.team,user=self.employee,role='owner')
        TeamMember.objects.create(team=self.team,user=self.senior)
        self.foreign_org = Organization.objects.create(name='Foreign', slug='foreign-work', created_by=self.other)
        self.foreign_user = self.user('foreign')
        OrganizationMember.objects.create(organization=self.foreign_org,user=self.foreign_user)
        self.login(self.owner)

    def user(self,name):
        return get_user_model().objects.create_user(email=f'{name}@test.invalid',full_name=name.title(),password='StrongPassword123!')

    def login(self,user,org=None):
        self.client.force_login(user)
        session=self.client.session
        session['active_organization_id']=str((org or self.org).pk)
        session.save()
        self.csrf=self.client.get('/api/auth/csrf/').json()['csrf_token']

    def mutate(self,url,data=None,method='post'):
        return getattr(self.client,method)(url,data=json.dumps(data or {}),content_type='application/json',HTTP_X_CSRFTOKEN=self.csrf)

    def group(self):
        self.login(self.senior)
        response=self.mutate('/api/chats/',{'kind':'group','title':'Project Apollo','emails':[self.employee.email,self.other.email]})
        self.assertEqual(response.status_code,201,response.content)
        return response.json()['id']

    def task(self,assignee=None):
        self.login(self.senior)
        response=self.mutate('/api/tasks/',{'title':'Build the module','description':'Project Apollo','assignee_id':str((assignee or self.employee).pk),'priority':'high','due_date':'2026-12-20'})
        self.assertEqual(response.status_code,201,response.content)
        return response.json()['id']

    def test_directory_is_tenant_scoped_and_members_are_position_ordered(self):
        Department.objects.create(organization=self.foreign_org,name='Secret department')
        self.login(self.employee)
        data=self.client.get('/api/chat-directory/').json()
        self.assertEqual([d['name'] for d in data['departments']],['Engineering'])
        self.assertEqual([row['user']['id'] for row in data['teams'][0]['members']],[str(self.senior.pk),str(self.employee.pk)])
        self.assertFalse(data['can_create_groups'])
        self.assertFalse(data['can_manage'])
        self.assertNotIn(str(self.foreign_user.pk),[r['user']['id'] for r in data['members']])

    def test_admin_can_create_department_move_team_and_set_positions(self):
        response=self.mutate('/api/departments/',{'name':'Operations'})
        self.assertEqual(response.status_code,201,response.content)
        self.assertEqual(self.mutate(f'/api/chat-directory/teams/{self.team.pk}/',{'department_id':response.json()['id']},'patch').status_code,200)
        membership=OrganizationMember.objects.get(organization=self.org,user=self.employee)
        result=self.mutate(f'/api/chat-directory/members/{membership.pk}/',{'is_senior':True,'position_rank':2,'job_title':'Team Lead'},'patch')
        self.assertEqual(result.status_code,200,result.content)
        membership.refresh_from_db()
        self.assertTrue(membership.is_senior)
        self.assertEqual(membership.role,'member')
        self.login(self.employee)
        self.assertTrue(self.client.get('/api/chat-directory/').json()['can_create_groups'])

    def test_senior_cannot_grant_roles_or_manage_departments(self):
        membership=OrganizationMember.objects.get(organization=self.org,user=self.senior)
        self.login(self.senior)
        self.assertEqual(self.mutate('/api/departments/',{'name':'Forbidden'}).status_code,403)
        self.assertEqual(self.mutate(f'/api/chat-directory/members/{membership.pk}/',{'is_senior':True},'patch').status_code,403)
        self.assertEqual(self.mutate(f'/api/chat-directory/teams/{self.team.pk}/',{'department_id':None},'patch').status_code,403)

    def test_foreign_department_and_employee_cannot_be_assigned(self):
        foreign=Department.objects.create(organization=self.foreign_org,name='Foreign')
        self.assertEqual(self.mutate(f'/api/chat-directory/teams/{self.team.pk}/',{'department_id':str(foreign.pk)},'patch').status_code,404)
        self.assertEqual(self.mutate(f'/api/chat-directory/teams/{self.team.pk}/members/',{'user_id':str(self.foreign_user.pk)}).status_code,404)
        self.assertEqual(self.mutate('/api/departments/',{'name':'engineering'}).status_code,400)

    def test_admin_adds_team_employee_and_rejects_invalid_position(self):
        self.assertEqual(self.mutate(f'/api/chat-directory/teams/{self.team.pk}/members/',{'user_id':str(self.other.pk)}).status_code,201)
        membership=OrganizationMember.objects.get(organization=self.org,user=self.employee)
        for payload in ({'position_rank':0},{'position_rank':True},{'is_senior':'true'},{'role':'admin'}):
            self.assertEqual(self.mutate(f'/api/chat-directory/members/{membership.pk}/',payload,'patch').status_code,400)

    def test_team_ownership_alone_does_not_allow_group_creation_or_assignments(self):
        self.login(self.employee)
        self.assertEqual(self.mutate('/api/chats/',{'kind':'group','title':'Not allowed','emails':[self.senior.email,self.other.email]}).status_code,403)
        self.assertEqual(self.mutate('/api/tasks/',{'title':'Not allowed','assignee_id':str(self.other.pk)}).status_code,403)

    def test_member_click_can_create_direct_chat_without_senior_role(self):
        self.login(self.employee)
        response=self.mutate('/api/chats/',{'kind':'direct','email':self.senior.email})
        self.assertEqual(response.status_code,201,response.content)

    def test_senior_can_create_and_delete_their_project_group(self):
        group_id=self.group()
        chat=ChatConversation.objects.get(pk=group_id)
        ChatMessage.objects.create(conversation=chat,sender=self.senior,body='Project details')
        listed=self.client.get('/api/chats/').json()
        self.assertTrue(listed[0]['can_delete'])
        self.login(self.employee)
        self.assertFalse(self.client.get('/api/chats/').json()[0]['can_delete'])
        self.assertEqual(self.mutate(f'/api/chats/{group_id}/',method='delete').status_code,403)
        self.login(self.senior)
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.mutate(f'/api/chats/{group_id}/',method='delete').status_code,204)
        self.assertFalse(ChatConversation.objects.filter(pk=group_id).exists())
        self.assertFalse(ChatMessage.objects.filter(conversation_id=group_id).exists())
        self.login(self.employee)
        self.assertEqual(self.client.get(f'/api/chats/{group_id}/messages/').status_code,404)

    def test_group_deletion_removes_private_attachments_after_commit(self):
        group_id=self.group()
        with tempfile.TemporaryDirectory() as root, override_settings(MEDIA_ROOT=root):
            attachment=PrivateAttachment.objects.create(organization=self.org,uploaded_by=self.senior,chat_id=group_id,original_name='notes.txt',content_type='text/plain',size=5,file=SimpleUploadedFile('notes.txt',b'notes'))
            storage,name=attachment.file.storage,attachment.file.name
            with self.captureOnCommitCallbacks(execute=True):
                self.assertEqual(self.mutate(f'/api/chats/{group_id}/',method='delete').status_code,204)
            self.assertFalse(storage.exists(name))

    def test_other_senior_or_foreign_workspace_cannot_delete_group(self):
        group_id=self.group()
        OrganizationMember.objects.filter(organization=self.org,user=self.employee).update(is_senior=True)
        self.login(self.employee)
        self.assertEqual(self.mutate(f'/api/chats/{group_id}/',method='delete').status_code,403)
        OrganizationMember.objects.create(organization=self.foreign_org,user=self.senior,role='admin')
        self.login(self.senior,self.foreign_org)
        self.assertEqual(self.mutate(f'/api/chats/{group_id}/',method='delete').status_code,404)

    def test_task_assignment_status_and_employee_visibility(self):
        task_id=self.task()
        self.login(self.employee)
        data=self.client.get('/api/tasks/').json()
        self.assertEqual(len(data['results']),1)
        self.assertFalse(data['can_assign'])
        self.assertEqual(self.mutate(f'/api/tasks/{task_id}/',{'status':'in_progress'},'patch').status_code,200)
        self.assertEqual(self.mutate(f'/api/tasks/{task_id}/',{'title':'Tampered'},'patch').status_code,403)
        self.assertEqual(self.mutate(f'/api/tasks/{task_id}/',{'assignee_id':str(self.other.pk)},'patch').status_code,403)
        self.assertEqual(self.mutate(f'/api/tasks/{task_id}/',method='delete').status_code,403)
        self.login(self.other)
        self.assertEqual(self.client.get('/api/tasks/').json()['results'],[])
        self.assertEqual(self.mutate(f'/api/tasks/{task_id}/',{'status':'done'},'patch').status_code,404)

    def test_senior_can_edit_reassign_and_delete_their_task(self):
        task_id=self.task()
        response=self.mutate(f'/api/tasks/{task_id}/',{'assignee_id':str(self.other.pk),'title':'Updated assignment'},'patch')
        self.assertEqual(response.status_code,200,response.content)
        self.login(self.employee)
        self.assertEqual(self.client.get('/api/tasks/').json()['results'],[])
        self.login(self.senior)
        self.assertEqual(self.mutate(f'/api/tasks/{task_id}/',method='delete').status_code,204)
        self.assertFalse(EmployeeTask.objects.filter(pk=task_id).exists())

    def test_invalid_or_foreign_task_assignment_is_rejected(self):
        self.login(self.senior)
        for payload in ({'title':'Task','assignee_id':str(self.foreign_user.pk)}, {'title':' ','assignee_id':str(self.employee.pk)}, {'title':'Task','assignee_id':str(self.employee.pk),'due_date':'not-date'}, {'title':'Task','assignee_id':str(self.employee.pk),'organization_id':str(self.foreign_org.pk)}):
            self.assertEqual(self.mutate('/api/tasks/',payload).status_code,400)
        task_id=self.task()
        self.assertEqual(self.mutate(f'/api/tasks/{task_id}/',{'status':'invalid'},'patch').status_code,400)

    def test_downgraded_senior_cannot_create_or_manage_groups_and_tasks(self):
        group_id=self.group()
        task_id=self.task()
        OrganizationMember.objects.filter(organization=self.org,user=self.senior).update(is_senior=False)
        self.assertEqual(self.mutate(f'/api/chats/{group_id}/',method='delete').status_code,403)
        self.assertEqual(self.mutate(f'/api/tasks/{task_id}/',{'title':'Changed'},'patch').status_code,404)
        self.assertEqual(self.client.get('/api/tasks/').json()['results'], [])

    def test_csrf_and_module_access_are_enforced(self):
        self.assertEqual(self.client.post('/api/departments/',{'name':'No CSRF'}).status_code,403)
        CompanyLicense.objects.create(organization=self.org,enforce_modules=True,modules=['teams'])
        for path in ('/api/chat-directory/','/api/tasks/'):
            self.assertEqual(self.client.get(path).status_code,403)
