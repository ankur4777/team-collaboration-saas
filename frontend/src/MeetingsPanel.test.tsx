import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MeetingsPanel from './MeetingsPanel';
import { meetingsApi, type MeetingRecord } from './api';
vi.mock('./api', () => ({
  api: { channels: vi.fn(), teamMembers: vi.fn() },
  callsApi: { config: vi.fn(), end: vi.fn() },
  meetingsApi: {
    list: vi.fn(),
    detail: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    cancel: vi.fn(),
    rsvp: vi.fn(),
    read: vi.fn(),
    addAction: vi.fn(),
    completeAction: vi.fn(),
  },
}));
const start = new Date(Date.now() + 86400000);
const end = new Date(start.getTime() + 3600000);
const meeting: MeetingRecord = {
  id: 'meeting-1',
  title: 'Project review',
  agenda: 'Discuss the release',
  starts_at: start.toISOString(),
  ends_at: end.toISOString(),
  time_zone: 'UTC',
  meeting_url: 'https://meet.example.test/review',
  notes: '',
  call_ended: false,
  cancelled: false,
  revision: 1,
  organizer: { id: 'owner', full_name: 'Owner', email: 'owner@example.test' },
  channel: null,
  my_response: 'pending',
  attendees: [
    {
      user: { id: 'member', full_name: 'Member', email: 'member@example.test' },
      response: 'pending',
    },
  ],
  action_items: [],
};
const members = [
  {
    id: 'membership',
    role: 'member',
    joined_at: '2026-01-01',
    user: {
      id: 'member',
      email: 'member@example.test',
      full_name: 'Member',
      email_verified: true,
    },
  },
];
beforeEach(() => {
  vi.mocked(meetingsApi.list).mockResolvedValue({
    results: [meeting],
    limit: 500,
  });
  vi.mocked(meetingsApi.detail).mockResolvedValue(meeting);
  vi.mocked(meetingsApi.read).mockResolvedValue({ status: 'read' });
  vi.mocked(meetingsApi.create).mockResolvedValue(meeting);
  vi.mocked(meetingsApi.rsvp).mockResolvedValue({
    ...meeting,
    my_response: 'accepted',
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const mount = (userId = 'member', calendar = false) =>
  render(
    <MeetingsPanel
      workspaceId="org-1"
      userId={userId}
      members={members}
      teams={[]}
      calendar={calendar}
      onChanged={() => {}}
    />,
  );
describe('Meetings dashboard', () => {
  it('schedules an internal meeting without an external link', async () => {
    const user = userEvent.setup();
    mount('owner');
    await user.click(screen.getByRole('button', { name: 'Schedule meeting' }));
    const form = screen.getByRole('dialog', { name: 'Schedule meeting' });
    await user.type(
      within(form).getByLabelText('Meeting title'),
      'Release planning',
    );
    expect(within(form).queryByLabelText('Meeting link')).toBeNull();
    await user.click(within(form).getByRole('checkbox', { name: /Member/ }));
    await user.click(
      within(form).getByRole('button', { name: 'Create meeting' }),
    );
    await waitFor(() =>
      expect(meetingsApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Release planning',
          attendee_ids: ['member'],
        }),
      ),
    );
  });
  it('lets an invited member accept and open the internal call screen', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole('button', { name: /Project review/ }),
    );

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(meetingsApi.rsvp).toHaveBeenCalledWith('meeting-1', 'accepted'),
    );
    expect(screen.queryByRole('button', { name: 'Cancel meeting' })).toBeNull();
    await user.click(
      await screen.findByRole('button', { name: 'Join meeting' }),
    );
    expect(
      screen.getByRole('dialog', { name: 'Call: Project review' }),
    ).toBeTruthy();
  });
  it('uses the same record in Calendar and opens its details', async () => {
    const user = userEvent.setup();
    mount('member', true);
    await user.click(
      await screen.findByRole('button', { name: /Project review/ }),
    );
    expect(await screen.findByText('Discuss the release')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Add to calendar' })
        .getAttribute('href'),
    ).toBe('/api/meetings/meeting-1/calendar.ics');
  });
  it('does not offer to join a call ended by the organizer', async () => {
    vi.mocked(meetingsApi.detail).mockResolvedValue({
      ...meeting,
      call_ended: true,
    });
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole('button', { name: /Project review/ }),
    );
    expect(await screen.findByText('This call has ended.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join meeting' })).toBeNull();
  });
});
