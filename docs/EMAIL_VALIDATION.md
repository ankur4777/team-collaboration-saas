# Validation and remaining checks

Executed: Django checks, migration creation/application to SQLite, existing workspace plus new mail backend tests, React interaction tests in jsdom, TypeScript/production build, against the current source.

The current test results are recorded in the pull request and GitHub Actions.

Backend coverage: local send/receive, Bcc privacy, duplicate send prevention, drafts/files, read/star/move/restore, search/pages, invalid inputs, auth/CSRF, cross-user/company isolation, company switching and offboarding.

OAuth/provider tests mock HTTP calls and check verified-address gating, PKCE, browser-bound single-use state, encrypted tokens, refresh rotation, secret exclusion, MIME/thread headers, signed pages, draft-only deletion and file upload host/token handling.

Frontend coverage: load/read, mark read, compose/save/send, idempotency keys, reply fields, uncertain-send lockout, search, connection states and account switching.

## Pending

- Live Google/Microsoft consent, delivery, provider operations and attachments with real app credentials.
- MySQL/Redis runtime/load validation; automated tests used SQLite and an in-memory channel layer.
- Browser visual/mobile layout validation. Chromium could not start because required socket operations were restricted. React interactions were tested in jsdom.
- Docker build/runtime verification; this environment did not expose Docker.

## Local acceptance

1. Install, rebuild and confirm mailbox_app.0001_initial.
2. Test two local mailboxes in one company: send, replies, forward, drafts/files, Deleted/restore.
3. Verify mailbox isolation across employees and companies.
4. Check desktop/mobile layout, keyboard use and long names.
5. Repeat core workflows with connected Gmail and Outlook, including a 3–5 MB Outlook file.
6. Check lost-response handling in Sent/Drafts before resending.
7. Validate production HTTPS, consent, token-key backup, rate limits and retention.

## Inbox synchronization regression coverage

The first visible page refreshes periodically and on focus/online events, without overlapping background requests or refreshing while composing. Gmail lists tolerate messages and drafts removed between provider list and detail requests. Added mocked regression tests; live Google/Microsoft delivery and webhook/background synchronization still require validation and further development.
