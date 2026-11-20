# Meetings and Calendar quickstart

## Update locally

From the repository root:

```powershell
git pull origin main
docker compose up -d --build api frontend
docker compose logs api --tail=40
```

The API startup command applies migration including `workspace.0015_native_meeting_calls` automatically.
For a Python-only development setup, run `python manage.py migrate` before starting
Daphne. Do not delete existing Docker volumes to apply this update.

## Test with two workspace accounts

1. Sign in as employee A. Open Meetings and choose Schedule meeting.
2. Add a title, agenda and start/end times. An internal call room is created automatically.
   Date/time inputs use the browser's local time zone, shown on the form.
3. Select employee B from this workspace. Optionally select a team/channel and
   invite all current members of its team. The organizer is always included.
4. Create the meeting. Employee B sees an invitation in the notification bell
   and in Meetings, and can Accept, Tentative or Decline.
5. Open the same meeting in Calendar (day/week/month). Join opens the in-app voice/video room. Choose microphone/camera settings,
   click Join call and allow device access. Add to calendar downloads a private `.ics` file.
6. As the organizer, edit/reschedule the meeting or cancel it. Invitations and
   updates appear in the participants' notification bell. Changing time
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
  Its room supports invited participants using native WebRTC with no fixed application participant cap.
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
  session authentication/CSRF. External call links are no longer accepted.
  Notes/agenda are displayed as plain text.
- Calendar range requests are limited to one year and return up to 500 rows;
  dashboard ranges and truncation are shown in the interface. Unread reminders
  and invitations are capped to 500 candidate meetings per refresh.
- Exporting `.ics` is a one-time calendar import, not two-way Google/Microsoft
  calendar sync. Recurrence, external guests, recording, transcription and
  large-room media servers are future work.

## Validation

Backend: `python manage.py test workspace mailbox_app` (MySQL in CI).
Local SQLite option: append `--settings=config.test_settings`.
Frontend: `npm run test:mail` and `npm run build` from `frontend/`.

## Native voice and video

Join from the meeting details. Mute/unmute, switch the camera off/on, or leave
without ending the room. The organizer can End for everyone. A room closes at
its scheduled end, on cancellation, or when ended by its organizer. One tab per
user per room is supported. Microphone/camera capture starts only after Join call;
leaving stops local device tracks. Audio-only calls are supported.

All participants must use the same deployed TeamWorkspace address. A different
computer's localhost is a separate installation. Production needs HTTPS, browser
device permission and a reachable TURN relay for reliable calls across networks.
Localhost testing can work directly without a relay. No public STUN/TURN service
is configured by default. Configure your own or an authorized service in `.env`:

```dotenv
CALL_STUN_URLS=stun:relay.your-domain.example:3478
CALL_TURN_URLS=turn:relay.your-domain.example:3478?transport=udp,turns:relay.your-domain.example:5349?transport=tcp
CALL_TURN_SHARED_SECRET=your-own-coturn-auth-secret
CALL_ICE_TRANSPORT_POLICY=all
```

For coturn, enable `use-auth-secret` and match `static-auth-secret` with the server
setting above. Configure its public IP, TLS certificate and firewall relay ports
for your deployment. Recreate the API after changing `.env`. The API issues
one-hour HMAC-SHA1 relay credentials to authorized participants; the client
refreshes them every 20 minutes. The shared secret never reaches the browser.
Set policy to `relay` to require relay-only connections (TURN must be configured).

Invited membership, workspace, channel access and device sessions are rechecked
while connected (at most ten seconds after revocation). Presence expires after
90 seconds without a heartbeat. SDP/ICE signaling is authenticated and scoped to
the room; media travels over WebRTC, not through Django. Calls are not recorded.

CI includes two Chromium clients with synthetic audio/video devices, checking
actual remote media tracks, mute, camera-off, leave/rejoin and organizer end.
This does not replace testing your production HTTPS/TURN/firewall configuration.

## Collaboration controls inside a call

- **Present screen:** choose a screen, window or browser tab in the browser picker.
  Presentation replaces your camera video for other participants; the microphone
  continues normally. Stop presenting or use the browser's stop-sharing control to
  restore the camera. Screen audio is not shared. Screen capture requires a
  supported desktop browser and explicit permission each time.
- **Participants:** view everyone currently connected, with microphone/camera,
  raised-hand and presentation indicators. Click a pin to spotlight a person.
- **Raise hand / Lower hand:** updates the other participants and new arrivals.
- **In-call chat:** plain-text messages to everyone connected, including unread
  badges. Messages are not stored, are capped to 200 visible messages per client,
  and are unavailable to new arrivals or after leaving. Limit: 2,000 characters
  per message, five messages per ten seconds. Persistent meeting notes remain in
  the meeting details.
- **Auto / Tiled / Spotlight:** choose your own layout. Auto focuses a presenter;
  pinning affects only your view. Full screen uses the browser's full-screen mode.
- **Meeting details:** copy the internal link. Only invited members can use it;
  copying the link does not grant access.

The room uses TeamWorkspace's inherited DM Sans / Manrope typography, compact
12–13px controls, 18px title, white surfaces and mint/green accents. Video tiles
retain a dark green background for legible participant labels.

Calls have no fixed application participant cap. Recording, breakout rooms,
background effects and large-group SFU hosting are not included in this update.

## Emoji, live captions and speech translation

- **Emoji reactions:** open the smile button and select a reaction. Everyone
  currently connected sees your name and emoji for four seconds. Reactions are
  not stored; the server limits bursts to three reactions per five seconds.
- **Turn on captions:** enables your caption display and opens speech settings.
  It does not automatically activate speech recognition. To share your own words,
  choose **My speaking language → Start my speech captions**. Each speaker must
  opt in separately. Unsupported browsers can still display shared captions.
- Browser speech recognition availability depends on browser, language and its
  recognition service. It may transmit microphone audio to the browser vendor's
  speech service. The disclosure appears before starting. No speech recognition
  service is silently started for teammates. Muting pauses recognition; leaving,
  stopping speech captions or turning captions off aborts it. Unmuting resumes
  only if you previously opted in. Microphone permission and HTTPS/localhost are
  required. Browser speech accuracy and availability are not guaranteed.
- **Translate speech:** translates new, shared caption text into your chosen
  language. It is translated captions, not real-time voice cloning/dubbing.
  **Read translations aloud** optionally reads other speakers' translations using
  your browser's speech synthesis; available voices depend on your device.
  Original text remains visible. Use headphones to avoid feedback.
- Caption text and translation results are not saved by TeamWorkspace. Captions
  expire from the display after 18 seconds, with at most three visible segments.
  Recognition/translation services have their own data handling policies.
  Captions are capped to 500 characters per final segment, 30 segments per minute
  per speaker. Captions cannot be published while the sender is marked muted.

### Configure translation

An administrator must provide a LibreTranslate-compatible service URL in `.env`:

```dotenv
CALL_TRANSLATE_URL=https://your-authorized-service.example/translate
CALL_TRANSLATE_API_KEY=your-server-side-key-if-required
```

You can use an authorized hosted instance or your own self-hosted LibreTranslate
service. No public/free instance is used automatically. The endpoint must include
`/translate`; install/enable the desired language models on that service. The
service may not support every speaking/target language in the selectors. Keys
stay on the API server. Recreate the API after changing these values:

```powershell
docker compose up -d --force-recreate api
```

Translation is available only to currently connected, invited call participants,
with a 60-request/minute per-user limit, bounded text, a four-second timeout and
no redirect following. Only caption text is sent to the configured translation
service, not call audio. If unavailable, original captions remain and the UI
shows an error. An unconfigured translation service is shown as unavailable.

### Validation limits

CI uses deterministic browser recognition results and a test-only translation
HTTP fixture to check real WebSocket caption/reaction transport, muted-word
suppression, the translation adapter and original/translated display. It does not
claim to validate a live vendor speech engine, microphone transcription accuracy,
real translation quality or production credentials. Test those on your deployed
HTTPS site with supported browsers and your configured translation service.

## Immersive meeting room layout

After joining, the room uses a large centered participant tile, a circular initials
avatar when the camera is off, participant name labels and a floating rounded
control dock. TeamWorkspace's fonts and green palette are retained. The old
second-column waiting placeholder is removed; a solo participant uses the main
stage. Existing call, sharing, chat, captions and reaction controls remain. The
avatar uses the participant's initials because profile photos are not currently
part of the account data. Desktop and mobile solo layouts are covered by browser
checks and screenshots.

## Participant capacity

The fixed six-person admission check and separate 200-attendee invitation cap are removed. The header and participant panel
show the actual connected count, without a maximum denominator. Invitations,
workspace/channel checks, one-tab-per-user checks, stale presence cleanup and
message-size/rate limits still apply. The call configuration returns
`max_peers: null` to mean no fixed application admission cap.

This is not unlimited media capacity. The current implementation creates a mesh
of direct peer connections: each browser sends media to every other participant.
CPU, upload bandwidth, browser limits and TURN capacity therefore constrain the
usable room size. Large production meetings need an SFU/media-server architecture
and load testing; simply removing the admission check does not supply that.
Backend tests cover 202 invitees, twelve admissions and eight simultaneous authenticated
signaling sockets. The browser media test covers two clients, not a large-group
performance benchmark.
