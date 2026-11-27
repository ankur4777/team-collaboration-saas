// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WorkspaceCalendar, {
  calendarRange,
  positionEvents,
  type CalendarMode,
} from './WorkspaceCalendar';
import type { MeetingRecord } from './api';
const date = new Date(2026, 10, 20);
const record = (id: string, start: Date, end: Date): MeetingRecord => ({
  id,
  title: 'Planning ' + id,
  agenda: '',
  starts_at: start.toISOString(),
  ends_at: end.toISOString(),
  time_zone: 'UTC',
  meeting_url: '',
  notes: '',
  call_ended: false,
  organizer_in_call: false,
  cancelled: false,
  revision: 1,
  organizer: { id: 'owner', full_name: 'Owner', email: 'owner@example.test' },
  channel: null,
  my_response: 'accepted',
  attendees: [],
  action_items: [],
});
const meeting = record(
  'A',
  new Date(2026, 10, 20, 10),
  new Date(2026, 10, 20, 11),
);
function props(mode: CalendarMode = 'Month') {
  return {
    date,
    mode,
    events: [meeting],
    selectedId: '',
    userId: 'owner',
    query: '',
    loading: false,
    busy: false,
    onDate: vi.fn(),
    onMode: vi.fn(),
    onQuery: vi.fn(),
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    onRefresh: vi.fn(),
  };
}
afterEach(cleanup);
describe('Calendar date ranges and event placement', () => {
  it('uses Monday starts and a five-day work week without UTC date conversion', () => {
    const month = calendarRange(date, 'Month');
    expect(month.from.getDay()).toBe(1);
    expect(month.from.getDate()).toBe(26);
    expect(month.from.getMonth()).toBe(9);
    const work = calendarRange(date, 'Work week');
    expect(work.from.getDay()).toBe(1);
    expect(work.to.getDay()).toBe(6);
    expect(work.from.getDate()).toBe(16);
    expect(calendarRange(date, 'Day').from.getDate()).toBe(20);
  });
  it('places overlapping events side by side and reuses columns once free', () => {
    const events = [
      meeting,
      record(
        'B',
        new Date(2026, 10, 20, 10, 30),
        new Date(2026, 10, 20, 11, 30),
      ),
      record('C', new Date(2026, 10, 20, 11), new Date(2026, 10, 20, 12)),
    ];
    const positioned = positionEvents(events, date);
    expect(positioned.map((x) => x.columns)).toEqual([2, 2, 2]);
    expect(positioned.map((x) => x.column)).toEqual([0, 1, 0]);
  });
  it('clips an overnight meeting to each displayed day', () => {
    const overnight = record(
      'night',
      new Date(2026, 10, 19, 23, 30),
      new Date(2026, 10, 20, 0, 30),
    );
    expect(positionEvents([overnight], date)[0].start).toBe(0);
    expect(positionEvents([overnight], date)[0].end).toBe(30);
    expect(positionEvents([overnight], new Date(2026, 10, 19))[0].end).toBe(
      1440,
    );
  });
});
describe('Workspace calendar controls', () => {
  it('opens an existing event and filters the calendar without changing its data', async () => {
    const p = props();
    const user = userEvent.setup();
    render(<WorkspaceCalendar {...p} />);
    await user.click(screen.getAllByRole('button', { name: /Planning A/ })[0]);
    expect(p.onOpen).toHaveBeenCalledWith('A');
    await user.click(
      screen.getByRole('checkbox', { name: 'Workspace meetings' }),
    );
    expect(screen.queryByRole('button', { name: /Planning A/ })).toBeNull();
    expect(p.events).toHaveLength(1);
  });
  it('switches views and selects a mini-calendar date', async () => {
    const p = props(),
      user = userEvent.setup();
    render(<WorkspaceCalendar {...p} />);
    await user.click(
      within(
        screen.getByRole('navigation', { name: 'Calendar views' }),
      ).getByRole('button', { name: 'Work week' }),
    );
    expect(p.onMode).toHaveBeenCalledWith('Work week');
    await user.click(
      screen.getByRole('button', {
        name: 'Select Saturday, November 21, 2026',
      }),
    );
    expect(p.onDate.mock.calls[0][0].getDate()).toBe(21);
  });
  it('prefills new events from the selected day and time slot', async () => {
    const p = props('Day'),
      user = userEvent.setup();
    render(<WorkspaceCalendar {...p} />);
    await user.click(
      screen.getByRole('button', {
        name: 'Create event Friday, November 20, 2026 at 14:00',
      }),
    );
    const value = p.onCreate.mock.calls[0][0];
    expect(value.getDate()).toBe(20);
    expect(value.getHours()).toBe(14);
  });
  it('filters organized and invited meetings independently', async () => {
    const p = props(),
      user = userEvent.setup();
    render(<WorkspaceCalendar {...p} />);
    await user.click(screen.getByRole('button', { name: 'Filter calendar' }));
    await user.click(screen.getByRole('checkbox', { name: 'Organized by me' }));
    expect(screen.queryByRole('button', { name: /Planning A/ })).toBeNull();
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Invited meetings',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });
});

