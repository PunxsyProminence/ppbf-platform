/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import FinishedSessions from './FinishedSessions';
import { formatGymDate, formatGymTimeOfDay } from '@/src/lib/gymTime';

// The gym's finished sessions (audit finding F-067). The route's reads and who may make them are
// proven in route.finished.test.ts and sessionRunAthletes.pg.test.ts; this suite asserts what the
// screen does with the answer: what it calls, what it shows, and that it never says more than it
// knows.

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const PLAIN = {
  run_id: 'ssrun_1',
  script_id: null,
  script_version: null,
  script_name: null,
  run_state: 'completed',
  delivered_on: '2026-10-13',
  started_at: '2026-10-13T22:00:00.000Z',
  ended_at: '2026-10-13T23:05:00.000Z',
  athletes_present: 2,
  blocks_completed: null,
  deviation_note: 'Finished early.',
  what_worked: 'The jab round.',
  what_did_not: '',
  delivered_by_name: 'Coach Dee',
  delivered_by_me: true,
  present: [
    { athlete_id: 'ath-1', full_name: 'Ada Reyes' },
    { athlete_id: 'ath-2', full_name: 'Ben Ortiz' },
  ],
};
const SCRIPTED = {
  ...PLAIN,
  run_id: 'ssrun_2',
  script_id: 'scr-1',
  script_version: 2,
  script_name: 'Tuesday juniors',
  run_state: 'abandoned',
  athletes_present: null,
  deviation_note: '',
  what_worked: '',
  what_did_not: 'Room too loud.',
  delivered_by_name: 'Coach Ray',
  delivered_by_me: false,
  present: [],
};

let urls: Array<{ url: string; method: string }>;

function serve(handler: (url: string) => Response | Promise<Response>) {
  urls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push({ url: String(input), method: init?.method ?? 'GET' });
    return handler(String(input));
  }) as unknown as typeof fetch;
}

async function show() {
  await act(async () => {
    render(<FinishedSessions />);
  });
}

const items = () => within(screen.getByRole('list', { name: 'Finished sessions, newest first' })).getAllByRole('listitem')
  .filter((item) => item.parentElement?.getAttribute('aria-label') === 'Finished sessions, newest first');

afterEach(() => {
  jest.restoreAllMocks();
});

test('reads the finished sessions once, by GET, and shows each with gym time, plan, who ran it and the end notes', async () => {
  serve(() => respond({ runs: [SCRIPTED, PLAIN] }));
  await show();

  expect(urls).toEqual([{ url: '/api/pilot/session-scripts/runs?finished=true', method: 'GET' }]);
  const [scripted, plain] = items();

  expect(scripted.textContent).toContain('Tuesday juniors (version 2) · Run by Coach Ray');
  expect(scripted.textContent).toContain('Abandoned');
  expect(scripted.textContent).toContain('Did not work: Room too loud.');
  // A count not stated is not shown, and empty notes are not shown as labels.
  expect(scripted.textContent).not.toContain('athletes present');
  expect(scripted.textContent).not.toContain('Deviation:');
  expect(scripted.textContent).toContain('Nobody was marked here in this session.');

  expect(plain.textContent).toContain('Plain session · You ran it');
  expect(plain.textContent).toContain('Completed');
  expect(plain.textContent).toContain("2 athletes present (the coach's count).");
  expect(plain.textContent).toContain('Deviation: Finished early.');
  expect(plain.textContent).toContain('Worked: The jab round.');
  expect(plain.textContent).not.toContain('Did not work:');
  // The gym's day and times, from the session's own start and end.
  const expected = `${formatGymDate(PLAIN.started_at)}, ${formatGymTimeOfDay(PLAIN.started_at)} to ${formatGymTimeOfDay(PLAIN.ended_at)}`;
  expect(within(plain).getByText(expected)).toBeTruthy();
});

test('each athlete marked here has a staff notes box for that session, which reads nothing until opened, then by run', async () => {
  serve((url) => (url.startsWith('/api/pilot/coach/session-staff-notes')
    ? respond({ ok: true, note_max: 2000, notes: [] })
    : respond({ runs: [PLAIN] })));
  await show();

  const marked = within(items()[0]).getByRole('list', { name: /^Marked here/ });
  expect(within(marked).getAllByRole('listitem').map((item) => item.querySelector('.t-body')?.textContent)).toEqual(['Ada Reyes', 'Ben Ortiz']);
  expect(urls).toHaveLength(1);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ben Ortiz' }));
  });
  expect(urls[1]).toEqual({ url: '/api/pilot/coach/session-staff-notes?run_id=ssrun_1&athlete_id=ath-2', method: 'GET' });
});

test('no finished sessions is said in words', async () => {
  serve(() => respond({ runs: [] }));
  await show();
  expect(screen.getByText('No finished sessions yet. A session appears here once it is ended.')).toBeTruthy();
});

test.each([
  ['a server error', () => respond({ error: 'boom' }, 500)],
  ['a refusal', () => respond({ error: 'Forbidden' }, 403)],
  ['an answer without its list', () => respond({ run: null })],
  ['a row without who was present', () => respond({ runs: [{ ...PLAIN, present: undefined }] })],
])('%s is a failed read, never "no sessions", in the ordinary brass alert; Check again reads again', async (_label, answer) => {
  serve(answer);
  await show();

  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('could not be read just now');
  expect(alert.className).toContain('--brass-300');
  expect(alert.className).not.toContain('locked');
  expect(screen.queryByText(/No finished sessions yet/)).toBeNull();

  serve(() => respond({ runs: [PLAIN] }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  });
  expect(urls).toHaveLength(1);
  expect(items()).toHaveLength(1);
});

test('a full page of fifty says older sessions are not listed, rather than letting it read as all of them', async () => {
  serve(() => respond({ runs: Array.from({ length: 50 }, (_, index) => ({ ...PLAIN, run_id: `ssrun_${index}` })) }));
  await show();
  expect(screen.getByText('The newest 50 are shown. Older sessions are kept but are not listed here yet.')).toBeTruthy();
});

test('fewer than fifty says nothing about older ones', async () => {
  serve(() => respond({ runs: [PLAIN] }));
  await show();
  expect(screen.queryByText(/The newest 50 are shown/)).toBeNull();
});
