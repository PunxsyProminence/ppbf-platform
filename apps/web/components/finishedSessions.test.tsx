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
  // 02:30 on the 14th in UTC is 10:30 PM on the 13th at the gym: the day shown must be the gym's.
  started_at: '2026-10-14T02:30:00.000Z',
  ended_at: '2026-10-14T03:35:00.000Z',
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
  blocks_completed: 4,
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
  // A count not stated is not shown (never as zero), and empty notes are not shown as labels.
  expect(scripted.textContent).toContain('4 blocks completed.');
  expect(scripted.textContent).not.toContain('athletes present');
  expect(scripted.textContent).not.toContain('Deviation:');
  expect(scripted.textContent).toContain('No athlete on the gym’s current list was marked here.');

  expect(plain.textContent).toContain('Plain session · You ran it');
  expect(plain.textContent).toContain('Completed');
  expect(plain.textContent).toContain("2 athletes present (the coach's count).");
  expect(plain.textContent).toContain('Deviation: Finished early.');
  expect(plain.textContent).toContain('Worked: The jab round.');
  expect(plain.textContent).not.toContain('Did not work:');
  // The gym's day and times, from the session's own start and end.
  const expected = `${formatGymDate(PLAIN.started_at)}, ${formatGymTimeOfDay(PLAIN.started_at)} to ${formatGymTimeOfDay(PLAIN.ended_at)}`;
  expect(within(plain).getByText(expected)).toBeTruthy();
  expect(expected).toBe('October 13, 2026, 10:30 PM to 11:35 PM');
  // Each session is its own heading.
  expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
    `${expected}Abandoned`,
    `${expected}Completed`,
  ]);
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
    fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ben Ortiz, October 13, 2026, 10:30 PM to 11:35 PM' }));
  });
  expect(urls[1]).toEqual({ url: '/api/pilot/coach/session-staff-notes?run_id=ssrun_1&athlete_id=ath-2', method: 'GET' });
});

// Live walkthrough 2026-10-19: a run left open overnight read "October 18, 2026, 1:33 PM to 7:10 PM"
// although it ended the next evening -- a day and a half shown as six hours on one day.
test('a session that ended on a later gym day names the end day too; one on a single day does not repeat it', async () => {
  const overnight = {
    ...PLAIN,
    run_id: 'ssrun_overnight',
    run_state: 'abandoned',
    started_at: '2026-10-18T17:33:00.000Z',
    ended_at: '2026-10-19T23:10:00.000Z',
    athletes_present: 1,
    blocks_completed: 1,
    present: [],
  };
  serve(() => respond({ runs: [overnight, PLAIN] }));
  await show();

  const [first, second] = items();
  expect(within(first).getByRole('heading', { level: 3 }).textContent)
    .toBe('October 18, 2026, 1:33 PM to October 19, 2026, 7:10 PMAbandoned');
  expect(within(second).getByRole('heading', { level: 3 }).textContent)
    .toBe('October 13, 2026, 10:30 PM to 11:35 PMCompleted');
  // One is singular.
  expect(first.textContent).toContain("1 athlete present (the coach's count). 1 block completed.");
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

// D4 (OD-2026-10-21-002): a session tied to a class names the class in the history.
test('a finished session tied to a class names the class; an open-gym one does not', async () => {
  const runs = [
    { ...PLAIN, run_id: 'run-tied', class_title: 'Youth boxing' },
    { ...SCRIPTED, run_id: 'run-open', class_title: null },
  ];
  serve(() => respond({ runs }));
  await act(async () => {
    render(<FinishedSessions />);
  });
  expect(screen.getByText(/Plain session · Youth boxing · You ran it/)).toBeTruthy();
  expect(screen.getByText(/Tuesday juniors \(version 2\) · Run by Coach Ray/)).toBeTruthy();
});
