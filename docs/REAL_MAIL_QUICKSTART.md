# Connect a real Gmail or Outlook mailbox

The mailbox API already supports Gmail and Microsoft Graph. A GitHub merge cannot supply OAuth credentials for your Google/Microsoft account or grant mailbox consent. Create the provider application once, then use the local helper below. Other employees connect their own accounts through Manage mailboxes after the application is configured.

## One-command Windows setup

Open **PowerShell** in VS Code from the existing project checkout. Keep Docker Desktop running and retain your existing root `.env`.

```powershell
git pull origin main
.\tools\setup-mail.ps1 -Provider gmail
```

For Outlook/Microsoft 365:

```powershell
.\tools\setup-mail.ps1 -Provider outlook
```

The helper builds/starts the API, prompts for the provider client ID and secret, updates only the selected provider's settings and shared mail settings, generates an encryption key only if one is missing, recreates the API and checks the configuration. Secrets are entered without echo and are not passed as command arguments. Existing database settings, comments, the other provider and valid encryption keys are preserved. A malformed existing encryption key stops setup rather than silently replacing it.

The helper writes the selected client secret in the corresponding `MAIL_GOOGLE_CLIENT_SECRET_BASE64` or `MAIL_MICROSOFT_CLIENT_SECRET_BASE64` variable so Docker preserves all literal characters. The API decodes it before contacting the provider. Base64 is encoding, not encryption; protect this `.env` like any credential file. Existing plaintext `MAIL_*_CLIENT_SECRET` configurations remain supported; a nonempty encoded value takes precedence.

For a Google **Web application** client JSON downloaded outside the repository, import it directly:

```powershell
.\tools\setup-mail.ps1 -Provider gmail -GoogleClientJson "$env:USERPROFILE\Downloads\client_secret.json"
```

The JSON must include the matching Web redirect URI. The file is mounted read-only for import; credential values are saved only in the ignored local `.env`. Do not commit credential JSON or `.env` files.

If running without the PowerShell wrapper, install `python-dotenv` and run `python tools/setup_mail.py --provider gmail` from an interactive local terminal, then rebuild/recreate the API with `docker compose up -d --build --force-recreate api`.

## Values required from your provider

| Provider | Required app configuration | Exact local Web redirect URI |
| --- | --- | --- |
| Gmail | Enable Gmail API; configure an External testing app and add your test users; request `https://www.googleapis.com/auth/gmail.modify`; create a Web application OAuth client. Save its client ID and client secret. | `http://localhost:5173/api/mail/oauth/gmail/callback/` |
| Outlook | Register an Entra application supporting your users; configure the Web platform; add delegated `User.Read`, `Mail.ReadWrite`, `Mail.Send` and `offline_access`. Save Application (client) ID and the client secret **Value**, not Secret ID. For organizational plus personal accounts use tenant `common`. | `http://localhost:5173/api/mail/oauth/outlook/callback/` |

For exact provider-console instructions, see [EMAIL_SETUP.md](EMAIL_SETUP.md). Google/Microsoft may require organization-admin approval or additional review for wider rollout. The helper does not create cloud projects, accept provider agreements, change tenant permissions or validate a secret against a live provider account.

Use localhost consistently in your browser. For a deployed app use its HTTPS origin and register the corresponding HTTPS callback. The callback and frontend must use the same host/scheme so the signed-in browser session is available; different localhost ports are supported.

## Connect and verify delivery

1. Open `http://localhost:5173` and sign in. Verify your TeamWorkspace email. In development, click Resend verification and retrieve the link with `docker compose logs api --tail=100`.
2. Open Email inbox → Manage mailboxes → Connect Gmail or Connect Outlook. Complete provider sign-in and review the requested access.
3. Select the **connected Gmail/Outlook mailbox** from the mailbox dropdown. The local workspace mailbox continues to deliver only inside the company workspace.
4. Send a test email to another real account you control and check its inbox/Sent Items in the provider.
5. Reply from the other account, then click Refresh mailbox in TeamWorkspace. Test an attachment, a draft and a reply/forward.

Configuration ready means that required local values are present and structurally valid. It does **not** confirm provider registration, API activation, consent, credentials accepted by the provider or recipient delivery. Real delivery is verified only by the send/reply test.

## Configuration diagnostics

```powershell
docker compose exec api python manage.py check_mail_setup --provider gmail
docker compose exec api python manage.py check_mail_setup --provider outlook
docker compose exec api python manage.py check_mail_setup --provider gmail --json
```

These commands report missing values, invalid encryption keys, malformed callback origins and invalid Microsoft tenants without displaying credential values. They do not contact Google/Microsoft. `--provider gmail` or `--provider outlook` exits nonzero when that provider needs configuration; the default overview succeeds when at least one provider is ready.

Never regenerate a valid encryption key merely to rerun setup: existing connected accounts need that key to decrypt their stored tokens. Keep `.env` with your server secrets.
