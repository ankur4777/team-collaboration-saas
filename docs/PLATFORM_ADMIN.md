# Platform administrator console
The provider dashboard is a separate surface from customer workspaces. Only active Django superusers with staff access can use its API and UI. Company owners and workspace admins do not get provider privileges.

## Local setup
```powershell
git pull origin main
docker compose up -d --build
docker compose exec api python manage.py migrate
docker compose exec api python manage.py createsuperuser
```
Open http://localhost:5173/platform-admin and sign in using the superuser you created. Do not give these credentials to customers.

## Company onboarding
Add a company, enter the owner's email, record the plan, allocated modules, seats and dates. The API creates a workspace and emails an expiring, one-use owner invitation. The customer sets their own password (or signs in with their existing invited account). Configure SMTP and FRONTEND_ORIGIN for your deployed frontend before onboarding real clients. Delivery failures are shown; the invitation can be resent without recreating the company. Already registered companies are visible as unassigned until a license record is configured.

## Scope
This release stores commercial metadata, including calculated expiry status, and an audit history of administrative changes. It does not yet enforce licenses, seats, module restrictions, payment processing or automated expiry suspension. Existing companies continue to work unchanged. No tenant chat/email/file content is exposed by provider endpoints, and the provider is not automatically made a member of newly created companies. Production deployment should use HTTPS, restricted admin access, MFA and tested backups.

Run the backend tests with docker compose exec api python manage.py test workspace.tests.test_platform_admin --verbosity 2. Check that ordinary employees and company admins cannot access the platform API, create a test company, accept the owner invite, change license details, verify audit records and sign out.
