# TeamWorkspace development roadmap

## Milestone delivered: foundational code (Phase 0 / Phase 1 slice)

| Work item | Status |
|---|---|
| React + TypeScript app shell | Implemented in source |
| Django REST + MySQL models and initial migration | Implemented in source |
| Docker Compose: MySQL / Redis / API / frontend | Implemented in source |
| Register company and first owner | Implemented in source |
| Password login/logout and sessions | Implemented in source |
| Switch between companies | Implemented in source |
| Invite employee and accept token | Implemented in source |
| Company roles owner/admin/member | Implemented in source |
| Create teams, channels, membership | Implemented in source |
| Post/read channel messages | Implemented in source |
| Receive new messages via Redis/WebSockets | Implemented in source |
| Django API tests for authorization and isolation | Written, execution pending dependency installation |
| Verify first Docker startup with real MySQL | Not run in generation environment |

## Phase 1 — Finish authentication + access controls

1. Verify migrations on real MySQL and all integration tests in Docker.
2. Add verified-email onboarding, password reset and change-password flows.
3. Add organization-member disable/remove, role changes, owner transfer and offboarding.
4. Add organization settings, audit log, invite resend/revoke and tenant-specific quotas.
5. Add distributed Redis authentication throttles and device/session management.
6. Add MFA and SSO groundwork for later enterprise plans.

**Acceptance:** Company A cannot query, mutate or subscribe to Company B resources; a removed member immediately loses data and WebSocket access; CSRF and permission tests pass.

## Phase 2 implementation update

- Implemented: one-to-one private chats, company-scoped group chats, authenticated REST history/send APIs, member-scoped WebSockets, React chat view and message flow.
- Implemented: removal of chat participation during employee offboarding; fresh direct conversation on future re-invite.
- Still planned: managing group membership after creation, unread/read receipts, typing indicators, notifications, attachments, search, retention and file previews.

## Phase 2 — Real-time communication

1. Complete channel message pagination, message edit/delete, read receipts and mention notifications.
2. Build one-to-one and group conversations with membership controls and mute/unread states.
3. Add file attachments, content validation, antivirus scanning and private object storage.
4. Add typing and online status with Redis TTL, reconnection and backpressure.
5. Add message search, retention policies and export permissions.

**Acceptance:** Multiple simultaneous users can exchange messages securely without cross-tenant leakage, including reconnection cases.

## Phase 3 — Gmail + Outlook mailbox integration

1. Register separate provider OAuth applications, review scope requirements and callback security.
2. Connect accounts with OAuth Authorization Code + PKCE, state/nonce checks, encrypted tokens and refresh handling.
3. Implement account listing, inbox/search/thread views and attachment download controls.
4. Implement compose, drafts, send, reply, reply-all and forward using **each user's delegated mailbox**, not an admin-wide service mailbox.
5. Add idempotent send requests with a sent-state reconciliation workflow to prevent accidental duplicate email after uncertain provider responses.
6. Implement incremental sync: Gmail history/watch notifications; Graph delta queries/change notifications; token expiry and reconnect UX.
7. Complete Google restricted-scope verification/security assessment requirements and Microsoft's app/admin consent review before external launch.

**Acceptance:** Each user sees only their delegated inbox, can revoke access, and receives accurate synchronized conversation state without silently duplicated sends.

## Phase 4 — Meetings and calendar

1. Integrate LiveKit for access-controlled rooms, participant tokens, screen share and device tests.
2. Introduce meeting scheduling and invitations, including external calendar connections where authorized.
3. Add attendance, notifications and meeting links; optional recording only with consent and retention.

## Phase 5 — Productivity and administration

1. File library and permissions, task boards, assignments, deadlines and reminders.
2. Usage analytics, organization settings, search, notifications and export/retention settings.
3. Billing subscriptions, plan limits, upgrade and self-service admin functionality.

## Phase 6 — Production launch

1. CI/CD, tests, monitoring, backups/restores, availability and load testing.
2. HTTPS, security headers, secrets, multi-instance workers, Redis persistence and production hosting.
3. Pilot with multiple independent companies; penetration test tenant isolation and email permissions.
4. Publish privacy policy, terms, data retention/deletion processes and support runbooks.

## High-priority next task

**Validate the chat migration and browser-to-browser real-time messaging in Docker;** then add group participant management, notifications and verified-email/account recovery. Do not begin unrestricted mailbox integration before isolation and authentication tests are green.
