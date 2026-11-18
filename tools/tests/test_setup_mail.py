import base64
from contextlib import redirect_stdout, redirect_stderr
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from dotenv import dotenv_values

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import setup_mail


CLIENT_ID = "123456-localtest.apps.googleusercontent.com"
CLIENT_SECRET = "test-only-$literal#secret's\\path"
KEY = base64.urlsafe_b64encode(bytes(range(32))).decode()


class MailSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = self.root / ".env"
        self.original = b"# Existing settings\r\nMYSQL_PASSWORD='db-$literal'\r\nFRONTEND_ORIGIN=http://localhost:5173\r\nOTHER='first\r\nsecond'\r\n"
        self.env.write_bytes(self.original)

    def configure(self, answers=None, secret=CLIENT_SECRET, provider="gmail", client_json=None):
        answers = iter(answers if answers is not None else ["", CLIENT_ID])
        out = io.StringIO()
        with redirect_stdout(out):
            redirect = setup_mail.configure(self.root, provider, read=lambda _: next(answers),
                                            read_secret=lambda _: secret, client_json=client_json)
        if secret:
            self.assertNotIn(secret, out.getvalue())
        return redirect, out.getvalue()

    def test_preserves_database_multiline_comments_and_crlf(self):
        redirect, _ = self.configure()
        self.assertTrue(self.env.read_bytes().startswith(self.original))
        values = dotenv_values(self.env, interpolate=False)
        self.assertEqual(values["MYSQL_PASSWORD"], "db-$literal")
        self.assertEqual(values["OTHER"], "first\nsecond")
        self.assertEqual(base64.b64decode(values["MAIL_GOOGLE_CLIENT_SECRET_BASE64"]).decode(), CLIENT_SECRET)
        self.assertNotIn("MAIL_GOOGLE_CLIENT_SECRET", values)
        self.assertEqual(len(base64.urlsafe_b64decode(values["MAIL_TOKEN_ENCRYPTION_KEY"])), 32)
        self.assertEqual(redirect, "http://localhost:5173/api/mail/oauth/gmail/callback/")

    def test_repeated_setup_keeps_key_and_existing_credentials(self):
        self.configure()
        values = dotenv_values(self.env, interpolate=False)
        self.configure(["", ""], secret="")
        self.assertEqual(dict(dotenv_values(self.env, interpolate=False)), dict(values))
        self.assertEqual(self.env.read_text().count("MAIL_TOKEN_ENCRYPTION_KEY="), 1)

    def test_existing_invalid_key_is_not_rotated(self):
        self.env.write_text(self.env.read_text() + "MAIL_TOKEN_ENCRYPTION_KEY=broken\n")
        original = self.env.read_bytes()
        with self.assertRaises(setup_mail.SetupError):
            self.configure()
        self.assertEqual(self.env.read_bytes(), original)

    def test_existing_plaintext_secret_is_kept_without_reserializing(self):
        line = "MAIL_GOOGLE_CLIENT_SECRET='original\\\\literal-secret'\r\n"
        self.env.write_bytes(self.original + line.encode())
        self.configure(secret="")
        self.assertIn(line.encode(), self.env.read_bytes())
        self.assertNotIn("MAIL_GOOGLE_CLIENT_SECRET_BASE64", dotenv_values(self.env))

    def test_invalid_client_and_multiline_secret_do_not_change_file(self):
        for answers, secret in [(["", "wrong-client"], CLIENT_SECRET), (["", CLIENT_ID], "secret\nINJECTED=yes")]:
            with self.subTest(secret_length=len(secret)):
                with self.assertRaises(setup_mail.SetupError):
                    self.configure(answers, secret=secret)
                self.assertEqual(self.env.read_bytes(), self.original)

    def test_replaces_duplicate_mail_keys_without_touching_other_provider(self):
        self.env.write_bytes(self.original + ("MAIL_GOOGLE_CLIENT_ID=old\r\nMAIL_GOOGLE_CLIENT_ID=duplicate\r\n"
                                              "MAIL_MICROSOFT_CLIENT_SECRET='keep-this-secret'\r\n").encode())
        self.configure()
        self.assertEqual(self.env.read_text().count("MAIL_GOOGLE_CLIENT_ID="), 1)
        self.assertEqual(dotenv_values(self.env)["MAIL_MICROSOFT_CLIENT_SECRET"], "keep-this-secret")

    def test_google_json_import_and_redirect_validation(self):
        file = self.root / "google.json"
        config = {"web": {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
                          "redirect_uris": ["http://localhost:5173/api/mail/oauth/gmail/callback/"]}}
        file.write_text(json.dumps(config))
        self.configure([""], client_json=file)
        self.assertEqual(base64.b64decode(dotenv_values(self.env, interpolate=False)["MAIL_GOOGLE_CLIENT_SECRET_BASE64"]).decode(), CLIENT_SECRET)
        config["web"]["redirect_uris"] = ["http://localhost:8000/wrong"]
        file.write_text(json.dumps(config))
        original = self.env.read_bytes()
        with self.assertRaises(setup_mail.SetupError):
            self.configure([""], client_json=file)
        self.assertEqual(self.env.read_bytes(), original)

    def test_google_installed_app_json_is_rejected(self):
        file = self.root / "google.json"
        file.write_text(json.dumps({"installed": {"client_id": CLIENT_ID}}))
        with self.assertRaises(setup_mail.SetupError):
            self.configure([""], client_json=file)
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_google_json_missing_secret_cannot_reuse_another_clients_secret(self):
        file = self.root / "google.json"
        file.write_text(json.dumps({"web": {"client_id": CLIENT_ID,
                                          "redirect_uris": ["http://localhost:5173/api/mail/oauth/gmail/callback/"]}}))
        with self.assertRaises(setup_mail.SetupError):
            self.configure([""], client_json=file)
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_outlook_keeps_key_and_saves_tenant(self):
        self.env.write_bytes(self.original + ("MAIL_TOKEN_ENCRYPTION_KEY='" + KEY + "'\r\n").encode())
        self.configure(["", "11111111-2222-4333-8444-555555555555", "organizations"], provider="outlook")
        values = dotenv_values(self.env, interpolate=False)
        self.assertEqual(values["MAIL_TOKEN_ENCRYPTION_KEY"], KEY)
        self.assertEqual(values["MAIL_MICROSOFT_TENANT"], "organizations")

    def test_bad_tenant_is_rejected_without_saving(self):
        with self.assertRaises(setup_mail.SetupError):
            self.configure(["", "11111111-2222-4333-8444-555555555555", "invalid/tenant"], provider="outlook")
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_callback_cannot_include_credentials_or_external_http(self):
        for address in ["http://mail.example.test", "https://user:password@example.test", "https://example.test/callback", "http://localhost:5173/?secret=1"]:
            with self.subTest(address=address), self.assertRaises(setup_mail.SetupError):
                self.configure([address])
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_concurrent_env_change_is_preserved(self):
        def read_secret(_):
            self.env.write_bytes(self.original + b"NEW_SETTING=preserve\r\n")
            return CLIENT_SECRET
        answers = iter(["", CLIENT_ID])
        with redirect_stdout(io.StringIO()), self.assertRaises(setup_mail.SetupError):
            setup_mail.configure(self.root, "gmail", read=lambda _: next(answers), read_secret=read_secret)
        self.assertIn(b"NEW_SETTING=preserve", self.env.read_bytes())
        self.assertEqual(list(self.root.glob(".env.mail-*")), [])

    def test_noninteractive_input_is_rejected_before_prompting(self):
        with patch.object(sys.stdin, "isatty", return_value=False), redirect_stderr(io.StringIO()):
            self.assertEqual(setup_mail.main(["--provider", "gmail", "--root", str(self.root)]), 1)
        self.assertEqual(self.env.read_bytes(), self.original)

    @unittest.skipIf(os.name == "nt", "POSIX ownership/permissions check")
    def test_secret_file_permissions_and_owner(self):
        original_stat = self.env.stat()
        self.configure()
        self.assertEqual(self.env.stat().st_uid, original_stat.st_uid)
        self.assertEqual(self.env.stat().st_mode & 0o077, 0)

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose is checked in Linux CI")
    def test_compose_preserves_literal_secret_characters(self):
        version = subprocess.run(["docker", "compose", "version"], capture_output=True)
        if version.returncode:
            self.skipTest("Docker Compose is unavailable")
        self.configure()
        (self.root / "compose.yaml").write_text("services:\n  test:\n    image: alpine\n    env_file: .env\n")
        result = subprocess.run(["docker", "compose", "config", "--format", "json"], cwd=self.root,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, "Compose could not parse the fixture environment")
        value = json.loads(result.stdout)["services"]["test"]["environment"]["MAIL_GOOGLE_CLIENT_SECRET_BASE64"]
        self.assertEqual(base64.b64decode(value).decode(), CLIENT_SECRET)


if __name__ == "__main__":
    unittest.main()
