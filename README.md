# TeamWorkspace — Multi-company collaboration SaaS

**Development milestone:** Starter implementation, Phase 0 + first part of Phases 1–2.

This is a runnable **React + TypeScript frontend** and **Python Django + Django REST Framework backend** with a **MySQL** data model, **Redis + Django Channels** real-time channel feed, and organization-scoped REST API. Laravel is **not** used.

## Implemented now

- Company/workspace registration creates an organization and owner account.
- Email + password login, CSRF-protected session authentication, logout and active workspace switching.
- Company membership roles: **owner**, **admin**, and **member**.
- Employee invitations: hashed, expiring single-use links; email content goes to backend logs during local development.
- Organization member listing, role updates (owner only), and removal with cross-tenant restrictions; administrators can remove regular members.
- Workspace administrators may invite regular members; only the owner may invite or promote another administrator. Team owners must transfer team ownership before being removed from a workspace.
- Create teams and `General` channels. Team owners can add channels and existing company employees to a team.
- Post/read channel messages with membership checks; real-time WebSocket notification of new messages.
- Start one-to-one chats or private group chats with employees in the active workspace; receive messages live through membership-scoped WebSockets.
- Edit or delete your own private chat messages (deletions replace content with a tombstone); real-time updates reach authorized participants.
- Group creators can add and remove employees; newly added participants only see messages sent after they joined the group.
- Removing a workspace member revokes their chat participation; if re-invited later, they start a new direct conversation rather than regaining previous private history.
- Responsive React screens for registration, login, workspace, team navigation, channels, messages, member management, and invitations.
- First automated Django API tests for registration/CSRF/logout, invitations, and cross-company isolation.

**Not yet implemented:** Gmail/Outlook OAuth and synchronized inbox, read receipts, chat attachments, calendar, meetings, files, tasks, MFA, email verification, payments, audit trails, full login rate limiting, password reset and advanced admin workflows. Sidebar items for later phases are intentionally marked as coming soon.

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

After pulling a release with private chat support, rebuild the backend to copy the migration into its image:

```powershell
git pull origin main
docker compose up --build -d api frontend
docker compose exec api python manage.py migrate
docker compose exec api python manage.py makemigrations --check --dry-run
```

Use the **Chats & Groups** sidebar item to start a direct chat or create a group with at least two other employees. Existing workspaces and messages are preserved. If the local test account has permission on `test_teamworkspace`, run `docker compose exec api python manage.py test workspace`.

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
| POST | `/api/chats/{id}/participants/` | Group creator adds a workspace member |
| DELETE | `/api/chats/{id}/participants/{user_id}/` | Group creator removes a group member |
| WS | `/ws/chats/{id}/` | Receive chat messages (members only) |
| GET/POST | `/api/teams/` | List joined teams / create a team |
| GET/POST | `/api/teams/{id}/channels/` | List channels / create channel (owner) |
| GET/POST | `/api/teams/{id}/members/` | List / add existing company teammate (owner) |
| GET/POST | `/api/channels/{id}/messages/` | Read latest 50 / send message |
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
