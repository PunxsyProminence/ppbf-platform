/**
 * @jest-environment jsdom
 */

// The organization admin's block of coach notes on the admin athlete-records
// page (OD-2026-10-10-004 ruling 4). What is proven here, with the server
// doubled: the block reads nothing until something is opened; the capacity
// panel inside it offers Withdraw on exactly the note the server marks as a
// departed coach's; a session must be picked before its staff notes are read,
// and one session's notes never stay on screen under another; and unknown is
// never shown as "none".
//
// NOT proven here: who the server lets read or withdraw (the modules' pg
// suites and the route tests), and how the block reads on a gym tablet (only
// a signed-in look does).

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

// created_at is an instant; the gym is on America/New_York (15:00Z = 11:00 AM EDT).
const SESSIONS = {
  items: [
    { session_id: 'sess-old', date: '2026-10-01', completed_flag: true, created_at: '2026-10-01T15:00:00.000Z', rpe: 7 },
    { session_id: 'sess-am', date: '2026-10-08T00:00:00.000Z', completed_flag: true, created_at: '2026-10-08T13:30:00.000Z', rpe: 6 },
    { session_id: 'sess-pm', date: '2026-10-08T00:00:00.000Z', completed_flag: false, created_at: '2026-10-08T21:15:00.000Z', rpe: null },
  ],
};

const STAFF_NOTES: Record<string, string> = {
  'sess-pm': 'Asked to stop early',
  'sess-am': 'Sharp on the pads',
};

function serve(overrides: { sessions?: () => Response | Promise<Response> } = {}) {
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
      return respond({ ok: true, note_max: 2000, notes: capacityNotes });
    }
    if (url.includes('/api/pilot/sessions/list')) {
      return overrides.sessions ? overrides.sessions() : respond(SESSIONS);
    }
    if (url.includes('/api/pilot/coach/session-staff-notes')) {
      const session = Object.keys(STAFF_NOTES).find((id) => url.includes(`session_id=${id}`));
      return respond({
        ok: true,
        note_max: 2000,
        notes: session
          ? [{ note_id: `staff-${session}`, note: STAFF_NOTES[session], author_name: 'Coach Jason Neale', created_at: '2026-10-08T16:00:00.000Z', own: false }]
          : [],
      });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

function renderBlock() {
  render(<AdminAthleteCoachNotes athleteId="ath-1" athleteName="Dawn Kellerman" />);
}

async function openSessionPicker(): Promise<HTMLSelectElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Session notes' }));
  return (await screen.findByLabelText('Session')) as HTMLSelectElement;
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
  // F-058: one tap asks, it does not remove. Cancel leaves the note and sends
  // nothing; the second tap, on "Yes, Withdraw It", does the withdrawal.
  fireEvent.click(withdraw[0]);
  expect(screen.getByText(/^Withdraw the note from .*\?$/)).toBeTruthy();
  expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText('Faded late in round five')).toBeTruthy();
  expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);

  fireEvent.click(screen.getAllByRole('button', { name: /^Withdraw/ })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Yes, Withdraw It' }));
  await waitFor(() => expect(screen.queryByText('Faded late in round five')).toBeNull());
  expect(screen.getByText('Held pace through all six rounds')).toBeTruthy();

  const deletes = calls.filter((call) => call.method === 'DELETE');
  expect(deletes).toHaveLength(1);
  expect(deletes[0].url).toContain('/api/pilot/coach/athlete-capacity-notes?athlete_id=ath-1&note_id=note-departed');
  // Opening capacity notes never reads sessions.
  expect(calls.some((call) => call.url.includes('/sessions/list'))).toBe(false);
});

test('session notes: sessions are read when opened, newest first, two on one day told apart by start time; staff notes only once one is picked', async () => {
  serve();
  renderBlock();
  const picker = await openSessionPicker();
  expect(calls.map((call) => call.url)).toEqual([
    expect.stringContaining('/api/pilot/sessions/list?athlete_id=ath-1&limit=201'),
  ]);
  expect(Array.from(picker.options).map((option) => option.textContent)).toEqual([
    'Select a session',
    '2026-10-08, 5:15 PM - open',
    '2026-10-08, 9:30 AM - completed',
    '2026-10-01, 11:00 AM - completed',
  ]);
  expect(screen.queryByText(/could not be read and/)).toBeNull();
  expect(screen.queryByText(/Older sessions are kept/)).toBeNull();
  // No session picked: no staff-notes panel, nothing read.
  expect(screen.queryByRole('button', { name: 'Staff notes on this session' })).toBeNull();

  fireEvent.change(picker, { target: { value: 'sess-pm' } });
  fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
  expect(await screen.findByText('Asked to stop early')).toBeTruthy();
  const staffCall = calls.find((call) => call.url.includes('/session-staff-notes'));
  expect(staffCall?.url).toContain('session_id=sess-pm');
  expect(staffCall?.url).toContain('athlete_id=ath-1');
});

test('picking another session takes the first session\'s staff notes off the screen', async () => {
  serve();
  renderBlock();
  const picker = await openSessionPicker();
  fireEvent.change(picker, { target: { value: 'sess-pm' } });
  fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
  await screen.findByText('Asked to stop early');

  fireEvent.change(picker, { target: { value: 'sess-am' } });
  // A fresh, closed panel for the new session: nothing of the old one remains.
  expect(screen.queryByText('Asked to stop early')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
  expect(await screen.findByText('Sharp on the pads')).toBeTruthy();
  expect(screen.queryByText('Asked to stop early')).toBeNull();
});

test('hiding session notes forgets the picked session', async () => {
  serve();
  renderBlock();
  const picker = await openSessionPicker();
  fireEvent.change(picker, { target: { value: 'sess-pm' } });
  expect(screen.getByRole('button', { name: 'Staff notes on this session' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Hide session notes' }));
  const reopened = await openSessionPicker();
  expect(reopened.value).toBe('');
  expect(screen.queryByRole('button', { name: 'Staff notes on this session' })).toBeNull();
});

test('sessions that could not be read are "could not be read", never "no sessions", with a retry', async () => {
  serve({ sessions: () => respond({}, 500) });
  renderBlock();
  fireEvent.click(screen.getByRole('button', { name: 'Session notes' }));
  expect(await screen.findByText(/sessions could not be read just now/)).toBeTruthy();
  expect(screen.queryByText(/No sessions are recorded/)).toBeNull();

  serve({ sessions: () => respond({ items: [] }) });
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByText('No sessions are recorded for this athlete yet.')).toBeTruthy();
});

test.each([
  ['an answer with no list', () => respond({ ok: true })],
  ['a connection that fails', () => Promise.reject(new Error('offline'))],
])('%s is "could not be read", never "no sessions"', async (_label, sessions) => {
  serve({ sessions });
  renderBlock();
  fireEvent.click(screen.getByRole('button', { name: 'Session notes' }));
  expect(await screen.findByText(/sessions could not be read just now/)).toBeTruthy();
  expect(screen.queryByText(/No sessions are recorded/)).toBeNull();
});

test('a refusal is shown in the server\'s words', async () => {
  serve({ sessions: () => respond({ error: 'Forbidden: athlete not accessible' }, 403) });
  renderBlock();
  fireEvent.click(screen.getByRole('button', { name: 'Session notes' }));
  expect(await screen.findByText('Forbidden: athlete not accessible')).toBeTruthy();
  expect(screen.queryByText(/No sessions are recorded/)).toBeNull();
});

test('session records that cannot be read are counted, not passed off as "no sessions"', async () => {
  serve({ sessions: () => respond({ items: [{ date: '2026-10-09', completed_flag: true }, { session_id: 'sess-x' }] }) });
  renderBlock();
  fireEvent.click(screen.getByRole('button', { name: 'Session notes' }));
  expect(await screen.findByText('2 session records could not be read and are not listed.')).toBeTruthy();
  expect(screen.queryByText(/No sessions are recorded/)).toBeNull();
  expect(screen.queryByLabelText('Session')).toBeNull();
});

test('past the newest 200 sessions the block says older ones exist; at exactly 200 it does not', async () => {
  const many = (count: number) => ({
    items: Array.from({ length: count }, (_unused, index) => ({
      session_id: `sess-${index}`,
      date: '2026-01-01',
      completed_flag: true,
      created_at: new Date(Date.UTC(2026, 0, 1, 12, 0, count - index)).toISOString(),
    })),
  });
  serve({ sessions: () => respond(many(201)) });
  renderBlock();
  const picker = await openSessionPicker();
  expect(picker.options).toHaveLength(201); // the placeholder + the newest 200
  expect(Array.from(picker.options).some((option) => option.value === 'sess-200')).toBe(false);
  expect(screen.getByText('Older sessions are kept but not listed here; this shows the newest 200.')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Hide session notes' }));
  serve({ sessions: () => respond(many(200)) });
  const complete = await openSessionPicker();
  expect(complete.options).toHaveLength(201);
  expect(screen.queryByText(/Older sessions are kept/)).toBeNull();
});

test('closing session notes drops a read that lands afterwards', async () => {
  let release: (response: Response) => void = () => undefined;
  serve({ sessions: () => new Promise<Response>((resolve) => { release = resolve; }) });
  renderBlock();
  fireEvent.click(screen.getByRole('button', { name: 'Session notes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hide session notes' }));
  // Let the reply land and React render whatever it would: a setTimeout turn
  // inside act, not a bare microtask, or a late render is never observed.
  await act(async () => {
    release(respond(SESSIONS));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.queryByLabelText('Session')).toBeNull();
  expect(screen.getByRole('button', { name: 'Session notes' })).toBeTruthy();
});
