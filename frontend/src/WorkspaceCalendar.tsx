import { useEffect, useRef, useState } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Menu,
  Plus,
  Printer,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type { MeetingRecord } from './api';
import './WorkspaceCalendar.css';
export type CalendarMode = 'Day' | 'Work week' | 'Week' | 'Month';
const startDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monday = (d: Date) => addDays(startDay(d), -((d.getDay() + 6) % 7));
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();
const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fullDate = (d: Date) =>
  d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
const time = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
export function calendarRange(date: Date, mode: CalendarMode) {
  const from =
    mode === 'Month'
      ? monday(new Date(date.getFullYear(), date.getMonth(), 1))
      : mode === 'Day'
        ? startDay(date)
        : monday(date);
  return {
    from,
    to: addDays(
      from,
      mode === 'Month' ? 42 : mode === 'Day' ? 1 : mode === 'Work week' ? 5 : 7,
    ),
  };
}
function overlaps(m: MeetingRecord, day: Date) {
  return new Date(m.starts_at) < addDays(day, 1) && new Date(m.ends_at) > day;
}
function suggestedStart(day: Date) {
  const now = new Date();
  if (sameDay(day, now))
    return new Date(
      Math.ceil((now.getTime() + 15 * 60000) / (15 * 60000)) * 15 * 60000,
    );
  const next = startDay(day);
  next.setHours(9);
  return next;
}
type Positioned = {
  meeting: MeetingRecord;
  start: number;
  end: number;
  column: number;
  columns: number;
};
export function positionEvents(
  events: MeetingRecord[],
  day: Date,
): Positioned[] {
  const items = events
    .filter((m) => overlaps(m, day))
    .map((meeting) => {
      const a = new Date(meeting.starts_at),
        b = new Date(meeting.ends_at);
      const start = a < day ? 0 : a.getHours() * 60 + a.getMinutes();
      const end =
        b >= addDays(day, 1) ? 1440 : b.getHours() * 60 + b.getMinutes();
      return {
        meeting,
        start,
        end: Math.min(1440, Math.max(start + 30, end)),
        column: 0,
        columns: 1,
      };
    })
    .sort(
      (a, b) =>
        a.start - b.start ||
        a.end - b.end ||
        a.meeting.id.localeCompare(b.meeting.id),
    );
  let cluster: Positioned[] = [],
    ends: number[] = [],
    clusterEnd = -1;
  const finish = () => {
    for (const event of cluster) event.columns = ends.length;
    cluster = [];
    ends = [];
    clusterEnd = -1;
  };
  for (const event of items) {
    if (event.start >= clusterEnd) finish();
    let column = ends.findIndex((end) => end <= event.start);
    if (column === -1) column = ends.length;
    ends[column] = event.end;
    event.column = column;
    cluster.push(event);
    clusterEnd = Math.max(clusterEnd, event.end);
  }
  finish();
  return items;
}
export default function WorkspaceCalendar({
  date,
  mode,
  events,
  selectedId,
  userId,
  query,
  loading,
  busy,
  onDate,
  onMode,
  onQuery,
  onOpen,
  onCreate,
  onRefresh,
}: {
  date: Date;
  mode: CalendarMode;
  events: MeetingRecord[];
  selectedId: string;
  userId: string;
  query: string;
  loading: boolean;
  busy: boolean;
  onDate: (d: Date) => void;
  onMode: (m: CalendarMode) => void;
  onQuery: (s: string) => void;
  onOpen: (id: string) => void;
  onCreate: (d: Date) => void;
  onRefresh: () => void;
}) {
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 900);
  const [miniMonth, setMiniMonth] = useState(
    new Date(date.getFullYear(), date.getMonth(), 1),
  );
  const [showCalendar, setShowCalendar] = useState(true),
    [owned, setOwned] = useState(true),
    [invited, setInvited] = useState(true),
    [showEnded, setShowEnded] = useState(true),
    [filters, setFilters] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const { from, to } = calendarRange(date, mode);
  const length =
    mode === 'Month' ? 42 : mode === 'Day' ? 1 : mode === 'Work week' ? 5 : 7;
  const days = Array.from({ length }, (_, i) => addDays(from, i));
  const miniFrom = monday(miniMonth),
    miniDays = Array.from({ length: 42 }, (_, i) => addDays(miniFrom, i));
  const today = startDay(new Date());
  const visible = showCalendar
    ? events.filter(
        (m) =>
          (m.organizer.id === userId ? owned : invited) &&
          (showEnded || (!m.call_ended && new Date(m.ends_at) > new Date())),
      )
    : [];
  const visibleCount = visible.filter(
    (m) => new Date(m.starts_at) < to && new Date(m.ends_at) > from,
  ).length;
  const selectedEvents = visible
    .filter((m) => overlaps(m, startDay(date)))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  useEffect(() => {
    setMiniMonth(new Date(date.getFullYear(), date.getMonth(), 1));
  }, [date.getFullYear(), date.getMonth()]);
  useEffect(() => {
    if (scroller.current && mode !== 'Month')
      scroller.current.scrollTop = 8 * 52;
  }, [mode, dateKey(from)]);
  useEffect(() => {
    if (!window.matchMedia) return;
    const narrow = window.matchMedia('(max-width: 900px)');
    const change = () => setSidebar(!narrow.matches);
    narrow.addEventListener('change', change);
    return () => narrow.removeEventListener('change', change);
  }, []);
  function chooseDay(day: Date) {
    onDate(day);
    if (window.innerWidth < 900) setSidebar(false);
  }
  function move(direction: number) {
    onDate(
      mode === 'Month'
        ? new Date(date.getFullYear(), date.getMonth() + direction, 1)
        : addDays(date, direction * (mode === 'Day' ? 1 : 7)),
    );
  }
  function chip(m: MeetingRecord, day: Date) {
    return (
      <button
        className={
          'wc-event ' +
          (m.organizer.id === userId ? 'owned' : 'invited') +
          (selectedId === m.id ? ' selected' : '')
        }
        key={m.id}
        disabled={busy}
        onClick={() => onOpen(m.id)}
        title={`${m.title} · ${new Date(m.starts_at).toLocaleString()} – ${new Date(m.ends_at).toLocaleString()}`}
      >
        <span className="wc-event-dot" />
        <span>
          {new Date(m.starts_at) < day ? 'Continues' : time(m.starts_at)}{' '}
          <strong>{m.title}</strong>
        </span>
      </button>
    );
  }
  const label =
    mode === 'Month'
      ? date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : mode === 'Day'
        ? fullDate(date)
        : `${from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${addDays(to, -1).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return (
    <div className="workspace-calendar">
      <header className="wc-brandbar">
        <div>
          <CalendarDays size={20} />
          <h1>Calendar</h1>
        </div>
        <label className="wc-search">
          <Search size={16} />
          <input
            aria-label="Search calendar"
            placeholder="Search calendar"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          {query && (
            <button
              aria-label="Clear calendar search"
              onClick={() => onQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <span className="wc-zone">
          {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </span>
      </header>
      <div className="wc-toolbar">
        <button
          className="wc-sidebar-toggle"
          aria-label="Toggle calendar sidebar"
          aria-expanded={sidebar}
          onClick={() => setSidebar((v) => !v)}
        >
          <Menu size={18} />
        </button>
        <button
          className="wc-new"
          onClick={() => onCreate(suggestedStart(date))}
          disabled={busy}
        >
          <Plus size={16} />
          New event
        </button>
        <nav aria-label="Calendar views">
          {(['Day', 'Work week', 'Week', 'Month'] as CalendarMode[]).map(
            (view) => (
              <button
                key={view}
                aria-pressed={mode === view}
                onClick={() => onMode(view)}
              >
                <CalendarDays size={14} />
                {view}
              </button>
            ),
          )}
        </nav>
        <div className="wc-toolbar-extras">
          <div className="wc-filter-wrap">
            <button
              aria-label="Filter calendar"
              aria-expanded={filters}
              onClick={() => setFilters((v) => !v)}
            >
              <Filter size={15} />
              Filter
              {(!owned || !invited || !showEnded) && (
                <span className="wc-filter-dot" />
              )}
            </button>
            {filters && (
              <div className="wc-filters" aria-label="Calendar filters">
                <strong>Show meetings</strong>
                <label>
                  <input
                    type="checkbox"
                    checked={owned}
                    onChange={(e) => setOwned(e.target.checked)}
                  />
                  Organized by me
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={invited}
                    onChange={(e) => setInvited(e.target.checked)}
                  />
                  Invited meetings
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showEnded}
                    onChange={(e) => setShowEnded(e.target.checked)}
                  />
                  Ended meetings
                </label>
                <button onClick={() => setFilters(false)}>Done</button>
              </div>
            )}
          </div>
          <button onClick={() => window.print()} title="Print current calendar">
            <Printer size={15} />
            Print
          </button>
          <button
            aria-label="Refresh calendar"
            disabled={loading || busy}
            onClick={onRefresh}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      <div className="wc-body">
        {sidebar && (
          <aside className="wc-sidebar" aria-label="Calendar sidebar">
            <div className="wc-mini-heading">
              <strong>
                {miniMonth.toLocaleDateString(undefined, {
                  month: 'long',
                  year: 'numeric',
                })}
              </strong>
              <button
                aria-label="Previous mini calendar month"
                onClick={() =>
                  setMiniMonth(
                    new Date(
                      miniMonth.getFullYear(),
                      miniMonth.getMonth() - 1,
                      1,
                    ),
                  )
                }
              >
                <ChevronLeft size={15} />
              </button>
              <button
                aria-label="Next mini calendar month"
                onClick={() =>
                  setMiniMonth(
                    new Date(
                      miniMonth.getFullYear(),
                      miniMonth.getMonth() + 1,
                      1,
                    ),
                  )
                }
              >
                <ChevronRight size={15} />
              </button>
            </div>
            <div className="wc-mini">
              <div className="wc-mini-weekdays">
                {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                  <span key={i}>{d}</span>
                ))}
              </div>
              <div className="wc-mini-days">
                {miniDays.map((day) => (
                  <button
                    key={dateKey(day)}
                    className={
                      (day.getMonth() !== miniMonth.getMonth()
                        ? 'outside '
                        : '') +
                      (sameDay(day, date) ? 'chosen ' : '') +
                      (sameDay(day, today) ? 'today' : '')
                    }
                    aria-label={'Select ' + fullDate(day)}
                    aria-current={sameDay(day, today) ? 'date' : undefined}
                    aria-pressed={sameDay(day, date)}
                    onClick={() => chooseDay(day)}
                  >
                    {day.getDate()}
                  </button>
                ))}
              </div>
            </div>
            <div className="wc-calendars">
              <h2>My calendars</h2>
              <label>
                <input
                  type="checkbox"
                  checked={showCalendar}
                  onChange={(e) => setShowCalendar(e.target.checked)}
                />
                <span className="wc-calendar-color" />
                Workspace meetings
              </label>
              <div className="wc-legend">
                <span>
                  <i className="owned" />
                  Organized by you
                </span>
                <span>
                  <i className="invited" />
                  Invited meetings
                </span>
              </div>
            </div>
            <div className="wc-agenda">
              <span className="wc-eyebrow">SELECTED DAY</span>
              <h2>
                {date.toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
              </h2>
              {selectedEvents.length ? (
                selectedEvents.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => onOpen(m.id)}
                    disabled={busy}
                  >
                    <span>{time(m.starts_at)}</span>
                    <strong>{m.title}</strong>
                  </button>
                ))
              ) : (
                <p>No meetings on this day.</p>
              )}
            </div>
            <small className="wc-sidebar-note">
              Your invited workspace meetings. Times use your browser’s time
              zone.
            </small>
          </aside>
        )}
        <main className="wc-main">
          <div className="wc-navigator">
            <div className="wc-nav-buttons">
              <button
                className="wc-today"
                onClick={() => onDate(startDay(new Date()))}
              >
                Today
              </button>
              <button
                aria-label="Previous calendar period"
                onClick={() => move(-1)}
              >
                <ChevronLeft size={17} />
              </button>
              <button aria-label="Next calendar period" onClick={() => move(1)}>
                <ChevronRight size={17} />
              </button>
            </div>
            <h2 aria-live="polite">{label}</h2>
            <input
              aria-label="Go to calendar date"
              type="date"
              value={dateKey(date)}
              onChange={(e) => {
                if (e.target.value) {
                  const [y, m, d] = e.target.value.split('-').map(Number);
                  onDate(new Date(y, m - 1, d));
                }
              }}
            />
          </div>
          {loading && (
            <div className="wc-loading" role="status">
              Updating calendar…
            </div>
          )}
          {mode === 'Month' ? (
            <div className="wc-month-scroll">
              <div className="wc-month">
                <div className="wc-weekdays">
                  {[
                    'Monday',
                    'Tuesday',
                    'Wednesday',
                    'Thursday',
                    'Friday',
                    'Saturday',
                    'Sunday',
                  ].map((d) => (
                    <span key={d}>{d}</span>
                  ))}
                </div>
                <div className="wc-month-days">
                  {days.map((day) => (
                    <div
                      key={dateKey(day)}
                      className={
                        'wc-month-day' +
                        (day.getMonth() !== date.getMonth() ? ' outside' : '') +
                        (sameDay(day, today) ? ' today' : '') +
                        (sameDay(day, date) ? ' chosen' : '')
                      }
                      onDoubleClick={() => onCreate(suggestedStart(day))}
                    >
                      <div className="wc-day-heading">
                        <button
                          aria-label={'Show ' + fullDate(day)}
                          onClick={() => {
                            onDate(day);
                            onMode('Day');
                          }}
                        >
                          {day.getDate()}
                          {day.getDate() === 1
                            ? ' ' +
                              day.toLocaleDateString(undefined, {
                                month: 'short',
                              })
                            : ''}
                        </button>
                        <button
                          className="wc-cell-add"
                          aria-label={'Create event on ' + fullDate(day)}
                          onClick={() => onCreate(suggestedStart(day))}
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                      <div className="wc-cell-events">
                        {visible
                          .filter((m) => overlaps(m, day))
                          .sort((a, b) =>
                            a.starts_at.localeCompare(b.starts_at),
                          )
                          .map((m) => chip(m, day))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="wc-time-scroll" ref={scroller}>
              <div
                className="wc-time-board"
                style={{
                  minWidth:
                    mode === 'Day' ? 320 : mode === 'Work week' ? 620 : 780,
                }}
              >
                <div
                  className="wc-time-head"
                  style={{
                    gridTemplateColumns: `56px repeat(${days.length},minmax(0,1fr))`,
                  }}
                >
                  <span className="wc-time-label">
                    <Clock size={13} />
                  </span>
                  {days.map((day) => (
                    <button
                      key={dateKey(day)}
                      className={sameDay(day, today) ? 'today' : ''}
                      onClick={() => {
                        onDate(day);
                        onMode('Day');
                      }}
                    >
                      <span>
                        {day.toLocaleDateString(undefined, {
                          weekday: 'short',
                        })}
                      </span>
                      <strong>{day.getDate()}</strong>
                    </button>
                  ))}
                </div>
                <div
                  className="wc-time-grid"
                  style={{
                    gridTemplateColumns: `56px repeat(${days.length},minmax(0,1fr))`,
                  }}
                >
                  <div className="wc-hours">
                    {Array.from({ length: 24 }, (_, h) => (
                      <span key={h}>
                        {new Date(2000, 0, 1, h).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    ))}
                  </div>
                  {days.map((day) => (
                    <div
                      className="wc-time-column"
                      key={dateKey(day)}
                      aria-label={fullDate(day)}
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <button
                          className="wc-time-slot"
                          key={h}
                          aria-label={
                            'Create event ' +
                            fullDate(day) +
                            ' at ' +
                            String(h).padStart(2, '0') +
                            ':00'
                          }
                          onClick={() => {
                            const value = startDay(day);
                            value.setHours(h);
                            onCreate(value);
                          }}
                        />
                      ))}
                      {positionEvents(visible, day).map((item) => (
                        <button
                          className={
                            'wc-timed-event ' +
                            (item.meeting.organizer.id === userId
                              ? 'owned'
                              : 'invited') +
                            (selectedId === item.meeting.id ? ' selected' : '')
                          }
                          key={item.meeting.id}
                          disabled={busy}
                          style={{
                            top: (item.start / 60) * 52,
                            height: Math.max(
                              24,
                              ((item.end - item.start) / 60) * 52,
                            ),
                            left: `calc(${(item.column / item.columns) * 100}% + 3px)`,
                            width: `calc(${100 / item.columns}% - 6px)`,
                          }}
                          title={`${item.meeting.title} · ${time(item.meeting.starts_at)} – ${time(item.meeting.ends_at)}`}
                          onClick={() => onOpen(item.meeting.id)}
                        >
                          <strong>{item.meeting.title}</strong>
                          <span>
                            {time(item.meeting.starts_at)} –{' '}
                            {time(item.meeting.ends_at)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <footer className="wc-status">
            <span>
              {visibleCount} meeting{visibleCount === 1 ? '' : 's'} in this view
            </span>
            <span>
              {mode === 'Month'
                ? 'Select a date to open Day view · + to create an event'
                : 'Select a time slot to create an event'}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
