import json
from django.core.management.base import BaseCommand, CommandError
from mailbox_app.configuration import provider_status


class Command(BaseCommand):
    help = "Check Gmail/Outlook configuration without printing secrets or contacting provider accounts."
    requires_system_checks = []

    def add_arguments(self, parser):
        parser.add_argument("--provider", choices=("gmail", "outlook", "all"), default="all")
        parser.add_argument("--json", action="store_true", dest="as_json")

    def handle(self, *args, **options):
        providers = ("gmail", "outlook") if options["provider"] == "all" else (options["provider"],)
        statuses = [provider_status(provider) for provider in providers]
        if options["as_json"]:
            self.stdout.write(json.dumps({"providers": statuses}))
        else:
            for status in statuses:
                self.stdout.write(status["provider"].capitalize() + ": " + ("CONFIGURATION READY" if status["ready"] else "SETUP REQUIRED"))
                if status["redirect_uri"]:
                    self.stdout.write("Web redirect URI: " + status["redirect_uri"])
                for issue in status["issues"]:
                    self.stdout.write("- " + issue)
            self.stdout.write("This checks configuration only. Provider registration, email verification, consent and a real send/reply test are still required.")
        if not any(status["ready"] for status in statuses):
            raise CommandError("Mail configuration is incomplete. Run tools/setup-mail.ps1 or see docs/REAL_MAIL_QUICKSTART.md.")
