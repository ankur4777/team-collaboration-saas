import io
import json
from types import SimpleNamespace
from unittest.mock import patch
from cryptography.fernet import Fernet
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIRequestFactory, force_authenticate
from mailbox_app.configuration import provider_status
from mailbox_app.oauth import configured
from mailbox_app.views import ConfigurationView


@override_settings(MAIL_GOOGLE_CLIENT_ID="test-client", MAIL_GOOGLE_CLIENT_SECRET="test-client-secret",
                   MAIL_MICROSOFT_CLIENT_ID="test-microsoft-client", MAIL_MICROSOFT_CLIENT_SECRET="test-microsoft-secret",
                   MAIL_MICROSOFT_TENANT="common", MAIL_TOKEN_ENCRYPTION_KEY=Fernet.generate_key().decode(),
                   FRONTEND_ORIGIN="http://localhost:5173", MAIL_CALLBACK_ORIGIN="http://localhost:5173")
class ProviderSetupTests(SimpleTestCase):
    def test_configured_provider_has_exact_callback(self):
        status = provider_status("gmail")
        self.assertTrue(status["ready"])
        self.assertEqual(status["redirect_uri"], "http://localhost:5173/api/mail/oauth/gmail/callback/")

    @override_settings(MAIL_TOKEN_ENCRYPTION_KEY="broken")
    def test_invalid_key_does_not_crash_mail_settings(self):
        request = APIRequestFactory().get("/api/mail/config/")
        force_authenticate(request, user=SimpleNamespace(is_authenticated=True))
        with patch("mailbox_app.views.get_active_membership"):
            response = ConfigurationView.as_view()(request)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["gmail_configured"])
        self.assertFalse(response.data["outlook_configured"])

    @override_settings(MAIL_GOOGLE_CLIENT_SECRET="YOUR_WEB_CLIENT_SECRET")
    def test_placeholder_is_not_treated_as_ready(self):
        self.assertFalse(configured("gmail"))

    def test_invalid_origin_is_not_usable(self):
        for origin in ("http://external.example.test", "https://user:password@example.test", "https://example.test/path"):
            with self.subTest(origin=origin), override_settings(MAIL_CALLBACK_ORIGIN=origin):
                self.assertFalse(configured("gmail"))

    @override_settings(MAIL_MICROSOFT_TENANT="-" * 36)
    def test_invalid_microsoft_tenant_is_not_ready(self):
        self.assertFalse(configured("outlook"))

    @override_settings(MAIL_CALLBACK_ORIGIN="http://localhost:8000")
    def test_same_host_with_different_port_keeps_browser_cookie_flow(self):
        self.assertTrue(configured("gmail"))

    @override_settings(MAIL_CALLBACK_ORIGIN="http://127.0.0.1:5173")
    def test_different_browser_host_is_rejected(self):
        self.assertFalse(configured("gmail"))

    def test_command_json_redacts_credentials(self):
        output = io.StringIO()
        call_command("check_mail_setup", provider="gmail", as_json=True, stdout=output)
        self.assertTrue(json.loads(output.getvalue())["providers"][0]["ready"])
        for secret in ("test-client-secret", "test-microsoft-secret"):
            self.assertNotIn(secret, output.getvalue())

    @override_settings(MAIL_GOOGLE_CLIENT_ID="", MAIL_TOKEN_ENCRYPTION_KEY="not-a-secret-key")
    def test_command_fails_with_actionable_nonsecret_issues(self):
        output = io.StringIO()
        with self.assertRaises(CommandError):
            call_command("check_mail_setup", provider="gmail", stdout=output)
        self.assertIn("MAIL_GOOGLE_CLIENT_ID", output.getvalue())
        self.assertIn("MAIL_TOKEN_ENCRYPTION_KEY", output.getvalue())
        self.assertNotIn("not-a-secret-key", output.getvalue())
        self.assertNotIn("test-client-secret", output.getvalue())
