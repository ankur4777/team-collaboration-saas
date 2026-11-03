# Implementation architecture — first milestone

- **Identity:** Each global user has one email identity. A user has zero or more `OrganizationMember` records; workspaces are selected via server session `active_organization_id`.
- **SaaS isolation:** `Organization` owns teams; `Team` owns channels; `Channel` owns messages. All messages require active org + organization membership + team membership. Neither browsing company-wide users nor being a platform staff user bypasses channel authorization.
- **Role model:** Organization `owner` / `admin` / `member`; team `owner` / `member`. Company admins may invite employees; team owners manage team channels and membership. Admins still need team membership to see its channels.
- **Real-time:** Django saves the message first, then broadcasts its serialized representation to a Redis-backed Channels group. WebSockets accept only authenticated, allowed members; clients cannot write chat data directly through the socket.
- **Login:** First-party browser session cookie (HttpOnly), Django CSRF cookie and `X-CSRFToken` header on state-changing requests. Only whitelisted same-origin proxy paths are reachable from React. CSRF rotates after login.
- **Invitations:** Random token with SHA-256 digest stored server-side, seven-day expiry, single-use transaction. New recipients set a password, and existing users sign in first. Debug mode may return the development invite URL; production does not.
- **Email roadmap:** Provider OAuth per-user delegated scopes, encrypted provider tokens, sync cursors and webhooks; no mailbox content is shared with an organization administrator by default.
- **File roadmap:** S3-style private objects with tenant prefix, DB authorization, pre-signed URLs, scans, quotas and expiry.
- **Scale roadmap:** Nginx TLS reverse proxy, static frontend, dedicated ASGI workers, queue workers, managed MySQL + Redis, metrics, structured logs and backup verification.

## Boundary rules for developers

1. Accept no arbitrary `organization_id` from a chat request; derive active organization from validated session membership.
2. Check team membership *in addition* to organization membership before reading or writing messages.
3. Avoid publishing mailbox message content into company chat or company-wide search without a user's deliberate action.
4. Store provider credentials encrypted; separate access/revocation scopes per user and per organization.
5. Never trust frontend visibility checks as authorization. Repeat all checks in backend APIs and WebSockets.
