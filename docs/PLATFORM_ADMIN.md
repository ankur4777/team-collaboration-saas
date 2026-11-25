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
This release stores commercial metadata, including calculated expiry status, and an audit history of administrative changes. Active/trial licenses are date-checked on every workspace access; expired, scheduled, suspended and cancelled licenses are blocked. Unassigned workspaces remain unrestricted for backward compatibility. Seat limits are enforced when configured. Payment processing is not enabled yet. Module restrictions can be enabled per company. Dates are inclusive and use the server timezone. Existing peer-to-peer media may continue until clients process a signaling disconnect; previously downloaded or cached data cannot be recalled. No tenant chat/email/file content is exposed by provider endpoints, and the provider is not automatically made a member of newly created companies. Production deployment should use HTTPS, restricted admin access, MFA and tested backups.

Run the backend tests with docker compose exec api python manage.py test workspace.tests.test_platform_admin --verbosity 2. Check that ordinary employees and company admins cannot access the platform API, create a test company, accept the owner invite, change license details, verify audit records and sign out.

## Module entitlements
Enable **Enforce module access for this company** in Manage company, then select modules. Existing licenses are unrestricted until this switch is enabled. An empty selection with enforcement enabled grants no product modules; account and membership settings remain accessible. Search, forwarding, attachment downloads and mentions cannot expose disabled chat/channel data. Meetings and Calendar use the same scheduling backend: either enables scheduling, while live calls and caption translation require Meetings. A module change takes effect on subsequent server checks; browser refresh or the 30-second session poll updates navigation. Already downloaded files cannot be recalled.

## Employee seats
A numeric seat limit counts every accepted company membership, including the owner and admins. Blank means unlimited. Sending an invitation requires an available seat; pending invites do not reserve seats, and every redemption checks capacity again under a company row lock before creating an account. When the cap is reached, invitees receive a conflict response and can retry after a seat becomes available (provided the invitation is still valid). Removing a member frees a seat. Lowering a limit below current membership is rejected; no employee is automatically removed. Existing over-limit companies can continue working but cannot admit additional members. This policy applies to normal application onboarding; direct database or Django admin changes must be controlled operationally.

## Subscription countdown
The workspace sidebar and Settings show the current plan, validity dates and remaining time. The countdown uses the server timestamp and the next midnight after the inclusive end date (currently UTC); below 24 hours it displays hours and minutes. Warnings appear within 7 days and 24 hours. Super Admin sees a remaining-time snapshot in the company list. The existing 30-second foreground session refresh updates changes and expiry; server-side access remains authoritative. No email reminders or automatic billing are sent by this feature.

## Subscription renewals
In Super Admin → Companies → Manage → Subscription renewal, choose 30, 90, 365 or custom days. An unexpired dated term is extended from its inclusive end date; expired/undated terms receive a new term beginning today (or a future scheduled start). Renewal activates ordinary/trial licenses; suspended and cancelled companies remain blocked unless the provider explicitly selects reactivation. Plans, seats and modules are preserved. The transaction locks the company and records the previous/new dates and statuses, operator, note and request ID; retries using the same ID cannot extend twice. History is paginated, and administrative activity also records the change. This is manual commercial administration only, not a payment collection or invoice system. Use HTTPS for the browser's secure request-ID generation.
