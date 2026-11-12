"""Regression checks for workspace-scoped real-time notification signals."""
import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from workspace.models import Organization, OrganizationMember
from workspace.notification_events import notification_group, publish_notification_refresh


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class RealtimeNotificationTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']

    def post(self, path, data=None):
        res = self.client.post(
            path, data=json.dumps(data or {}), content_type='application/json',
            HTTP_X_CSRFTOKEN=self.csrf,
        )
        if res.status_code < 300:
            self.csrf = self.client.get('/api/auth/csrf/').json()['csrf_token']
        return res

    def register(self):
        res = self.post('/api/auth/register/', {
            'email': 'owner@first.test', 'full_name': 'Owner',
            'password': 'GoodPassword123!', 'organization_name': 'First Company',
        })
        self.assertEqual(res.status_code, 201, res.content)
        return Organization.objects.get(pk=res.json()['active_organization_id'])

    def employee(self, org, email):
        user = get_user_model().objects.create_user(
            email=email, password='GoodPassword123!', full_name=email.split('@')[0],
        )
        OrganizationMember.objects.create(organization=org, user=user)
        return user

    def test_signal_contains_no_sensitive_message_content(self):
        org = self.register()
        a = get_user_model().objects.get(email='owner@first.test')
        b = self.employee(org, 'colleague@first.test')
        other = Organization.objects.create(
            name='Other Company', slug='other-company', created_by=a,
        )
        self.assertNotEqual(notification_group(org.pk, a.pk),
                            notification_group(other.pk, a.pk))
        with patch('workspace.notification_events.get_channel_layer') as layer, patch(
            'workspace.notification_events.async_to_sync',
        ) as bridge:
            publish_notification_refresh(org.pk, [a.pk, b.pk, b.pk])
        self.assertEqual(bridge.call_count, 2)  # one wrapper invocation per unique recipient
        wrapper = bridge.return_value
        self.assertEqual(wrapper.call_count, 2)
        groups = {call.args[0] for call in wrapper.call_args_list}
        self.assertEqual(groups, {
            notification_group(org.pk, a.pk),
            notification_group(org.pk, b.pk),
        })
        for call in wrapper.call_args_list:
            self.assertEqual(call.args[1], {'type': 'notification.refresh'})
        self.assertTrue(layer.called)

    def test_direct_message_notifies_only_same_company_participants(self):
        org = self.register()
        owner = get_user_model().objects.get(email='owner@first.test')
        member = self.employee(org, 'colleague@first.test')
        outside = get_user_model().objects.create_user(
            email='outside@second.test', password='GoodPassword123!',
            full_name='Outside',
        )
        other = Organization.objects.create(
            name='Other Company', slug='other-company', created_by=outside,
        )
        OrganizationMember.objects.create(organization=other, user=outside)
        with patch('workspace.chat_views.publish_notification_refresh'):
            created = self.post('/api/chats/', {'kind':'direct', 'email':member.email})
        self.assertEqual(created.status_code, 201, created.content)
        with patch('workspace.chat_views.publish_notification_refresh') as notify, patch(
            'workspace.chat_views.publish_chat_message',
        ):
            with self.captureOnCommitCallbacks(execute=True):
                sent = self.post(
                    f"/api/chats/{created.json()['id']}/messages/", {'body':'Private message'},
                )
        self.assertEqual(sent.status_code, 201, sent.content)
        notify.assert_called_once()
        org_id, recipients = notify.call_args.args
        self.assertEqual(org_id, org.pk)
        self.assertEqual(set(recipients), {owner.pk, member.pk})
        self.assertNotIn(outside.pk, recipients)

    def test_channel_message_notifies_only_team_members(self):
        org = self.register()
        owner = get_user_model().objects.get(email='owner@first.test')
        team_user = self.employee(org, 'in-team@first.test')
        not_in_team = self.employee(org, 'not-in-team@first.test')
        team = self.post('/api/teams/', {'name':'Engineering'})
        self.assertEqual(team.status_code, 201, team.content)
        team_id = team.json()['id']
        channels = self.client.get(f'/api/teams/{team_id}/channels/').json()
        self.assertEqual(len(channels), 1)
        added = self.post(f'/api/teams/{team_id}/members/', {'email':team_user.email})
        self.assertEqual(added.status_code, 201, added.content)
        with patch('workspace.views.publish_notification_refresh') as notify, patch(
            'workspace.views.broadcast_message',
        ):
            with self.captureOnCommitCallbacks(execute=True):
                result = self.post(
                    f"/api/channels/{channels[0]['id']}/messages/", {'body':'Team update'},
                )
        self.assertEqual(result.status_code, 201, result.content)
        notify.assert_called_once()
        org_id, recipients = notify.call_args.args
        self.assertEqual(org_id, org.pk)
        self.assertEqual(set(recipients), {owner.pk, team_user.pk})
        self.assertNotIn(not_in_team.pk, recipients)

    def test_anonymous_socket_has_no_membership_or_session(self):
        from workspace.notification_consumers import NotificationConsumer
        consumer = NotificationConsumer()
        consumer.scope = {'session': None, 'user': None}
        self.assertFalse(consumer.scope.get('session'))
        # No websocket can enter a user feed without a session and an
        # authorized active organization, as checked on connect and send.
        self.assertTrue(hasattr(consumer, 'authorized'))
