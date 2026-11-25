# Teams, chats and message search: release verification

Run these checks on a test workspace using two separate browser profiles (or two computers connected to the same backend). Do not use production data.

## Setup

```powershell
git pull origin main
docker compose up -d --build
docker compose exec api python manage.py migrate
docker compose exec api python manage.py test workspace --verbosity 2
```

The GitHub Checks workflow also runs migrations consistency checks, Django tests with MySQL/Redis, frontend tests, TypeScript compilation and the existing native-call browser regression.

## Acceptance checks

| Area | Expected behavior |
| --- | --- |
| Team and channels | Create, rename, transfer ownership, archive/restore and leave; a team owner must transfer ownership before leaving. |
| Private channel | Standard team members cannot discover a private channel until invited. Check channel list, search, notification list, forwarding destinations, messages, context, pins, attachments and live events. Remove a member and repeat. Re-add and confirm older history stays hidden. |
| Chat | Direct/group messages, reply, forward text, reactions, edits, deletes and pins work for both browsers. |
| Search | Find an old message beyond the latest page, open the exact result, verify surrounding history and highlight, return to latest. Delete the message and verify the context no longer exposes its text after revalidation. |
| Preferences | Pin/mute a chat or channel, refresh both browsers, confirm only the initiating user has changed settings. Muting suppresses normal unread conversation alerts, but explicit mentions still appear. |
| Reconnection | Disconnect internet in browser A, send messages from B, reconnect A and verify fresh history without duplicates. Load older history to verify messages outside the latest 50. |
| Isolation | Switch to another company; attempt prior company API URLs, search, attachments and forwarding. All must be denied or absent. |
| Layout | Check desktop and narrow/mobile view, particularly toolbar controls and private member management. |

## Scope and limitations

- Private channels are created as private, not converted from existing standard channels. Management requires both current private membership and team manager privileges. Add another eligible manager before the original manager leaves to avoid an unmanaged private channel.
- Private channel-linked meetings are intentionally disabled pending dedicated meeting privacy integration.
- Search navigation shows a focused context of up to ten messages on either side of the target, separate from the live timeline.
- Forwarding supports text only. Presence is heartbeat-based and reconnection initially reloads the latest 50 messages.
- Passing automated checks is not a substitute for executing the two-browser acceptance checks above.
