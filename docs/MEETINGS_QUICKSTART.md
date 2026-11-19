# Meetings and Calendar quickstart

## Update locally

From the repository root:

```powershell
git pull origin main
docker compose up -d --build api frontend
docker compose logs api --tail=40
```

The API startup command applies migration `workspace.0014_meetings` automatically.
For a Python-only development setup, run `python manage.py migrate` before starting
Daphne. Do not delete existing Docker volumes to apply this update.

## Test with two workspace accounts

1. Sign in as employee A. Open Meetings and choose Schedule meeting.
2. Add a title, agenda, start/end times and an existing HTTPS meeting link.
   Date/time inputs use the browser's local time zone, shown on the form.
3. Select employee B from this workspace. Optionally select a team/channel and
   invite all current members of its team. The organizer is always included.
4. Create the meeting. Employee B sees an invitation in the notification bell
   and in Meetings, and can Accept, Tentative or Decline.
5. Open the same meeting in Calendar (day/week/month). Join opens the supplied
   provider link in a new tab. Add to calendar downloads a private `.ics` file.
6. As the organizer, edit/reschedule the meeting or cancel it. Invitations and
   updates appear in the participants' notification bell. Changing time or link
   resets other participants' responses to Invited.
7. Add decisions using Edit -> Meeting notes. Add action items with an assignee
   and optional due date. Only the organizer or assigned attendee can mark an
   item complete; only the organizer adds items.
8. Schedule a meeting starting in ten minutes to test the reminder. An unread
   reminder appears within 15 minutes of its start. Reading the earlier
   invitation does not suppress this later reminder. Declined and cancelled
   meetings do not produce reminders.
9. Check another company/account: uninvited people cannot list/open meetings,
   download their calendar files or change their actions. Removed company/team
   members lose access; rejoining does not restore historical invites unless
   the organizer explicitly invites them again.

## Current behavior and scope

- Meet now opens a scheduling form defaulted to now and a 30-minute duration.
  It still needs an existing call link; TeamWorkspace does not generate video
  rooms or grant access to the provider's room.
- Invitations/reminders are in-app, not outgoing email. Live refresh signals
  use the existing notification WebSocket with polling fallback every 20 seconds.
  Due reminders are computed when the notification API is read, not by a worker;
  a closed application does not deliver desktop/push reminders.
- Meeting lists poll every 20 seconds when visible and not editing. Channel
  conversations show up to three upcoming invited meetings for that channel.
- The organizer can edit/cancel. Administrators do not automatically gain access
  to private meetings. Active workspace membership and, for channel meetings,
  current team membership are rechecked on every request.
- Schedule updates use revision checks (409 on stale edits). All writes use
  session authentication/CSRF. Supplied links are validated as HTTPS and are
  never fetched server-side. Notes/agenda are displayed as plain text.
- Calendar range requests are limited to one year and return up to 500 rows;
  dashboard ranges and truncation are shown in the interface. Unread reminders
  and invitations are capped to 500 candidate meetings per refresh.
- Exporting `.ics` is a one-time calendar import, not two-way Google/Microsoft
  calendar sync. Recurrence, external guests, video hosting, recording and
  automatic provider-room creation are future work.

## Validation

Backend: `python manage.py test workspace mailbox_app` (MySQL in CI).
Local SQLite option: append `--settings=config.test_settings`.
Frontend: `npm run test:mail` and `npm run build` from `frontend/`.
