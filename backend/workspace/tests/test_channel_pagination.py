"""Keyset-paginated channel history, stable ordering and tenant boundaries."""
import json
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from workspace.models import Channel, Message, Organization, OrganizationMember, Team, TeamMember


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class ChannelPaginationTests(TestCase):
    def setUp(self):
        self.client=Client(enforce_csrf_checks=True)
        self.csrf=self.client.get('/api/auth/csrf/').json()['csrf_token']
        registered=self.post('/api/auth/register/', {
            'email':'owner@a.test', 'password':'SafePassword123!',
            'full_name':'Owner', 'organization_name':'Company A',
        })
        self.assertEqual(registered.status_code, 201, registered.content)
        self.org=Organization.objects.get(pk=registered.json()['active_organization_id'])
        self.owner=get_user_model().objects.get(email='owner@a.test')
        self.team=Team.objects.create(
            organization=self.org, created_by=self.owner, name='Engineering',
        )
        TeamMember.objects.create(team=self.team, user=self.owner, role=TeamMember.Role.OWNER)
        self.channel=Channel.objects.create(team=self.team, name='General')

    def post(self, path, body=None):
        response=self.client.post(
            path, data=json.dumps(body or {}), content_type='application/json',
            HTTP_X_CSRFTOKEN=self.csrf,
        )
        if response.status_code < 300:
            self.csrf=self.client.get('/api/auth/csrf/').json()['csrf_token']
        return response

    def login(self, email):
        self.assertEqual(self.post('/api/auth/logout/').status_code, 200)
        result=self.post('/api/auth/login/', {
            'email':email, 'password':'SafePassword123!',
        })
        self.assertEqual(result.status_code, 200, result.content)

    def employee(self, email, *, member=False):
        user=get_user_model().objects.create_user(
            email=email, full_name='Employee', password='SafePassword123!',
        )
        OrganizationMember.objects.create(organization=self.org, user=user)
        if member:
            TeamMember.objects.create(team=self.team, user=user)
        return user

    def url(self):
        return f'/api/channels/{self.channel.pk}/messages/'

    def seed(self, count):
        Message.objects.bulk_create([
            Message(channel=self.channel, sender=self.owner, body=f'Message {i}')
            for i in range(count)
        ])

    def test_pages_do_not_skip_or_duplicate_tied_timestamps(self):
        self.seed(121)
        # 65 identical timestamps cross the 50-item page boundary.
        newest=list(Message.objects.order_by('-created_at', '-id')[:65])
        tied_time=timezone.now() + timedelta(seconds=2)
        Message.objects.filter(pk__in=[m.pk for m in newest]).update(created_at=tied_time)

        legacy=self.client.get(self.url())
        self.assertEqual(legacy.status_code, 200, legacy.content)
        self.assertIsInstance(legacy.json(), list)
        self.assertEqual(len(legacy.json()), 50)

        cursor=None
        batches=[]
        seen=set()
        for index in range(5):
            query={'page':'1'}
            if cursor:
                query.update(cursor)
            response=self.client.get(self.url(), query)
            self.assertEqual(response.status_code, 200, response.content)
            payload=response.json()
            rows=payload['items']
            self.assertLessEqual(len(rows), 50)
            self.assertEqual(
                [(row['created_at'],row['id']) for row in rows],
                sorted((row['created_at'],row['id']) for row in rows),
            )
            page_ids={row['id'] for row in rows}
            self.assertFalse(page_ids & seen, 'Page contained a repeated message')
            seen.update(page_ids)
            batches.append(len(rows))
            cursor=payload['next_cursor']
            self.assertEqual(bool(cursor), payload['has_more'])
            if not cursor:
                break
        self.assertEqual(batches, [50,50,21])
        ordered=list(Message.objects.filter(channel=self.channel)
                     .order_by('created_at', 'id').values_list('pk', flat=True))
        self.assertEqual(seen, {str(pk) for pk in ordered})

    def test_validation_of_cursors_and_page_mode(self):
        self.seed(2)
        wrong=[
            {'page':'2'},
            {'page':'1', 'before':'not-a-date'},
            {'page':'1', 'before':'2026-01-01T12:00:00'},
            {'page':'1', 'before_id':'not-a-uuid'},
            {'page':'1', 'before':'2026-01-01T12:00:00Z', 'before_id':'invalid'},
        ]
        for params in wrong:
            response=self.client.get(self.url(), params)
            self.assertEqual(response.status_code, 400, (params, response.content))
        legacy_before=self.client.get(self.url(), {'before':'2030-01-01T00:00:00Z'})
        self.assertEqual(legacy_before.status_code, 200)
        self.assertEqual(len(legacy_before.json()), 2)

    def test_uses_current_join_time_and_blocks_outsiders(self):
        self.seed(7)
        alice=self.employee('alice@a.test', member=True)
        excluded=self.employee('excluded@a.test')
        self.seed(55)
        self.login(alice.email)
        first=self.client.get(self.url(), {'page':'1'}).json()
        self.assertEqual(len(first['items']), 50)
        self.assertTrue(first['has_more'])
        second=self.client.get(self.url(), {'page':'1', **first['next_cursor']}).json()
        self.assertEqual(len(second['items']), 5)
        self.assertFalse(second['has_more'])
        self.assertIsNone(second['next_cursor'])
        self.assertEqual(len({
            row['id'] for row in first['items'] + second['items']
        }), 55)

        self.login(excluded.email)
        self.assertEqual(self.client.get(self.url(), {'page':'1'}).status_code, 403)
        self.login(alice.email)
        TeamMember.objects.filter(team=self.team, user=alice).delete()
        self.assertEqual(self.client.get(self.url(), {'page':'1'}).status_code, 403)
        TeamMember.objects.create(team=self.team, user=alice)
        Message.objects.create(channel=self.channel, sender=self.owner, body='After rejoin')
        after=self.client.get(self.url(), {'page':'1'}).json()
        self.assertEqual(len(after['items']), 1)
        self.assertEqual(after['items'][0]['body'], 'After rejoin')
        self.assertFalse(after['has_more'])

    def test_switching_workspaces_cannot_read_channel_pages(self):
        self.seed(2)
        self.assertEqual(len(self.client.get(self.url(), {'page':'1'}).json()['items']), 2)
        other=Organization.objects.create(
            name='Company B', slug='pagination-company-b', created_by=self.owner,
        )
        OrganizationMember.objects.create(
            organization=other, user=self.owner,
            role=OrganizationMember.Role.ADMIN,
        )
        active=self.post(f'/api/organizations/{other.pk}/activate/')
        self.assertEqual(active.status_code, 200, active.content)
        self.assertEqual(self.client.get(self.url(), {'page':'1'}).status_code, 403)

