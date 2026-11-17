# Installation and mailbox setup

## Pull and start the update

Run from the existing checkout in VS Code PowerShell:

~~~powershell
cd C:\MicrosoftTeam\team-collaboration-saas
git pull origin main
docker compose up --build -d
docker compose exec api python manage.py migrate
docker compose exec api python manage.py check
docker compose exec api python manage.py showmigrations mailbox_app
~~~

The new migration is **mailbox_app.0001_initial**, depending on workspace migration 0009. It adds separate mail tables and preserves existing company, chat and reaction data. Startup applies migrations automatically; the explicit command confirms state.

Open **http://localhost:5173** and select **Email inbox**. Health: **http://localhost:8000/api/health/**.

Use localhost consistently for the browser and OAuth callback. Connection requests are tied to your signed-in browser session. Keep your existing .env and database volume.

## Immediate local testing

Local mail defaults on when DJANGO_DEBUG=true. Optionally add MAIL_LOCAL_ENABLED=true to your existing .env, then recreate the API.

1. Open Email inbox → Manage mailboxes → Add local workspace mailbox.
2. Compose to your own displayed account address and send.
3. Check Inbox/Sent; test drafts, editing, search, attachments, stars and Deleted/restore.
4. For another employee, use the same running app/company. They need their own connected local mailbox.

Local messages/files are persisted in the application database. Local delivery stays inside the active company; internet delivery requires Gmail/Outlook.

Independent Docker databases on two laptops have separate mail data, even with identical GitHub code.

## Provider encryption and verified email

Build the updated API, then generate an encryption key:

~~~powershell
docker compose exec api python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
~~~

Add to the existing root .env:

~~~dotenv
MAIL_TOKEN_ENCRYPTION_KEY=PASTE_YOUR_GENERATED_KEY
MAIL_CALLBACK_ORIGIN=http://localhost:5173
~~~

Keep this key stable and backed up with server secrets. Changing it prevents stored tokens being decrypted. The backend stores encrypted tokens and never returns them to React.

Verify your TeamWorkspace email before provider connection. Development verification links are in:

~~~powershell
docker compose logs api --tail=100
~~~

Use localhost consistently for the browser/callback; OAuth state is bound to the signed-in session and workspace.

## Gmail

Enable Gmail API in Google Cloud; configure the OAuth consent app and add test users while in testing. Create a **Web application** OAuth client with redirect URI:

~~~text
http://localhost:5173/api/mail/oauth/gmail/callback/
~~~

Set:

~~~dotenv
MAIL_GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID
MAIL_GOOGLE_CLIENT_SECRET=YOUR_WEB_CLIENT_SECRET
~~~

The module requests Gmail modify permission and offline access for reading, native drafts, sending and reversible label/trash changes. Google classifies this scope as restricted; external rollout requires applicable verification/data-access review.

Recreate the API and use Manage mailboxes → Connect Gmail from the same browser. Gmail messages remain authoritative in Gmail and are retrieved through its API.

## Outlook / Microsoft 365

Register an application in Microsoft Entra with account types matching your users. For organizations plus Outlook.com, support organizations/personal Microsoft accounts and use tenant common.

Add a **Web** redirect URI; Django exchanges the code:

~~~text
http://localhost:5173/api/mail/oauth/outlook/callback/
~~~

Delegated Microsoft Graph permissions: **User.Read, Mail.ReadWrite, Mail.Send**. The request also includes offline_access. Organization consent depends on tenant policy.

Set the client secret's value:

~~~dotenv
MAIL_MICROSOFT_CLIENT_ID=YOUR_APPLICATION_CLIENT_ID
MAIL_MICROSOFT_CLIENT_SECRET=YOUR_CLIENT_SECRET_VALUE
MAIL_MICROSOFT_TENANT=common
~~~

A tenant UUID, organizations or consumers is also supported. Recreate the API and select Connect Outlook. The adapter uses Graph v1.0 /me routes, native drafts and native reply/reply-all/forward draft creation.

## After environment changes

~~~powershell
docker compose up -d --force-recreate api
~~~

After source/dependency changes:

~~~powershell
docker compose up --build -d api frontend
~~~

Connection buttons require configured credentials, encryption key and a verified TeamWorkspace address. Disconnect removes this app's stored credentials; provider consent can also be revoked in Google/Microsoft account settings. Disconnecting a local mailbox deletes its local messages.

## VS Code editing

Use Docker on the Windows device where Application Control blocked Rollup. frontend/.dockerignore excludes Windows node_modules from the Linux image. Merge docker-compose.override.example.yml into your existing override file for live source mounts and polling, then rebuild.

## Tests

~~~powershell
docker compose exec api python manage.py test workspace mailbox_app --settings=config.test_settings --verbosity 2
docker compose exec frontend npm run test:mail
docker compose exec frontend npm run build
~~~

The test settings use isolated SQLite, an in-memory channel layer and a test-only fast password hasher. Normal startup uses your configured MySQL/Redis. Validate against your MySQL test schema before deployment.

## Integration reference

The mail module is registered in INSTALLED_APPS and api/mail/. EmailPanel receives the active company and current user from App.tsx. Provider settings use MAIL_* environment variables; request size is limited to 16 MB.

Preserve the explicit Redis channel-layer configuration: address=REDIS_URL, socket_timeout=None, socket_connect_timeout=5.

## Scope and limits

Core Outlook-style mail workflows are implemented. Reading/composition are text based. Rich HTML editing, rules, categories, signatures, shared mailbox administration, offline sync, contacts and calendar are separate work.

Uploads: 5 MB/file, 10 MB combined, 20 files. Downloads: 10 MB. Outlook uses an upload session for 3–5 MB files. Unsupported or larger provider attachments can be opened in the provider mailbox.

The active folder refreshes when opened, manually and every minute while visible and the composer is closed. Background full-mailbox sync/push webhooks are not included. Graph search works in regular folders; its Starred/search combination reports an unsupported request.

Provider send success means acceptance rather than confirmed recipient delivery. An uncertain response blocks automatic resend; check provider Sent/Drafts before intentionally sending another copy.

## Official references

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/workspace/gmail/api/auth/scopes
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts
- https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- https://learn.microsoft.com/en-us/graph/api/resources/message
- https://learn.microsoft.com/en-us/graph/outlook-large-attachments
- https://github.com/redis/redis-py/issues/4091
