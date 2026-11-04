# TeamWorkspace — Multi-company collaboration SaaS

**Development milestone:** Starter implementation, Phase 0 + first part of Phases 1–2.

This is a runnable **React + TypeScript frontend** and **Python Django + Django REST Framework backend** with a **MySQL** data model, **Redis + Django Channels** real-time channel feed, and organization-scoped REST API. Laravel is **not** used.

## Implemented now

- Company/workspace registration creates an organization and owner account.
- Email + password login, CSRF-protected session authentication, logout and active workspace switching.
- Signed-in employees can change their password after entering the current password, preserving the current session while invalidating other old-password sessions.
- New accounts receive a signed, expiring email-verification link; existing accounts are marked verified during migration 0007 to preserve access. Invitation redemption verifies its invited address.
- Request a password reset without revealing whether an account exists; use an expiring, single-use reset link to choose a new password.
- Company membership roles: **owner**, **admin**, and **member**.
- Employee invitations: hashed, expiring single-use links; email content goes to backend logs during local development.
- Organization member listing, role updates (owner only), and removal with cross-tenant restrictions; administrators can remove regular members.
- Workspace administrators may invite regular members; only the owner may invite or promote another administrator. Team owners must transfer team ownership before being removed from a workspace.
- Create teams and `General` channels. Team owners can add channels and existing company employees to a team.
- Post/read channel messages with membership checks; real-time WebSocket notification of new messages.
- Start one-to-one chats or private group chats with employees in the active workspace; receive messages live through membership-scoped WebSockets.
- Edit or delete your own private chat messages (deletions replace content with a tombstone); real-time updates reach authorized participants.
- Group creators can add and remove employees; newly added participants only see messages sent after they joined the group.
- Private/group chats show unread message counts and participant read receipts; read position advances only when the browser submits an explicitly viewed message.
- Live typing indicators use authenticated, rate-limited WebSocket signals; the workspace bell shows unread-chat notifications, refreshed periodically (approximately 20 seconds).
- Team channels now have independent per-member unread badges and explicit read cursors, scoped to current team and organization membership.
- The notification bell includes unread team channels alongside private/group chats; clicking a channel notice opens the appropriate team and channel.
- A real Settings page lets employees choose direct-chat, group-chat and channel alert visibility separately for each organization. Muting a bell category does not erase unread counts or disable messaging.
- Removing a workspace member revokes their chat participation; if re-invited later, they start a new direct conversation rather than regaining previous private history.
- Responsive React screens for registration, login, workspace, team navigation, channels, messages, member management, and invitations.
- First automated Django API tests for registration/CSRF/logout, invitations, and cross-company isolation.

**Not yet implemented:** Gmail/Outlook OAuth and synchronized inbox, chat attachments, calendar, meetings, files, tasks, MFA, payments, audit trails, distributed login throttling, mandatory verification enforcement, password change while signed in, notification preferences and advanced admin workflows. Sidebar items for later phases are intentionally marked as coming soon.

## Requirements

- Docker Desktop with Docker Compose (recommended, including Windows 10 with WSL2)
- A working internet connection when Docker builds dependencies the first time
- Browser: Chrome/Edge/Firefox

## Start locally (Windows PowerShell)

```powershell
# Unzip this project and open the extracted folder.
cd team-collaboration-saas
Copy-Item .env.example .env
# Edit .env to replace sample development passwords and DJANGO_SECRET_KEY.
docker compose up --build -d
# Optionally observe backend startup and invitation emails:
docker compose logs -f api
```

Open **http://localhost:5173**. Select **Create workspace**, enter your name, email, organization name and password. Sign in as owner, create a team and invite another member.

The backend health check is **http://localhost:8000/api/health/**.

**Check tests and migrations:**

```powershell
docker compose exec api python manage.py test workspace --verbosity 2
docker compose exec api python manage.py makemigrations --check --dry-run
docker compose exec api python manage.py createsuperuser
```

Stop: `docker compose down`. This preserves the MySQL volume. **Be careful:** `docker compose down -v` deletes the development database volume.

## Fix local MySQL test database permissions (one time)

The normal application MySQL account is intentionally limited to the `teamworkspace` database. Django's test runner creates **another** database, `test_teamworkspace`, which needs its own permissions. If you see:

```
Access denied for user 'teamworkspace'@'%' to database 'test_teamworkspace'
```

grant permissions **only on the test database**. You do **not** need to reset Docker or delete the main database.

In the project directory, start a shell in the MySQL container:

```powershell
docker compose exec mysql sh
```

Inside the container's shell (not PowerShell), start MySQL as root using the container's existing root password:

```sh
MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot
```

At the `mysql>` prompt, run the following SQL. The backslash escapes the underscore so the grant matches the literal test schema rather than a wildcard pattern:

```sql
GRANT ALL PRIVILEGES ON `test\_teamworkspace`.* TO 'teamworkspace'@'%';
SHOW GRANTS FOR 'teamworkspace'@'%';
EXIT;
```

Back at the container shell, type `exit` to return to PowerShell. Then run:

```powershell
docker compose exec api python manage.py test workspace --verbosity 2
```

This grant only allows the existing application user to create and remove its isolated test schema; it does **not** grant global MySQL access. For a custom `MYSQL_USER` or `MYSQL_DATABASE`, adjust the account and test-schema names accordingly. This fix persists in the existing MySQL Docker volume.

## New chat migration and local verification

After pulling new chat or channel unread functionality, rebuild the backend to copy the migration into its image:

```powershell
git pull origin main
docker compose up --build -d api frontend
docker compose exec api python manage.py migrate
docker compose exec api python manage.py makemigrations --check --dry-run
```

Use the **Chats & Groups** sidebar item to start a direct chat or create a group with at least two other employees. Existing workspaces and messages are preserved. If the local test account has permission on `test_teamworkspace`, run `docker compose exec api python manage.py test workspace`.

## Channel unread upgrade notes

Migration `0006_channel_read_cursors` records each team member's join date and adds a per-user channel read cursor. Existing team memberships had no join timestamp: their date is initialized to the time the migration is applied, so old messages are not incorrectly marked unread on upgrade. Existing messages remain in the database.

Channel unread counts exclude a user's own messages and messages before joining a team. The browser marks a channel read only after it has loaded a displayed message. Channel notifications currently refresh about every 20 seconds; live delivery continues for an open channel over WebSockets. System alerts, desktop pushes and notification preferences are future enhancements.

## Email verification and password recovery

New registrations send a verification email. In local development, the configured console mail backend prints the complete message (including the one-time link) to:

```powershell
docker compose logs api --tail=100
```

If an account is unverified, sign in and use the **Resend verification** banner. Visit the email link, click **Verify email**, and return to the workspace. For forgotten passwords, use **Forgot password?** from sign in; the reset link opens a form to enter a replacement password. Reset emails expire in 1 hour; verification emails expire in 24 hours. Password resets invalidate existing authenticated sessions because Django binds sessions to the password hash.

**Upgrade:** Rebuild `api` and `frontend` and apply `workspace.0007_user_email_verified_at`. To prevent accidental lockout, accounts created before this migration are marked verified. New accounts start unverified. **Current policy:** unverified accounts can still access the workspace; a banner encourages verification, and mandatory verification for external mailbox connections remains a planned security gate.

Production requires real SMTP or an approved transactional email provider, HTTPS `FRONTEND_ORIGIN`, an external/shared authentication rate-limit cache, valid SPF/DKIM/DMARC, and proper monitoring of email failures. The local console mail backend is for development only. Secret keys and SMTP passwords belong in server secrets/`.env`, never in Git.

## Settings, notifications and account security

Use **Settings** in the left sidebar. Under **In-app notifications**, toggle direct messages, group chats and team channels, then save. Preferences are separate for each company membership and only affect the notification bell; unread message badges and messages remain available. Notification refresh currently runs approximately every 20 seconds.

Under **Account security**, check your verified email status and change your password by entering your current password and a new password. The current browser remains signed in; sessions authenticated with the old password are invalidated. Use **Forgot password** on the sign-in screen if you don't know your existing password.

The update includes migration `0008_notification_preferences`. Run `git pull origin main`, rebuild `api` and `frontend`, and apply `python manage.py migrate` using Docker Compose. Existing users, messages, workspaces and notification counts are preserved.

This is not a full notification-delivery service: desktop push, sound alerts, email digests, session management and MFA are still planned.

## Run without Docker (advanced)

Run MySQL 8.4 and Redis first; create a MySQL database and user. Create `.env`, change `MYSQL_HOST=127.0.0.1`, `REDIS_URL=redis://127.0.0.1:6379/0`.

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\Activate.ps1
# Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver 8000
```

In a second terminal:

```bash
cd frontend
npm install
# When not inside Docker, point the Vite proxy at the local API.
# PowerShell: $env:API_PROXY_TARGET="http://127.0.0.1:8000"
# bash: export API_PROXY_TARGET=http://127.0.0.1:8000
npm run dev
```

For WebSocket support, the backend must use ASGI (Daphne is installed and exposes the ASGI application). Run `daphne -b 0.0.0.0 -p 8000 config.asgi:application` instead of the standard development server if websocket updates are unavailable.

## API routes (implemented)

| Method | Endpoint | Usage |
|---|---|---|
| GET | `/api/auth/csrf/` | Get browser CSRF token |
| POST | `/api/auth/register/` | Create account + organization |
| POST | `/api/auth/login/` | Session login |
| POST | `/api/auth/logout/` | Session logout |
| GET | `/api/auth/me/` | Logged-in user and memberships |
| POST | `/api/auth/password-change/` | Verify current password, update password and preserve current session |
| GET/PATCH | `/api/notification-preferences/` | Active company's personal in-app alert preferences |
| POST | `/api/auth/verify-email/` | Confirm one-time signed verification token (24-hour expiry) |
| POST | `/api/auth/verify-email/resend/` | Signed-in user: resend verification email (rate-limited) |
| POST | `/api/auth/password-reset/request/` | Request reset link with non-enumerating response |
| POST | `/api/auth/password-reset/confirm/` | Set new password using expiring reset token |
| POST | `/api/organizations/{id}/activate/` | Select active company membership |
| GET | `/api/organizations/{id}/members/` | List active company's members |
| PATCH | `/api/organizations/{id}/members/{member_id}/` | Owner: promote/demote member (admin/member) |
| DELETE | `/api/organizations/{id}/members/{member_id}/` | Owner/admin: revoke workspace access (role limited) |
| POST | `/api/organizations/{id}/invitations/` | Invite company employee (admin/owner) |
| GET | `/api/invitations/{token}/` | Preview an invitation |
| POST | `/api/invitations/{token}/accept/` | Join company; existing accounts must log in |
| GET/POST | `/api/chats/` | List participating chats / create direct or group chat |
| GET/POST | `/api/chats/{id}/messages/` | Read latest 50 / send private message |
| PATCH/DELETE | `/api/chats/{id}/messages/{message_id}/` | Author edits or soft-deletes own message |
| POST | `/api/chats/{id}/read/` | Mark an explicitly displayed message as read; broadcasts receipt |
| POST | `/api/chats/{id}/participants/` | Group creator adds a workspace member |
| DELETE | `/api/chats/{id}/participants/{user_id}/` | Group creator removes a group member |
| WS | `/ws/chats/{id}/` | Receive chat messages (members only) |
| GET/POST | `/api/teams/` | List joined teams / create a team |
| GET/POST | `/api/teams/{id}/channels/` | List channels / create channel (owner) |
| GET/POST | `/api/teams/{id}/members/` | List / add existing company teammate (owner) |
| GET/POST | `/api/channels/{id}/messages/` | Read latest 50 / send message |
| GET | `/api/channel-notifications/` | List accessible team channels with unread counts |
| POST | `/api/channels/{id}/read/` | Advance cursor to a displayed channel message |
| WS | `/ws/channels/{id}/` | Receive new messages (member-only) |

JSON writes use `X-CSRFToken` with a first-party session cookie and the same-origin Vite proxy. Passwords are never returned by an API. Invitations save a SHA-256 hash, not the plaintext invite token. Team and channel membership are checked on each protected request and before every WebSocket delivery.

## Architecture

```text
Web browser (React SPA)
  ├─ /api/*  -> Vite proxy -> Django REST / sessions / CSRF
  └─ /ws/*   -> Vite proxy -> Django Channels WebSocket
                             ├─ MySQL (users, organizations, teams, channels, private chats, messages)
                             ├─ Redis (WebSocket event fanout)
                             └─ console email (dev only)
```

MySQL uses a **shared database, tenant-scoped foreign-key records**. Users can belong to multiple organizations. For MVP only the team-joined channel history is visible.

## Security and release checklist

This is a **development starter, not a production-ready secure messaging or email product**. Before exposing it to the public:

- Set strong `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=false`, HTTPS reverse proxy, strict allowed hosts/origins, and secure cookie/HSTS settings.
- Replace console email with a verified SMTP/transactional sender; add verified-email enrollment, password reset, MFA and session/device management.
- Configure distributed Redis login/signup throttling, IP reputation, abuse controls, structured audit logging and alerts.
- Add organization membership lifecycle (revoke/leave/role changes, owner transfer) and close revoked WebSocket sessions.
- Create private-file scanning, backups and automated restore tests, observability and CI integration tests.
- Perform penetration testing and rigorous cross-tenant test coverage before introducing other company customers.
- Connect Gmail and Outlook only with narrow **delegated OAuth** scopes, encrypted token storage and provider review/verification.
- Use a real production frontend build served behind HTTPS/Nginx rather than the Vite development server.

## Next milestones

See [docs/ROADMAP.md](docs/ROADMAP.md) for the phase-by-phase implementation plan and the first development backlog.

## GitHub

A dedicated repository was not specified for this project, so this archive does **not** modify any existing repositories. To push into a newly created private GitHub repository:

```bash
git init
git add .
git commit -m "Initial TeamWorkspace Django React multi-tenant starter"
git branch -M main
git remote add origin https://github.com/<your-account>/<new-private-repository>.git
git push -u origin main
```

Do not push the `.env` file or reuse the unrelated LMS repository.
