/**
 * @jest-environment jsdom
 */

// The organization admin's block of coach notes on the admin athlete-records
// page (OD-2026-10-10-004 ruling 4). What is proven here, with the server
// doubled: the block reads nothing until something is opened; the capacity
// panel inside it is the coach screen's own and offers Withdraw on exactly the
// note the server marks as a departed coach's; a session must be picked
// before its staff notes are read; and unknown is never shown as "none".
//
// NOT proven here: who the server lets read or withdraw (the modules' pg
// suites and the route tests), and how the block reads on a gym tablet (only
// a signed-in look does).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import AdminAthleteCoachNotes from './AdminAthleteCoachNotes';

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Call { url: string; method: string }
let calls: Call[];

const DEPARTED_NOTE = {
  note_id: 'note-departed',
  note: 'Faded late in round five',
  author_name: 'Coach Dana Reyes',
  created_at: '2026-10-07T12:00:00.000Z',
  own: false,
  can_withdraw: true,
};
const ACTIVE_NOTE = {
  note_id: 'note-active',
  note: 'Held pace through all six rounds',
  author_name: 'Coach Jason Neale',
  created_at: '2026-10-08T12:00:00.000Z',
  own: false,
  can_withdraw: false,
};

const SESSIONS = {
  items: [
    { session_id: 'sess-old', date: '2026-10-01', completed_flag: true, created_at: '2026-10-01T15:00:00.000Z', rpe: 7 },
    { session_id: 'sess-new', date: '2026-10-08T00:00:00.000Z', completed_flag: false, created_at: '2026-10-08T15:00:00.000Z', rpe: null },
    { date: '2026-10-09', completed_flag: true }, // no session id: dropped, not shown blank
  ],
};

function serve(overrides: {
  capacity?: () => Response;
  sessions?: () => Response | Promise<Response>;
  staffNotes?: () => Response;
} = {}) {
  calls = [];
  let capacityNotes = [ACTIVE_NOTE, DEPARTED_NOTE];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url.includes('/api/pilot/coach/athlete-capacity-notes')) {
      if (method === 'DELETE') {
        capacityNotes = capacityNotes.filter((row) => !url.includes(`note_id=${row.note_id}`));
        return respond({ ok: true });
      }
      return overrides.capacity ? overrides.capacity() : respond({ ok: true, note_max: 2000, notes: capacityNotes });
    }
    if (url.includes('/api/pilot/sessions/list')) {
      return overrides.sessions ? overrides.sessions() : respond(SESSIONS);
    }
    if (url.includes('/api/pilot/coach/session-staff-notes')) {
      return overrides.staffNotes
        ? overrides.staffNotes()
        : respond({
          ok: true,
          note_max: 2000,
          notes: [{ note_id: 'staff-1', note: 'Asked to stop early', author_name: 'Coach Jason Neale', created_at: '2026-10-08T16:00:00.000Z', own: false }],
        });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

function renderBlock() {
  render(<AdminAthleteCoachNotes athleteId="ath-1" athleteName="Dawn Kellerman" />);
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('names the athlete and reads nothing until something is opened', () => {
  serve();
  renderBlock();
  expect(screen.getByRole('heading', { name: 'Coach notes' })).toBeTruthy();
  expect(screen.getByText(/have written about Dawn Kellerman/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Capacity notes' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Session notes' })).toBeTruthy();
  expect(calls).toEqual([]);
});

test('capacity notes: Withdraw only on the departed coach\'s note, by display name; withdrawing sends DELETE for that note', async () => {
  serve();
  renderBlock();
  fireEvent.click(screen.getByRole('button', { name: 'Capacity notes' }));
  const list = await screen.findByRole('list', { name: 'Capacity notes, newest first' });
  const items = list.querySelectorAll('li');
  expect(items).toHaveLength(2);
  expect(items[0].textContent).toContain('Coach Jason Neale');
  expect(items[0].querySelector('button')).toBeNull();
  expect(items[1].textContent).toContain('Coach Dana Reyes');

  const withdraw = screen.getAllByRole('button', { name: /^Withdraw/ });
  expect(withdraw).toHaveLength(1);
  expect(withdraw[0].getAttribute('aria-label')).toMatch(/^Withdraw the note Coach Dana Reyes wrote on /);
  fireEvent.click(withdraw[0]);
  await waitFor(() => expect(screen.queryByText('Faded late in round five')).toBeNull());
  expect(screen.getByText('Held pace through all six rounds')).toBeTruthy();

  const deletes = calls.filter((call) => call.method === 'DELETE');
  expect(deletes).toHaveLength(1);
  expect(deletes[0].url).toContain('/api/pilot/coach/athlete-capacity-notes?athlete_id=ath-1&note_id=note-departed');
  // Opening capacity notes never reads sessions.
  expect(calls.some((call) => call.url.includes('/sessions/list'))).toBe(false);
});

test('session notes: the sessions are read when opened, newest first, and a session\'s staff notes only once it is picked', async () => {
  serve();
  renderBlock();
  fireEvent.click(screen.getByRole('button', { name: 'Session notes' }));
  const picker = (await screen.findByLabelText('Session')) as HTMLSelectElement;
  expect(calls.map((call) => call.url)).toEqual([expect.stringContaining('/api/pilot/sessions/list?athlete_id=ath-1')]);
  expect(Array.from(picker.options).map((option) => option.textContent)).toEqual([
    'Select a session',
    '2026-10-08 - open',
    '2026-10-01 - completed',
  ]);
  // No session picked: no staff-notes panel, nothing read.
  expect(screen.queryByRole('button', { name: 'Staff notes on this session' })).toBeNull();

  fireEvent.change(picker, { target: { value: 'sess-new' } });
  fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
  expect(await screen.findByText('Asked to stop early')).toBeTruthy();
  const staffCall = calls.find((call) => call.url.includes('/session-staff-notes'));
  expect(staffCall?.url).toContain('session_id=sess-new');
  expect(staffCall?.url).toContain('athlete_id=ath-1');
});

test('sessions that could not be read are "could not be read", never "no sessions", with a retry', async () => {
  serve({ sessions: () => respond({ error: 'nope' }, 500) });
  renderBlock();
  fireEvent.click(screen.getByRole('button', { name: 'Session notes' }));
  expect(await screen.findByText(/sessions could not be read just now/)).toBeTruthy();
  expect(screen.queryByText(/No sessions are recorded/)).toBeNull();

  serve({ sessions: () => respond({ items: [] }) });
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByText('No sessions are recorded for this athlete yet.')).toBeTruthy();
});

test('closing session notes drops a read that lands afterwards, and forgets the picked session', async () => {
  let release: () => void = () => {};
  serve({ sessions: () => new Promise<Response>((resolve) => { release = () => resolve(respond(SESSIONS)); }) });
  renderBlock();
  fireEvent.click(screen.getByRole('button', { name: 'Session notes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hide session notes' }));
  release();
  await waitFor(() => expect(calls).toHaveLength(1));
  await Promise.resolve();
  expect(screen.queryByLabelText('Session')).toBeNull();
  expect(screen.getByRole('button', { name: 'Session notes' })).toBeTruthy();
});
