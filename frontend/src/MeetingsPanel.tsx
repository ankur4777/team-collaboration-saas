import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  ChevronRight,
  Clock,
  Plus,
  RefreshCw,
  Users,
  Video,
  X,
} from 'lucide-react';
import {
  api,
  meetingsApi,
  type MeetingRecord,
  type MeetingPayload,
  type Member,
  type Team,
  type Channel,
} from './api';
import './MeetingsPanel.css';
import CallRoom from './CallRoom';
import WorkspaceCalendar, {
  calendarRange,
  type CalendarMode,
} from './WorkspaceCalendar';

type Props = {
  workspaceId: string | null;
  userId: string;
  members: Member[];
  teams: Team[];
  calendar?: boolean;
  requestedMeeting?: { id: string; nonce: number } | null;
  onChanged: () => void;
};
type Tab = 'Today' | 'Upcoming' | 'Past' | 'Cancelled';
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : 'Could not complete the meeting request.';
function localInput(value: Date) {
  const d = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
function dayKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dayStart(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function plusDays(d: Date, n: number) {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}
function when(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function MeetingEditor({
  meeting,
  now,
  initialStart,
  teams,
  members,
  userId,
  onClose,
  onSave,
}: {
  meeting: MeetingRecord | null;
  now: boolean;
  initialStart?: Date;
  teams: Team[];
  members: Member[];
  userId: string;
  onClose: () => void;
  onSave: (data: MeetingPayload) => Promise<void>;
}) {
  const start = initialStart ? new Date(initialStart) : new Date();
  start.setSeconds(0, 0);
  if (!now && !initialStart) start.setMinutes(start.getMinutes() + 30);
  const [title, setTitle] = useState(meeting?.title || '');
  const [agenda, setAgenda] = useState(meeting?.agenda || '');
  const [starts, setStarts] = useState(
    localInput(meeting ? new Date(meeting.starts_at) : start),
  );
  const [ends, setEnds] = useState(
    localInput(
      meeting
        ? new Date(meeting.ends_at)
        : new Date(start.getTime() + 30 * 60000),
    ),
  );
  const [notes, setNotes] = useState(meeting?.notes || '');
  const [teamId, setTeamId] = useState(meeting?.channel?.team_id || '');
  const [channelId, setChannelId] = useState(meeting?.channel?.id || '');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [teamUsers, setTeamUsers] = useState<string[] | null>(null);
  const [attendees, setAttendees] = useState<string[]>(
    meeting?.attendees.map((a) => a.user.id) || [],
  );
  const [inviteChannel, setInviteChannel] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [teamLoading, setTeamLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);
  useEffect(() => {
    if (!teamId) {
      setChannels([]);
      setTeamUsers(null);
      setTeamLoading(false);
      return;
    }
    let active = true;
    setTeamLoading(true);
    setTeamUsers(null);
    Promise.all([api.channels(teamId), api.teamMembers(teamId)])
      .then(([c, m]) => {
        if (active) {
          setChannels(c.filter(row=>!row.is_private));
          setTeamUsers(m.map((v) => v.user.id));
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setTeamLoading(false);
      });
    return () => {
      active = false;
    };
  }, [teamId]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const a = new Date(starts),
      b = new Date(ends);
    if (
      !Number.isFinite(a.getTime()) ||
      !Number.isFinite(b.getTime()) ||
      b <= a ||
      localInput(a) !== starts ||
      localInput(b) !== ends
    ) {
      setError('Choose valid local times, with the end after the start.');
      return;
    }
    setBusy(true);
    try {
      await onSave({
        title,
        agenda,
        starts_at: a.toISOString(),
        ends_at: b.toISOString(),
        time_zone: zone(),
        attendee_ids: attendees.filter(
          (id) => !channelId || teamUsers?.includes(id),
        ),
        channel_id: channelId || null,
        invite_channel: inviteChannel && Boolean(channelId),
        notes,
        revision: meeting?.revision,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function trap(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      onClose();
    }
    if (e.key !== 'Tab') return;
    const all = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled])',
      ) || [],
    );
    const first = all[0],
      last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
  const candidates = members.filter(
    (m) =>
      m.user.id !== userId &&
      (!channelId || teamUsers?.includes(m.user.id)) &&
      (m.user.full_name + ' ' + m.user.email)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="meeting-shade">
      <div
        ref={ref}
        className="meeting-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meeting-form-title"
        onKeyDown={trap}
      >
        <header>
          <div>
            <span className="eyebrow">TEAMWORKSPACE MEETINGS</span>
            <h2 id="meeting-form-title">
              {meeting ? 'Edit meeting' : now ? 'Meet now' : 'Schedule meeting'}
            </h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close meeting form"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <form onSubmit={(e) => void submit(e)}>
          <fieldset disabled={busy}>
            <label>
              Meeting title
              <input
                required
                maxLength={180}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Weekly project review"
              />
            </label>
            <div className="meeting-form-grid">
              <label>
                Starts
                <input
                  type="datetime-local"
                  required
                  value={starts}
                  onChange={(e) => setStarts(e.target.value)}
                />
              </label>
              <label>
                Ends
                <input
                  type="datetime-local"
                  required
                  value={ends}
                  onChange={(e) => setEnds(e.target.value)}
                />
              </label>
            </div>
            <p className="meeting-hint">
              <Clock size={14} />
              Times use your browser time zone: {zone()}.
            </p>
            <p className="meeting-hint">
              <Video size={14} />
              Voice and video happen directly inside TeamWorkspace. A call room
              is created automatically.
            </p>
            <label>
              Agenda
              <textarea
                maxLength={10000}
                rows={3}
                value={agenda}
                onChange={(e) => setAgenda(e.target.value)}
                placeholder="What will you discuss?"
              />
            </label>
            <div className="meeting-form-grid">
              <label>
                Team (optional)
                <select
                  value={teamId}
                  onChange={(e) => {
                    setTeamId(e.target.value);
                    setChannelId('');
                    setInviteChannel(false);
                  }}
                >
                  <option value="">Workspace meeting</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Channel
                <select
                  disabled={!teamId || teamLoading}
                  value={channelId}
                  onChange={(e) => {
                    setChannelId(e.target.value);
                    setInviteChannel(false);
                  }}
                >
                  <option value="">No channel</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {channelId && (
              <label className="meeting-check">
                <input
                  type="checkbox"
                  checked={inviteChannel}
                  onChange={(e) => setInviteChannel(e.target.checked)}
                />
                Invite all current members of this channel’s team
              </label>
            )}
            <label>
              Invite teammates
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search workspace members"
              />
            </label>
            <div className="meeting-member-options">
              {candidates.map((m) => (
                <label className="meeting-check" key={m.id}>
                  <input
                    type="checkbox"
                    disabled={inviteChannel}
                    checked={inviteChannel || attendees.includes(m.user.id)}
                    onChange={(e) =>
                      setAttendees((v) =>
                        e.target.checked
                          ? [...v, m.user.id]
                          : v.filter((id) => id !== m.user.id),
                      )
                    }
                  />
                  <span>
                    {m.user.full_name}
                    <small>{m.user.email}</small>
                  </span>
                </label>
              ))}
              {!candidates.length && (
                <p className="meeting-hint">
                  No matching teammates. You are automatically included as
                  organizer.
                </p>
              )}
            </div>
            {meeting && (
              <label>
                Meeting notes
                <textarea
                  rows={4}
                  maxLength={20000}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
            )}
          </fieldset>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <footer>
            <button
              className="outline-button"
              type="button"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={
                busy || teamLoading || Boolean(channelId && teamUsers === null)
              }
            >
              {busy ? 'Saving…' : meeting ? 'Save changes' : 'Create meeting'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

export default function MeetingsPanel({
  workspaceId,
  userId,
  members,
  teams,
  calendar = false,
  requestedMeeting,
  onChanged,
}: Props) {
  const [tab, setTab] = useState<Tab>('Upcoming');
  const [rows, setRows] = useState<MeetingRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState<MeetingRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<{
    meeting: MeetingRecord | null;
    now: boolean;
    startAt?: Date;
  } | null>(null);
  const [callMeeting, setCallMeeting] = useState<MeetingRecord | null>(null);
  const [query, setQuery] = useState('');
  const [date, setDate] = useState(dayStart(new Date()));
  const [calendarMode, setCalendarMode] = useState<CalendarMode>('Month');
  const [taskTitle, setTaskTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const current = useRef(selectedId);
  current.current = selectedId;
  let from: Date, to: Date;
  if (calendar) {
    const range = calendarRange(date, calendarMode);
    from = range.from;
    to = range.to;
  } else {
    const today = dayStart(new Date());
    if (tab === 'Today') {
      from = today;
      to = plusDays(today, 1);
    } else if (tab === 'Past') {
      from = plusDays(today, -365);
      to = new Date();
    } else if (tab === 'Cancelled') {
      from = plusDays(today, -180);
      to = plusDays(today, 180);
    } else {
      from = new Date();
      to = plusDays(today, 365);
    }
  }
  const fromISO = from.toISOString(),
    toISO = to.toISOString();
  // Stable range keys avoid re-fetching on every state update in Upcoming/Past views.
  const rangeKey = calendar ? `${dayKey(date)}:${calendarMode}` : tab;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    meetingsApi
      .list(fromISO, toISO)
      .then((data) => {
        if (active) {
          setRows(data.results);
          if (data.results.length === data.limit)
            setNotice(
              'Showing the first 500 meetings in this range. Use Calendar to narrow the dates.',
            );
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, rangeKey, version]);
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    let active = true;
    setSelected((existing) => (existing?.id === selectedId ? existing : null));
    meetingsApi
      .detail(selectedId)
      .then((m) => {
        if (active) setSelected(m);
      })
      .catch((e) => {
        if (active) {
          setError(errorText(e));
          setSelectedId('');
        }
      });
    return () => {
      active = false;
    };
  }, [selectedId, version, workspaceId]);
  useEffect(() => {
    if (requestedMeeting) {
      setSelectedId(requestedMeeting.id);
      setVersion((v) => v + 1);
    }
  }, [requestedMeeting?.nonce, workspaceId]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !editor && !busy) setVersion((v) => v + 1);
    }, 20000);
    const focus = () => {
      if (!editor && !busy) setVersion((v) => v + 1);
    };
    window.addEventListener('focus', focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [Boolean(editor), busy]);
  function select(id: string) {
    setSelectedId(id);
    setTaskTitle('');
    setAssignee('');
    setDue('');
    setError('');
    void meetingsApi
      .read(id)
      .then(onChanged)
      .catch(() => {});
  }
  async function mutate(work: () => Promise<MeetingRecord>, message: string) {
    setBusy(true);
    setError('');
    try {
      const row = await work();
      if (current.current === row.id) setSelected(row);
      setNotice(message);
      setVersion((v) => v + 1);
      onChanged();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function deleteMeeting(row: MeetingRecord) {
    if (
      !window.confirm(
        'Delete this meeting for all attendees? This permanently removes its notes and action items.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await meetingsApi.remove(row.id, row.revision);
      setRows((old) => old.filter((m) => m.id !== row.id));
      setSelectedId('');
      setSelected(null);
      setNotice('Meeting deleted.');
      setVersion((v) => v + 1);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const now = Date.now();
  const filtered = rows
    .filter((m) =>
      calendar
        ? !m.cancelled
        : tab === 'Cancelled'
          ? m.cancelled
          : !m.cancelled &&
            (tab === 'Past'
              ? new Date(m.ends_at).getTime() < now
              : tab === 'Upcoming'
                ? new Date(m.ends_at).getTime() >= now
                : true),
    )
    .filter((m) =>
      (m.title + ' ' + m.organizer.full_name)
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  const organizer = selected?.organizer.id === userId;
  const canDelete =
    !!selected &&
    (selected.cancelled ||
      selected.call_ended ||
      new Date(selected.ends_at).getTime() <= now);
  const active =
    selected &&
    !selected.cancelled &&
    !selected.call_ended &&
    new Date(selected.ends_at).getTime() > now;
  return (
    <section className={'meetings-shell' + (calendar ? ' calendar-shell' : '')}>
      {!calendar && (
        <header className="meetings-heading">
          <div>
            <span className="eyebrow">
              YOUR WORKSPACE / {calendar ? 'CALENDAR' : 'MEETINGS'}
            </span>
            <h1>{calendar ? 'Calendar' : 'Meetings'}</h1>
            <p>Plan together. Meet with purpose.</p>
          </div>
          <div className="meeting-heading-actions">
            <button
              className="primary-button"
              onClick={() => setEditor({ meeting: null, now: false })}
            >
              <Plus size={16} />
              Schedule meeting
            </button>
          </div>
        </header>
      )}
      {error && (
        <div className="meeting-feedback error-banner" role="alert">
          {error}
          <button
            className="icon-button"
            aria-label="Dismiss meeting error"
            onClick={() => setError('')}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {notice && (
        <div className="meeting-feedback success-note" role="status">
          {notice}
          <button
            className="icon-button"
            aria-label="Dismiss meeting notice"
            onClick={() => setNotice('')}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {!calendar && (
        <div className="meetings-controls">
          <nav aria-label="Meeting filters">
            {(['Today', 'Upcoming', 'Past', 'Cancelled'] as Tab[]).map((t) => (
              <button
                aria-pressed={tab === t}
                key={t}
                onClick={() => {
                  setTab(t);
                  setSelectedId('');
                }}
              >
                {t}
              </button>
            ))}
          </nav>
          <input
            aria-label="Search meetings"
            placeholder="Search meetings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="icon-button"
            aria-label="Refresh meetings"
            disabled={loading || busy}
            onClick={() => setVersion((v) => v + 1)}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      )}
      <div
        className={
          'meetings-layout' +
          (selectedId ? ' meeting-selected' : '') +
          (calendar ? ' calendar-layout' : '')
        }
      >
        <div
          className="meetings-list"
          aria-label={calendar ? 'Meeting calendar' : 'Meeting list'}
        >
          {loading && rows.length === 0 && !calendar ? (
            <p className="meeting-empty">Loading meetings…</p>
          ) : calendar ? (
            <WorkspaceCalendar
              date={date}
              mode={calendarMode}
              events={filtered}
              selectedId={selectedId}
              userId={userId}
              query={query}
              loading={loading}
              busy={busy}
              onDate={setDate}
              onMode={setCalendarMode}
              onQuery={setQuery}
              onOpen={select}
              onCreate={(startAt) =>
                setEditor({ meeting: null, now: false, startAt })
              }
              onRefresh={() => setVersion((v) => v + 1)}
            />
          ) : filtered.length === 0 ? (
            <div className="meeting-empty">
              <CalendarDays size={34} />
              <h2>
                {query
                  ? 'No matching meetings'
                  : 'No ' + tab.toLowerCase() + ' meetings'}
              </h2>
              <p>Schedule a meeting and invite your teammates.</p>
              <small>
                {tab === 'Past'
                  ? 'Showing the past year.'
                  : tab === 'Cancelled'
                    ? 'Showing six months either side of today.'
                    : tab === 'Upcoming'
                      ? 'Showing the next year.'
                      : ''}
              </small>
            </div>
          ) : (
            filtered.map((m) => (
              <button
                key={m.id}
                disabled={busy}
                className={
                  'meeting-card' + (selectedId === m.id ? ' selected' : '')
                }
                onClick={() => select(m.id)}
              >
                <span className="meeting-date-tile">
                  <b>
                    {new Date(m.starts_at).toLocaleDateString(undefined, {
                      month: 'short',
                    })}
                  </b>
                  {new Date(m.starts_at).getDate()}
                </span>
                <span className="meeting-card-copy">
                  <strong>{m.title}</strong>
                  <small>
                    <Clock size={13} />
                    {when(m.starts_at)} ·{' '}
                    {Math.round(
                      (new Date(m.ends_at).getTime() -
                        new Date(m.starts_at).getTime()) /
                        60000,
                    )}{' '}
                    min
                  </small>
                  <small>
                    {m.channel ? '#' + m.channel.name + ' · ' : ''}
                    {m.organizer.full_name}
                  </small>
                </span>
                <span
                  className={
                    'meeting-status ' +
                    (m.cancelled ? 'cancelled' : m.my_response)
                  }
                >
                  {m.cancelled
                    ? 'Cancelled'
                    : m.my_response === 'pending'
                      ? 'Invited'
                      : m.my_response}
                </span>
              </button>
            ))
          )}
        </div>
        <aside className="meeting-detail" aria-label="Meeting details">
          {selected ? (
            <>
              <button
                className="meeting-back text-link"
                onClick={() => setSelectedId('')}
              >
                <ArrowLeft size={16} />
                {calendar ? 'Back to calendar' : 'Back to meetings'}
              </button>
              <span className="eyebrow">
                {selected.cancelled
                  ? 'CANCELLED'
                  : organizer
                    ? 'YOU ARE THE ORGANIZER'
                    : 'MEETING INVITATION'}
              </span>
              <h2>{selected.title}</h2>
              <p className="meeting-detail-time">
                <Clock size={16} />
                {when(selected.starts_at)} –{' '}
                {new Date(selected.ends_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
              <p className="meeting-hint">
                Displayed in {zone()} · Scheduled in {selected.time_zone}
              </p>
              <p className="meeting-hint">
                Organized by {selected.organizer.full_name}
              </p>
              <div className="meeting-detail-actions">
                {active && !selected.call_ended && (
                  <button
                    className="primary-button"
                    onClick={() => setCallMeeting(selected)}
                  >
                    <Video size={15} />
                    Join meeting
                  </button>
                )}
                {selected.call_ended && (
                  <span className="meeting-hint">This call has ended.</span>
                )}
                <a
                  className="outline-button"
                  href={'/api/meetings/' + selected.id + '/calendar.ics'}
                  download
                >
                  Add to calendar
                </a>
                {organizer && !selected.cancelled && (
                  <>
                    <button
                      className="outline-button"
                      disabled={busy}
                      onClick={() =>
                        setEditor({ meeting: selected, now: false })
                      }
                    >
                      Edit
                    </button>
                  </>
                )}
                {organizer && canDelete && (
                  <button
                    className="meeting-cancel"
                    disabled={busy}
                    onClick={() => void deleteMeeting(selected)}
                  >
                    Delete meeting
                  </button>
                )}
                {organizer && !canDelete && (
                  <button
                    className="meeting-cancel"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          'Cancel this meeting and notify all attendees?',
                        )
                      )
                        void mutate(
                          () =>
                            meetingsApi.cancel(selected.id, selected.revision),
                          'Meeting cancelled.',
                        );
                    }}
                  >
                    Cancel meeting
                  </button>
                )}
              </div>
              {!organizer && active && (
                <div className="meeting-rsvp" aria-label="Meeting response">
                  {(['accepted', 'tentative', 'declined'] as const).map((r) => (
                    <button
                      className={selected.my_response === r ? 'selected' : ''}
                      disabled={busy}
                      aria-pressed={selected.my_response === r}
                      key={r}
                      onClick={() =>
                        void mutate(
                          () => meetingsApi.rsvp(selected.id, r),
                          'Your response was saved.',
                        )
                      }
                    >
                      {r === 'accepted'
                        ? 'Accept'
                        : r === 'tentative'
                          ? 'Tentative'
                          : 'Decline'}
                    </button>
                  ))}
                </div>
              )}
              <h3>Agenda</h3>
              <p className="meeting-prose">
                {selected.agenda || 'No agenda added yet.'}
              </p>
              <h3>
                <Users size={15} />
                Participants ({selected.attendees.length})
              </h3>
              <div className="meeting-attendees">
                {selected.attendees.map((a) => (
                  <div key={a.user.id}>
                    <span>
                      {a.user.full_name}
                      <small>{a.user.email}</small>
                    </span>
                    <b>{a.response === 'pending' ? 'Invited' : a.response}</b>
                  </div>
                ))}
              </div>
              <h3>Meeting notes</h3>
              <p className="meeting-prose">
                {selected.notes ||
                  'No notes yet. The organizer can add decisions and notes using Edit.'}
              </p>
              <h3>Action items</h3>
              <div className="meeting-task-list">
                {selected.action_items.map((t) => (
                  <label className="meeting-check" key={t.id}>
                    <input
                      type="checkbox"
                      checked={t.done}
                      disabled={
                        busy || (!organizer && t.assignee_id !== userId)
                      }
                      onChange={(e) =>
                        void mutate(
                          () =>
                            meetingsApi.completeAction(
                              selected.id,
                              t.id,
                              e.target.checked,
                            ),
                          'Action item updated.',
                        )
                      }
                    />
                    <span className={t.done ? 'done' : ''}>
                      {t.title}
                      <small>
                        {selected.attendees.find(
                          (a) => a.user.id === t.assignee_id,
                        )?.user.full_name || 'Unassigned'}
                        {t.due_date ? ' · Due ' + t.due_date : ''}
                      </small>
                    </span>
                  </label>
                ))}
                {!selected.action_items.length && (
                  <p className="meeting-hint">No action items yet.</p>
                )}
              </div>
              {organizer && (
                <form
                  className="meeting-task-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void mutate(
                      () =>
                        meetingsApi.addAction(selected.id, {
                          title: taskTitle,
                          assignee_id: assignee || null,
                          due_date: due || null,
                        }),
                      'Action item added.',
                    ).then((saved) => {
                      if (saved) setTaskTitle('');
                    });
                  }}
                >
                  <input
                    aria-label="Action item title"
                    disabled={busy}
                    required
                    maxLength={300}
                    placeholder="Add an action item"
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                  />
                  <select
                    aria-label="Action item assignee"
                    disabled={busy}
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {selected.attendees.map((a) => (
                      <option value={a.user.id} key={a.user.id}>
                        {a.user.full_name}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Action item due date"
                    disabled={busy}
                    type="date"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                  />
                  <button
                    className="outline-button"
                    disabled={busy || !taskTitle.trim()}
                  >
                    <Plus size={14} />
                    Add
                  </button>
                </form>
              )}
            </>
          ) : (
            <div className="meeting-empty">
              <Video size={38} />
              <h2>
                {selectedId
                  ? 'Opening meeting…'
                  : 'Your next conversation starts here'}
              </h2>
              <p>
                {selectedId
                  ? 'Loading meeting details.'
                  : 'Select a meeting to see the agenda, participants and notes.'}
              </p>
            </div>
          )}
        </aside>
      </div>
      {editor && (
        <MeetingEditor
          meeting={editor.meeting}
          now={editor.now}
          initialStart={editor.startAt}
          teams={teams}
          members={members}
          userId={userId}
          onClose={() => setEditor(null)}
          onSave={async (data) => {
            const row = editor.meeting
              ? await meetingsApi.update(editor.meeting.id, data)
              : await meetingsApi.create(data);
            setEditor(null);
            if (calendar) setDate(dayStart(new Date(row.starts_at)));
            setSelectedId(row.id);
            setSelected(row);
            setVersion((v) => v + 1);
            setNotice(
              editor.meeting
                ? 'Meeting updated.'
                : 'Meeting created. Invitations are available in Notifications.',
            );
            onChanged();
          }}
        />
      )}
      {callMeeting && (
        <CallRoom
          meeting={callMeeting}
          userId={userId}
          onLeave={() => {
            setCallMeeting(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </section>
  );
}

export function ChannelMeetingCards({
  channelId,
  onOpen,
}: {
  channelId: string;
  onOpen: (id: string) => void;
}) {
  const [rows, setRows] = useState<MeetingRecord[]>([]);
  useEffect(() => {
    let valid = true;
    setRows([]);
    const load = () => {
      const now = new Date();
      void meetingsApi
        .list(now.toISOString(), plusDays(now, 365).toISOString(), channelId)
        .then((data) => {
          if (valid) setRows(data.results.slice(0, 3));
        })
        .catch(() => {
          if (valid) setRows([]);
        });
    };
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 20000);
    return () => {
      valid = false;
      clearInterval(timer);
    };
  }, [channelId]);
  if (!rows.length) return null;
  return (
    <div
      className="channel-meeting-cards"
      aria-label="Upcoming channel meetings"
    >
      {rows.map((row) => (
        <button key={row.id} onClick={() => onOpen(row.id)}>
          <Video size={16} />
          <span>
            <strong>{row.title}</strong>
            <small>{when(row.starts_at)}</small>
          </span>
          <ChevronRight size={16} />
        </button>
      ))}
    </div>
  );
}
