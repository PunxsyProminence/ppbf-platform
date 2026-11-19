/**
 * @jest-environment jsdom
 */

// The rollup is a staff reporting surface over records the gym already keeps.
// What these pin: the empty state never shows while the request is in flight
// ("no athletes" is a claim about the roster, not the network); a loaded row
// carries its numbers; the readiness trend badge only renders when both
// halves of the window have data; and switching the window refetches with
// the selected window_days.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import PerformanceAnalyticsPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const ITEM = {
  athlete_id: 'ath-1',
  full_name: 'Jordan Doe',
  sessions_total: 4,
  sessions_completed: 3,
  avg_rpe: 6.5,
  avg_session_load: 390,
  session_load_count: 4,
  training_days: 8,
  readiness_count: 6,
  avg_readiness: 7.1,
  readiness_early_avg: 6.4,
  readiness_late_avg: 7.6,
  open_gaps: 1,
  active_assignments: 2,
  avg_assignment_completion: 55,
};

function mockFetch(responder: (url: string) => Promise<Response> | Response) {
  return jest.fn(async (input: RequestInfo | URL) => responder(String(input))) as unknown as typeof fetch;
}

const okWith = (items: unknown[]) =>
  ({ ok: true, json: async () => ({ window_days: 28, items }) }) as Response;

afterEach(() => {
  jest.restoreAllMocks();
});

test('the empty state is withheld while the rollup is still loading', async () => {
  global.fetch = mockFetch(() => new Promise<Response>(() => {}));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText(/Loading performance rollup/);
  expect(screen.queryByText('No athletes on your roster')).toBeNull();
});

test('the empty state appears once loading settles with an empty roster', async () => {
  global.fetch = mockFetch(() => okWith([]));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText('No athletes on your roster');
  await waitFor(() => expect(screen.queryByText(/Loading performance rollup/)).toBeNull());
});

test('a loaded row shows its numbers and a rising readiness trend', async () => {
  global.fetch = mockFetch(() => okWith([ITEM]));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText('Jordan Doe');
  expect(screen.getByText('3/4')).toBeTruthy();
  expect(screen.getByText('8')).toBeTruthy();
  expect(screen.getByText('rising')).toBeTruthy();
  expect(screen.getByText('55%')).toBeTruthy();
});

test('no trend badge renders when only one half of the window has check-ins', async () => {
  global.fetch = mockFetch(() => okWith([{ ...ITEM, readiness_early_avg: null }]));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText('Jordan Doe');
  expect(screen.queryByText('rising')).toBeNull();
  expect(screen.queryByText('falling')).toBeNull();
  expect(screen.queryByText('steady')).toBeNull();
});

test('switching the window refetches with the selected window_days', async () => {
  const seenUrls: string[] = [];
  global.fetch = mockFetch((url) => {
    seenUrls.push(url);
    return okWith([ITEM]);
  });

  render(<PerformanceAnalyticsPage />);
  await screen.findByText('Jordan Doe');

  fireEvent.click(screen.getByRole('button', { name: '90 days' }));

  await waitFor(() => {
    expect(seenUrls[seenUrls.length - 1]).toContain('window_days=90');
  });
});

/* ------------------------------------------------------------ the floor --- */

/**
 * This page was the only <table> on any gym-floor route: eight columns, one
 * row per athlete, in whatever order the API returned, with nothing saying
 * which row to read first. The room DNA forbids board tables here and asks for
 * cards by urgency, so what these pin is the order and the reason, not the
 * markup for its own sake -- a card list sorted by nothing is the same table
 * with the lines rubbed out.
 */

const STEADY = { ...ITEM, athlete_id: 'ath-steady', full_name: 'Steady Sam', open_gaps: 0, sessions_total: 3, sessions_completed: 3, active_assignments: 0, avg_assignment_completion: null };
const FALLING = { ...STEADY, athlete_id: 'ath-falling', full_name: 'Falling Fran', readiness_early_avg: 7.5, readiness_late_avg: 6.0 };
const GAPS = { ...STEADY, athlete_id: 'ath-gaps', full_name: 'Gappy Gus', open_gaps: 3 };
const MISSED = { ...STEADY, athlete_id: 'ath-missed', full_name: 'Missed Mo', sessions_total: 5, sessions_completed: 3 };

function cardNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('li')].map(
    (card) => card.querySelector('span')?.textContent ?? '',
  );
}

test('the roster is cards, not a board table', async () => {
  global.fetch = mockFetch(() => okWith([ITEM]));

  const { container } = render(<PerformanceAnalyticsPage />);
  await screen.findByText('Jordan Doe');
  expect(container.querySelector('table')).toBeNull();
  expect(container.querySelectorAll('li')).toHaveLength(1);
});

test('the worst card is first, and the one asking for nothing is last', async () => {
  global.fetch = mockFetch(() => okWith([STEADY, MISSED, GAPS, FALLING]));

  const { container } = render(<PerformanceAnalyticsPage />);
  await screen.findByText('Falling Fran');

  // Readiness falling outranks open gaps outranks a booked session nobody
  // completed; an athlete this window has nothing to say about sorts last.
  expect(cardNames(container)).toEqual(['Falling Fran', 'Gappy Gus', 'Missed Mo', 'Steady Sam']);
});

test('each card says which figure put it where it is', async () => {
  global.fetch = mockFetch(() => okWith([STEADY, GAPS, FALLING, MISSED]));

  render(<PerformanceAnalyticsPage />);
  await screen.findByText('Falling Fran');

  // Law 3: the rung is never colour alone. Every badge carries a glyph and
  // says the reason in words.
  expect(screen.getByText('readiness falling')).toBeTruthy();
  expect(screen.getByText('3 open gaps')).toBeTruthy();
  expect(screen.getByText('2 booked, not completed')).toBeTruthy();
  expect(screen.getByText('Nothing in this window asking for you')).toBeTruthy();
});

test('a rollup never paints the safety gate\'s locked red', async () => {
  // Law 2: saturated colour is a safety/status claim. Arithmetic over session
  // counts and check-ins can say "look here first"; it cannot say "this person
  // may not participate", which is what badge--locked means everywhere else.
  global.fetch = mockFetch(() => okWith([FALLING, GAPS, MISSED, STEADY]));

  const { container } = render(<PerformanceAnalyticsPage />);
  await screen.findByText('Falling Fran');

  expect(container.querySelector('.badge--locked')).toBeNull();
});

test('the same payload always lands in the same order', async () => {
  // A list that reshuffles between two loads of identical data is a list a
  // coach cannot trust to have read.
  global.fetch = mockFetch(() => okWith([GAPS, { ...GAPS, athlete_id: 'ath-gaps-2', full_name: 'Aaron Gaps' }]));

  const first = render(<PerformanceAnalyticsPage />);
  await screen.findByText('Aaron Gaps');
  const order = cardNames(first.container);
  first.unmount();

  const second = render(<PerformanceAnalyticsPage />);
  await screen.findAllByText('Aaron Gaps');
  expect(cardNames(second.container)).toEqual(order);
});

/* ------------------------------------------------- a rollup nobody read --- */

/**
 * This page exists to put the athlete who needs a coach at the top, so its
 * empty state does not read as "no data" -- it reads as "nobody is asking for
 * you". A rollup that failed to load used to render that sentence underneath
 * its own error alert: a screen showing a failure and a contradicting
 * all-clear at the same time, with the all-clear in the larger type.
 */
describe('a rollup nobody could read never reads as "nobody needs you"', () => {
  test('a refused rollup says it could not be read, and does not say the roster is empty', async () => {
    global.fetch = mockFetch(() => ({ ok: false, status: 503, json: async () => ({}) }) as Response);

    render(<PerformanceAnalyticsPage />);

    expect(await screen.findByText('The rollup could not be read')).toBeTruthy();
    // The half that was the defect: the reassuring sentence, gone.
    expect(screen.queryByText('No athletes on your roster')).toBeNull();
  });

  test('a rollup read that throws is treated the same as one the server refused', async () => {
    global.fetch = mockFetch(() => Promise.reject(new Error('Network request failed')));

    render(<PerformanceAnalyticsPage />);

    expect(await screen.findByText('The rollup could not be read')).toBeTruthy();
    expect(screen.queryByText('No athletes on your roster')).toBeNull();
  });

  test('a window that genuinely holds nothing still says so, and does not claim a failure', async () => {
    // Without this, the two tests above are equally satisfied by a page that
    // says "could not be read" on every load -- and a coach who is told that
    // every morning stops reading it.
    global.fetch = mockFetch(() => okWith([]));

    render(<PerformanceAnalyticsPage />);

    expect(await screen.findByText('No athletes on your roster')).toBeTruthy();
    expect(screen.queryByText('The rollup could not be read')).toBeNull();
  });
});

// Session load sits beside Avg RPE, computed by the read (RPE x minutes) and
// labelled unvalidated; its session count says how many sessions it covers,
// and no session with both answers is a dash, never 0.
test('session load shows beside Avg RPE, labelled unvalidated, with its session count', async () => {
  global.fetch = mockFetch(() => okWith([ITEM]));
  render(<PerformanceAnalyticsPage />);

  const label = await screen.findByText('Avg session load (RPE × min, unvalidated)');
  const figure = label.parentElement as HTMLElement;
  expect(figure.textContent).toContain('390');
  expect(figure.textContent).toContain('(4 sessions)');
});

test('no session with both answers reads as a dash, not zero load', async () => {
  global.fetch = mockFetch(() => okWith([{ ...ITEM, avg_session_load: null, session_load_count: 0 }]));
  render(<PerformanceAnalyticsPage />);

  const label = await screen.findByText('Avg session load (RPE × min, unvalidated)');
  expect((label.parentElement as HTMLElement).textContent).toBe('Avg session load (RPE × min, unvalidated)—');
});

// OD-2026-10-08-006 A-Q18: the Coach Operations prototype button is gone; the
// working Progression Intelligence link stays.
test('the footer links Progression Intelligence and no longer links Coach Operations', async () => {
  global.fetch = mockFetch(() => okWith([ITEM]));
  render(<PerformanceAnalyticsPage />);

  await screen.findByText('Jordan Doe');
  expect(screen.getByRole('link', { name: 'Progression Intelligence' }).getAttribute('href')).toBe(
    '/coach/progression-intelligence',
  );
  expect(screen.queryByRole('link', { name: 'Coach Operations' })).toBeNull();
  expect(document.querySelector('a[href="/coach/operations"]')).toBeNull();
});

test('no register for the window reads as a dash, a verified zero reads as 0', async () => {
  global.fetch = mockFetch(() =>
    okWith([
      { ...ITEM, athlete_id: 'a-none', full_name: 'No Register', training_days: 0, training_days_recorded: 0 },
      { ...ITEM, athlete_id: 'a-zero', full_name: 'Marked Absent', training_days: 0, training_days_recorded: 3 },
    ]),
  );
  render(<PerformanceAnalyticsPage />);

  await screen.findByText('No Register');
  const labels = screen.getAllByText('Training days');
  const texts = labels.map((l) => (l.parentElement as HTMLElement).textContent);
  expect([...texts].sort()).toEqual(['Training days0', 'Training days—']);
});

test('the 28-day attendance figures say their source, their denominator and their own dates; none reads as a dash', async () => {
  global.fetch = mockFetch(() =>
    okWith([
      {
        ...ITEM,
        attendance_28d: {
          athlete_id: 'ath-1', window_from: '2026-09-21', window_to: '2026-10-18', days_present: 3, days_absent: 1,
          days_excused: 0, attendance_rate: 0.75, last_present_day: '2026-10-06', days_since_last_present: 12,
        },
      },
      { ...ITEM, athlete_id: 'a-none', full_name: 'No Window', attendance_28d: null },
    ]),
  );
  render(<PerformanceAnalyticsPage />);

  await screen.findByText('No Window');
  const attendance = screen.getAllByText('Attendance, last 28 days').map((l) => (l.parentElement as HTMLElement).textContent);
  expect([...attendance].sort()).toEqual([
    'Attendance, last 28 days75% (present 3 of 4 days marked on the class register)(9/21/2026 to 10/18/2026)',
    'Attendance, last 28 days—',
  ]);
  const last = screen.getAllByText('Last marked present').map((l) => (l.parentElement as HTMLElement).textContent);
  expect([...last].sort()).toEqual([
    'Last marked presentLast marked present on the class register 12 days ago (10/6/2026)',
    'Last marked present—',
  ]);
});

describe('rest or away marks on the card (lane R6-b1, OD-2026-11-17-004)', () => {
  const WEEKS = [
    { week_index: 0, first_day: '2026-11-13', last_day: '2026-11-19' },
    { week_index: 1, first_day: '2026-11-06', last_day: '2026-11-12' },
    { week_index: 2, first_day: '2026-10-30', last_day: '2026-11-05' },
    { week_index: 3, first_day: '2026-10-23', last_day: '2026-10-29' },
    { week_index: 4, first_day: '2026-10-16', last_day: '2026-10-22' },
  ];
  const MARK_ID = '4f9d2c1e-6b3a-4e8f-9c2d-1a2b3c4d5e6f';
  const marksWith = (marks: unknown[]) =>
    ({ ok: true, json: async () => ({ ok: true, today: '2026-11-19', kinds: ['rest', 'away'], weeks: WEEKS, marks, coverage: [] }) }) as Response;

  type Call = { url: string; init?: RequestInit };
  function routed(marks: () => unknown[], calls: Call[], write?: () => Response) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/api/pilot/coach/rest-marks')) {
        if (init?.method === 'POST' || init?.method === 'DELETE') {
          return write ? write() : ({ ok: true, json: async () => ({ ok: true }) } as Response);
        }
        return marksWith(marks());
      }
      return okWith([ITEM]);
    }) as unknown as typeof fetch;
  }

  test('five load weeks, each with one-tap Rest and Away; nothing that could take a reason', async () => {
    const calls: Call[] = [];
    global.fetch = routed(() => [], calls);
    render(<PerformanceAnalyticsPage />);
    await screen.findByText('Last 7 days');
    expect(screen.getByText('4 weeks before')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Rest' })).toHaveLength(6); // 5 weeks + the days form
    expect(screen.getAllByRole('button', { name: 'Away' })).toHaveLength(6);
    const section = screen.getByRole('region', { name: 'Rest or away, by load week' });
    expect(section.querySelector('textarea')).toBeNull();
    expect(section.querySelectorAll('input:not([type="date"])')).toHaveLength(0);
    expect(section.textContent).toMatch(/no reason recorded/);
  });

  test('one tap on Rest sends exactly the four fields, then reads the marks again', async () => {
    const calls: Call[] = [];
    let marks: unknown[] = [];
    global.fetch = routed(() => marks, calls, () => {
      marks = [{ mark_id: MARK_ID, athlete_id: 'ath-1', kind: 'rest', first_day: '2026-11-13', last_day: '2026-11-19' }];
      return { ok: true, status: 201, json: async () => ({ ok: true }) } as Response;
    });
    render(<PerformanceAnalyticsPage />);
    await screen.findByText('Last 7 days');
    fireEvent.click(screen.getAllByRole('button', { name: 'Rest' })[0]);

    await screen.findByText(/Rest marked/);
    const post = calls.find((call) => call.init?.method === 'POST');
    expect(JSON.parse(String(post!.init!.body))).toEqual({
      athlete_id: 'ath-1', kind: 'rest', first_day: '2026-11-13', last_day: '2026-11-19',
    });
    // A marked week is a word with a glyph and Undo; no load figure, no zero.
    const row = screen.getByText(/Rest marked/).closest('li')!;
    expect(row.textContent).not.toMatch(/\b0\b/);
    expect(row.querySelector('i')?.textContent).toBe('—');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  test('Undo sends the two ids in the query and no body', async () => {
    const calls: Call[] = [];
    global.fetch = routed(
      () => [{ mark_id: MARK_ID, athlete_id: 'ath-1', kind: 'away', first_day: '2026-11-06', last_day: '2026-11-12' }],
      calls,
    );
    render(<PerformanceAnalyticsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(true));
    const del = calls.find((call) => call.init?.method === 'DELETE')!;
    expect(del.url).toContain(`?athlete_id=ath-1&mark_id=${MARK_ID}`);
    expect(del.init!.body).toBeUndefined();
    expect(screen.getByText(/Away marked/)).toBeTruthy();
  });

  test('a marks read that fails says so, and the rollup stays on screen', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) =>
      String(input).includes('rest-marks') ? ({ ok: false, status: 503, json: async () => ({}) } as Response) : okWith([ITEM]),
    ) as unknown as typeof fetch;
    render(<PerformanceAnalyticsPage />);
    await screen.findByText(/Rest and away marks could not be loaded. This is not a statement that none are recorded./);
    expect(screen.getByText('Jordan Doe')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rest' })).toBeNull();
  });

  test("a refused tap shows the server's words", async () => {
    const calls: Call[] = [];
    global.fetch = routed(() => [], calls, () =>
      ({ ok: false, status: 403, json: async () => ({ error: 'This account may not record or read rest marks for this athlete.' }) }) as Response);
    render(<PerformanceAnalyticsPage />);
    await screen.findByText('Last 7 days');
    fireEvent.click(screen.getAllByRole('button', { name: 'Away' })[0]);
    expect((await screen.findByRole('alert')).textContent).toMatch(/may not record or read rest marks/);
  });
});

describe('rest or away marks: reviewer B fixes', () => {
  const WEEKS = [
    { week_index: 0, first_day: '2026-11-13', last_day: '2026-11-19' },
    { week_index: 1, first_day: '2026-11-06', last_day: '2026-11-12' },
    { week_index: 2, first_day: '2026-10-30', last_day: '2026-11-05' },
    { week_index: 3, first_day: '2026-10-23', last_day: '2026-10-29' },
    { week_index: 4, first_day: '2026-10-16', last_day: '2026-10-22' },
  ];
  const A_MARK = { mark_id: '11111111-1111-4111-8111-111111111111', athlete_id: 'ath-1', kind: 'rest', first_day: '2026-11-13', last_day: '2026-11-19' };
  const B_MARK = { mark_id: '22222222-2222-4222-8222-222222222222', athlete_id: 'ath-2', kind: 'away', first_day: '2026-11-13', last_day: '2026-11-19' };
  const marksWith = (marks: unknown[]) =>
    ({ ok: true, json: async () => ({ ok: true, today: '2026-11-19', kinds: ['rest', 'away'], weeks: WEEKS, marks, coverage: [] }) }) as Response;
  const SECOND = { ...ITEM, athlete_id: 'ath-2', full_name: 'Sam Roe', open_gaps: 0, readiness_early_avg: null, readiness_late_avg: null };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  test('a holiday marked ahead of time shows under "Marked ahead" and can be undone', async () => {
    const ahead = { mark_id: '33333333-3333-4333-8333-333333333333', athlete_id: 'ath-1', kind: 'away', first_day: '2026-12-01', last_day: '2026-12-05' };
    global.fetch = jest.fn(async (input: RequestInfo | URL) =>
      String(input).includes('rest-marks') ? marksWith([ahead]) : okWith([ITEM]),
    ) as unknown as typeof fetch;
    render(<PerformanceAnalyticsPage />);
    const row = (await screen.findByText('Marked ahead')).closest('li')!;
    expect(row.textContent).toMatch(/Away marked, Dec 1 – Dec 5/);
    expect(row.querySelector('button')?.textContent).toBe('Undo');
    // No load week holds it: all five weeks still offer one-tap Rest.
    expect(screen.getAllByRole('button', { name: 'Rest' })).toHaveLength(6);
  });

  test("an older marks reply arriving after a newer one is dropped, so it cannot hide the newer mark", async () => {
    const reads: Array<ReturnType<typeof deferred<Response>>> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('rest-marks')) return okWith([ITEM, SECOND]);
      if (init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ ok: true }) } as Response;
      const read = deferred<Response>();
      reads.push(read);
      return read.promise;
    }) as unknown as typeof fetch;

    render(<PerformanceAnalyticsPage />);
    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0].resolve(marksWith([]));
    await screen.findAllByText('Last 7 days');

    const [restA] = screen.getAllByRole('button', { name: 'Rest' });
    fireEvent.click(restA); // athlete A (first card)
    await waitFor(() => expect(reads).toHaveLength(2));
    const awayB = screen.getAllByRole('button', { name: 'Away' })[6]; // athlete B's week 0 (A has 6 Away buttons)
    fireEvent.click(awayB);
    await waitFor(() => expect(reads).toHaveLength(3));

    // The newer read (after both taps) lands first, then the older one.
    reads[2].resolve(marksWith([A_MARK, B_MARK]));
    await screen.findByText(/Away marked/);
    // Let the older reply fully land before looking (reviewer B: a bare
    // waitFor passed before it reached the screen).
    await act(async () => {
      reads[1].resolve(marksWith([A_MARK]));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText(/Away marked/)).toBeTruthy();
    expect(screen.getByText(/Rest marked/)).toBeTruthy();
  });

  test('after a tap the buttons stay off until the strip shows the new mark', async () => {
    const reads: Array<ReturnType<typeof deferred<Response>>> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('rest-marks')) return okWith([ITEM]);
      if (init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ ok: true }) } as Response;
      const read = deferred<Response>();
      reads.push(read);
      return read.promise;
    }) as unknown as typeof fetch;
    render(<PerformanceAnalyticsPage />);
    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0].resolve(marksWith([]));
    await screen.findByText('Last 7 days');

    fireEvent.click(screen.getAllByRole('button', { name: 'Rest' })[0]);
    await waitFor(() => expect(reads).toHaveLength(2));
    // Saved, but the re-read has not landed: no second tap is possible.
    for (const button of screen.getAllByRole('button', { name: /^(Rest|Away)$/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    reads[1].resolve(marksWith([A_MARK]));
    await screen.findByText(/Rest marked/);
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('a mark starting today shows once, in the last 7 days, not under "Marked ahead"', async () => {
    const today = { mark_id: '44444444-4444-4444-8444-444444444444', athlete_id: 'ath-1', kind: 'rest', first_day: '2026-11-19', last_day: '2026-11-25' };
    global.fetch = jest.fn(async (input: RequestInfo | URL) =>
      String(input).includes('rest-marks') ? marksWith([today]) : okWith([ITEM]),
    ) as unknown as typeof fetch;
    render(<PerformanceAnalyticsPage />);
    const badges = await screen.findAllByText(/Rest marked, Nov 19 – Nov 25/);
    expect(badges).toHaveLength(1);
    expect(badges[0].closest('li')!.textContent).toMatch(/Last 7 days/);
    expect(screen.queryByText('Marked ahead')).toBeNull();
  });

  test("with taps on two athletes, the first athlete's buttons stay off until the newest read lands", async () => {
    const reads: Array<ReturnType<typeof deferred<Response>>> = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('rest-marks')) return okWith([ITEM, SECOND]);
      if (init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ ok: true }) } as Response;
      const read = deferred<Response>();
      reads.push(read);
      return read.promise;
    }) as unknown as typeof fetch;
    render(<PerformanceAnalyticsPage />);
    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0].resolve(marksWith([]));
    await screen.findAllByText('Last 7 days');

    fireEvent.click(screen.getAllByRole('button', { name: 'Rest' })[0]); // athlete A
    await waitFor(() => expect(reads).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Away' })[6]); // athlete B
    await waitFor(() => expect(reads).toHaveLength(3));

    // A's own read lands first (and is dropped as older): A's buttons must stay off.
    await act(async () => {
      reads[1].resolve(marksWith([A_MARK]));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const firstCard = screen.getAllByRole('region', { name: 'Rest or away, by load week' })[0];
    for (const button of Array.from(firstCard.querySelectorAll('button'))) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => {
      reads[2].resolve(marksWith([A_MARK, B_MARK]));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect((firstCard.querySelector('button') as HTMLButtonElement).textContent).toBe('Undo');
    expect((firstCard.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
  });
});

// Lane R6-b2 (OD-2026-11-17-004): each week's completeness, and the guard
// that no week that is not logged ever shows a load figure or a zero.
describe('week status and rated share on the strip (lane R6-b2)', () => {
  const WEEKS = [
    { week_index: 0, first_day: '2026-11-13', last_day: '2026-11-19' },
    { week_index: 1, first_day: '2026-11-06', last_day: '2026-11-12' },
    { week_index: 2, first_day: '2026-10-30', last_day: '2026-11-05' },
    { week_index: 3, first_day: '2026-10-23', last_day: '2026-10-29' },
    { week_index: 4, first_day: '2026-10-16', last_day: '2026-10-22' },
  ];
  const COVERAGE = [
    { athlete_id: 'ath-1', week_index: 0, attended: 4, rated: 3, marked_days: 0, status: 'logged' },
    { athlete_id: 'ath-1', week_index: 1, attended: 4, rated: 2, marked_days: 0, status: 'partly_logged' },
    { athlete_id: 'ath-1', week_index: 2, attended: 0, rated: 0, marked_days: 7, status: 'rest_marked' },
    { athlete_id: 'ath-1', week_index: 3, attended: 0, rated: 0, marked_days: 0, status: 'not_logged' },
  ];
  const REST_MARK = { mark_id: '55555555-5555-4555-8555-555555555555', athlete_id: 'ath-1', kind: 'rest', first_day: '2026-10-30', last_day: '2026-11-05' };
  const respond = (coverage: unknown) =>
    jest.fn(async (input: RequestInfo | URL) =>
      String(input).includes('rest-marks')
        ? ({ ok: true, json: async () => ({ ok: true, today: '2026-11-19', kinds: ['rest', 'away'], weeks: WEEKS, marks: [REST_MARK], coverage }) } as Response)
        : okWith([ITEM]),
    ) as unknown as typeof fetch;

  function rowOf(label: string): HTMLElement {
    return screen.getByText(label).closest('li') as HTMLElement;
  }

  test('each week says its status in a word and a glyph, with "N of M rated" or "no sessions"', async () => {
    global.fetch = respond(COVERAGE);
    render(<PerformanceAnalyticsPage />);
    await screen.findByText('Last 7 days');
    const status = (label: string) => rowOf(label).querySelector('[data-week-status]') as HTMLElement;

    expect(status('Last 7 days').textContent).toBe('✓ Logged · 3 of 4 rated');
    expect(status('1 week before').textContent).toBe('◐ Partly logged · 2 of 4 rated');
    expect(status('2 weeks before').textContent).toBe('— Rest (marked) · no sessions');
    expect(status('3 weeks before').textContent).toBe('? Not logged · no sessions');
    // No coverage row for the week: said, not guessed.
    expect(status('4 weeks before').textContent).toBe('Status not read');
    // Every status carries a glyph as well as its word.
    for (const label of ['Last 7 days', '1 week before', '2 weeks before', '3 weeks before']) {
      expect(status(label).querySelector('i')?.textContent).toMatch(/\S/);
    }
  });

  test('GUARD: a week that is not logged shows no load figure and no zero, anywhere in its row', async () => {
    global.fetch = respond(COVERAGE);
    render(<PerformanceAnalyticsPage />);
    await screen.findByText('Last 7 days');
    for (const label of ['2 weeks before', '3 weeks before', '4 weeks before']) {
      const text = rowOf(label).textContent ?? '';
      // Strip the row's label ("2 weeks before") and dates ("Oct 30 – Nov 5"); nothing numeric may remain.
      const withoutDates = text.replace(label, '').replace(/[A-Z][a-z]{2} \d{1,2}/g, '');
      expect(withoutDates).not.toMatch(/\d/);
      expect(text.toLowerCase()).not.toMatch(/load|rpe|×|\bx\b/);
    }
    // The partly logged week shows counts of sessions, never a load.
    expect(rowOf('1 week before').textContent?.toLowerCase()).not.toMatch(/load|rpe|×/);
  });

  test('a response without coverage is treated as unread, not as weeks with nothing in them', async () => {
    global.fetch = respond(undefined);
    render(<PerformanceAnalyticsPage />);
    await screen.findByText(/Rest and away marks could not be loaded. This is not a statement that none are recorded./);
    expect(screen.queryByText(/Not logged/)).toBeNull();
  });

  test('coverage null (the server could not read the statuses): marking still works and every week says "Status not read"', async () => {
    global.fetch = respond(null);
    render(<PerformanceAnalyticsPage />);
    await screen.findByText('Last 7 days');
    const statuses = Array.from(document.querySelectorAll('[data-week-status]')).map((el) => el.textContent);
    expect(statuses).toEqual(Array(5).fill('Status not read'));
    expect(screen.getAllByRole('button', { name: 'Rest' }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Rest marked/)).toBeTruthy();
    expect(screen.queryByText(/Not logged|no sessions/)).toBeNull();
  });
});
