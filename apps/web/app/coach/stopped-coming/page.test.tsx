/**
 * @jest-environment jsdom
 */

// Stopped Coming -- the page over `/api/pilot/stopped-coming` (lane W4-6,
// SC-2). What these pin: rows render in the order the server sent them
// (longest gone first is the server's), with the last day they came and the
// days since; the gym's number reads in weeks, and says whether it is the
// default; the empty state says what was checked and who was not; a refused
// role gets a stamp, not an error banner (Law 7); a genuine failure admits
// athletes may be missing; "Open passbook" hands the athlete over in page
// memory; and the page shows no attendance figure.
//
// The "reached out" mark (SC-3b; OW27-33 B, Q4 A): "Mark reached out" sends PUT
// with exactly { athlete_id, reached_out } and then reads the list again, so a
// row shows the server's mark, never one set by the press; "Take back mark" is
// sent only while a fresh read still shows the mark the row showed; a marker
// the server cannot name is not named; a refusal is a stamp that stays until
// the next press; each outcome is announced and said only once it is true; and
// the buttons wait (aria-disabled, one PUT) while a request is on its way.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { PASSBOOK_PAGE } from '@/components/athleteRecordPages';
import { takeArrivalAthlete } from '@/components/decisionLoopArrival';
import { formatCalendarDay } from '@/lib/calendarDay';
import CoachStoppedComingPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/components/ClusterNav', () => ({
  __esModule: true,
  default: ({ cluster }: { cluster: string }) => <nav data-cluster={cluster} />,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className, onClick, 'aria-label': ariaLabel }: {
    readonly children: React.ReactNode;
    readonly href: string;
    readonly className?: string;
    readonly onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
    readonly 'aria-label'?: string;
  }) => (
    <a href={href} className={className} aria-label={ariaLabel} onClick={(event) => { event.preventDefault(); onClick?.(event); }}>{children}</a>
  ),
}));

// Shaped exactly like StoppedComingList in src/server/pilot/stoppedComing.ts.
const LIST = {
  gap_days: 14,
  is_default: true,
  // A day that is not the real date, so a page that printed the browser's day would show it.
  today: '2026-03-10',
  // Longest gone first, and NOT in name order, so a page that re-sorted by name would show it.
  athletes: [
    { athlete_id: 'ath-2', full_name: 'Rosa D.', last_came_day: '2026-02-08', days_since_came: 30, reached_out: null },
    { athlete_id: 'ath-1', full_name: 'Jordan P.', last_came_day: '2026-02-24', days_since_came: 14, reached_out: null },
  ],
};

// Synthetic staff names only (public repository).
const MARK = { by_name: 'Coach Ana T.', on_day: '2026-03-09' };

/** LIST with the first row (Rosa D., ath-2) carrying `mark`. */
const firstMarked = (mark: unknown) => ({
  ...LIST,
  athletes: LIST.athletes.map((athlete, index) => (index === 0 ? { ...athlete, reached_out: mark } : athlete)),
});

type Reply = { status?: number; body?: unknown } | 'network';

/** Answers each request in turn (the read, the PUT, the read again); a promise holds its answer until resolved. */
function scriptedFetch(...replies: Array<Reply | Promise<Reply>>) {
  const queue = [...replies];
  return jest.fn(async () => {
    const reply = await queue.shift();
    if (reply === undefined) throw new Error('no reply scripted for this request');
    if (reply === 'network') throw new TypeError('Failed to fetch');
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => reply.body };
  }) as unknown as typeof fetch;
}

const requests = (fetchImpl: typeof fetch) =>
  (fetchImpl as jest.Mock).mock.calls as Array<[string, RequestInit | undefined]>;

const puts = (fetchImpl: typeof fetch) => requests(fetchImpl).filter(([, init]) => init?.method === 'PUT');

const markButton = (row: HTMLElement) => within(row).getByRole('button') as HTMLButtonElement;

async function press(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
  });
}

function mockFetch(options: { body?: unknown; status?: number; badJson?: boolean }) {
  const status = options.status ?? 200;
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (options.badJson) throw new SyntaxError("Unexpected token '<'");
      return options.body ?? LIST;
    },
  })) as unknown as typeof fetch;
}

const READ_FAILED = 'Could not read who has stopped coming, so no one is shown. This is not an empty list.';

async function renderPage(fetchImpl: typeof fetch) {
  global.fetch = fetchImpl;
  await act(async () => {
    render(<CoachStoppedComingPage />);
  });
}

const pageText = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

afterEach(() => {
  jest.restoreAllMocks();
  takeArrivalAthlete(PASSBOOK_PAGE);
});

test('reads the stopped-coming route with the session cookie, and is titled for its door', async () => {
  const fetchImpl = mockFetch({});
  await renderPage(fetchImpl);
  expect((fetchImpl as jest.Mock).mock.calls[0][0]).toMatch(/\/api\/pilot\/stopped-coming$/);
  expect((fetchImpl as jest.Mock).mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Stopped Coming');
  expect(document.querySelector('nav[data-cluster="who-needs-me"]')).not.toBeNull();
});

test('rows come in the server\'s order, with the last day they came and the days since', async () => {
  await renderPage(mockFetch({}));
  const rows = screen.getAllByRole('listitem');
  expect(rows.map((row) => within(row).getByText(/\./).textContent)).toEqual(['Rosa D.', 'Jordan P.']);
  expect(within(rows[0]).getByText(formatCalendarDay('2026-02-08'))).toBeTruthy();
  expect(within(rows[0]).getByText('30')).toBeTruthy();
  expect(within(rows[1]).getByText(formatCalendarDay('2026-02-24'))).toBeTruthy();
  expect(within(rows[1]).getByText('14')).toBeTruthy();
  expect(within(rows[0]).getByText('Last came')).toBeTruthy();
  expect(within(rows[0]).getByText('Days since')).toBeTruthy();
});

test('the gym\'s number reads in weeks, and says when it is the default', async () => {
  await renderPage(mockFetch({}));
  expect(pageText()).toContain('have not come for 2 weeks or more, longest gone first');
  expect(pageText()).toContain('The gym has not set its own number of days, so the default, 2 weeks, applies.');
  expect(pageText()).toContain(`As of ${formatCalendarDay('2026-03-10')}.`);
});

test('one week reads as "1 week" and "the last week"', async () => {
  await renderPage(mockFetch({ body: { ...LIST, gap_days: 7, is_default: false, athletes: [] } }));
  expect(pageText()).toContain('have not come for 1 week or more');
  expect(pageText()).toContain('No one this list covers has gone 1 week without coming');
  expect(pageText()).toContain('came within the last week.');
});

test('a number the gym set is said to be the gym\'s own', async () => {
  await renderPage(mockFetch({ body: { ...LIST, gap_days: 42, is_default: false } }));
  expect(pageText()).toContain('have not come for 6 weeks or more');
  expect(pageText()).toContain('6 weeks is the gym’s own setting.');
  expect(pageText()).not.toContain('default');
});

test('"Open passbook" hands each row\'s own athlete to the Passbook in page memory, not the address', async () => {
  await renderPage(mockFetch({}));
  const rows = screen.getAllByRole('listitem');
  const first = within(rows[0]).getByText('Open passbook');
  expect(first.getAttribute('href')).toBe('/coach/passbook');
  expect(first.getAttribute('aria-label')).toBe('Open passbook: Rosa D.');
  fireEvent.click(first);
  expect(takeArrivalAthlete(PASSBOOK_PAGE)).toBe('ath-2');
  const second = within(rows[1]).getByText('Open passbook');
  expect(second.getAttribute('aria-label')).toBe('Open passbook: Jordan P.');
  fireEvent.click(second);
  expect(takeArrivalAthlete(PASSBOOK_PAGE)).toBe('ath-1');
});

test('an empty list says what was checked, and who is not on it, never that nobody is slipping', async () => {
  await renderPage(mockFetch({ body: { ...LIST, athletes: [] } }));
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  expect(pageText()).toContain('No one this list covers has gone 2 weeks without coming');
  expect(pageText()).toContain('Every athlete this list covers came within the last 2 weeks.');
  // Who it does not cover (App Overwatch on #2172 for the memberships); no membership status is shown.
  expect(pageText()).toContain(
    'It does not cover athletes who have never come, athletes marked as left the gym, or athletes whose program memberships have all lapsed or ended.',
  );
});

test.each([
  [401, 'signed_out', 'sign in again to read who has stopped coming'],
  [403, 'wrong_door', 'who has stopped coming is read by a coach or the gym admin of this gym'],
])('a refused read (%i) is the %s stamp, not an error banner, and shows no rows', async (status, kind, detail) => {
  await renderPage(mockFetch({ status }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  expect(document.querySelector('[data-refusal-stamp]')?.getAttribute('data-refusal-stamp')).toBe(kind);
  expect(pageText()).toContain(detail);
});

test.each([
  ['a server error', () => mockFetch({ status: 500 })],
  ['a network failure', () => jest.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch],
  ['an answer that is not JSON', () => mockFetch({ badJson: true })],
  ['an answer of the wrong shape', () => mockFetch({ body: { ok: true } })],
])('%s shows one fixed sentence, never an empty list or the raw error', async (_label, make) => {
  await renderPage(make());
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('Failed');
  expect(alert.textContent).toContain(READ_FAILED);
  expect(alert.textContent).not.toMatch(/Failed to fetch|Unexpected token|TypeError/);
  expect(pageText()).not.toContain('No one this list covers');
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
});

test('the page shows no attendance figure or rate', async () => {
  await renderPage(mockFetch({}));
  expect(pageText()).not.toMatch(/attendance|%/i);
});

test('a listed athlete shows no membership status (App Overwatch on #2172: membership records stay admin-only)', async () => {
  await renderPage(mockFetch({}));
  const rows = screen.getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  // A row on this list has an active membership or none, so "active" is the status a row could show; a
  // membership record also holds the scholarship and the program, and payment is the membership slot's.
  for (const row of rows) {
    expect(row.textContent).not.toMatch(/member|status|active|lapsed|ended|program|enrol|scholarship|discount|paid|fee/i);
  }
  // And above a list that has rows, the empty state's sentences are not shown.
  expect(pageText()).not.toContain('No one this list covers');
  expect(pageText()).not.toContain('It does not cover');
});

test('the intro says who the list leaves out, as a rule, above any list', async () => {
  await renderPage(mockFetch({}));
  const intro = screen.getByText(/It leaves out athletes marked as left the gym/);
  expect(intro.textContent?.replace(/\s+/g, ' ')).toContain(
    'It leaves out athletes marked as left the gym and athletes whose program memberships have all lapsed or ended.',
  );
  // Above the list: the sentence comes before the first row in the document.
  const firstRow = screen.getAllByRole('listitem')[0];
  expect(intro.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test.each([
  [7, '1 week', 'the last week'],
  [14, '2 weeks', 'the last 2 weeks'],
  [21, '3 weeks', 'the last 3 weeks'],
  [28, '4 weeks', 'the last 4 weeks'],
  [42, '6 weeks', 'the last 6 weeks'],
  [56, '8 weeks', 'the last 8 weeks'],
])('the empty state at %i days says what it covers, whoever set the number', async (gapDays, gap, within) => {
  for (const isDefault of [true, false]) {
    cleanup();
    await renderPage(mockFetch({ body: { ...LIST, gap_days: gapDays, is_default: isDefault, athletes: [] } }));
    expect(pageText()).toContain(
      `No one this list covers has gone ${gap} without coming`
      + `Every athlete this list covers came within ${within}. It does not cover athletes who have never come, `
      + 'athletes marked as left the gym, or athletes whose program memberships have all lapsed or ended.',
    );
  }
});

describe('the "reached out" mark', () => {
  /** The page's one persistent announcer (not RefusalStamp's own role="status"). */
  const announced = () => document.querySelector('p.sr-only[role="status"]')?.textContent ?? null;
  const row = (index: number) => screen.getAllByRole('listitem')[index];

  test('an unmarked row shows one "Mark reached out" button, no toggle state, and only its name and day', async () => {
    await renderPage(mockFetch({}));
    for (const listed of screen.getAllByRole('listitem')) {
      expect(markButton(listed).textContent).toBe('Mark reached out');
      expect(markButton(listed).hasAttribute('aria-pressed')).toBe(false);
      expect(listed.textContent).not.toMatch(/Reached out (by|on)/);
      // No id leaves the row: the athlete is named, never numbered.
      expect(listed.textContent).not.toMatch(/ath-\d/);
    }
    expect(markButton(row(0)).getAttribute('aria-label')).toBe('Mark reached out: Rosa D.');
    expect(announced()).toBe('');
  });

  test('pressing it sends PUT with exactly { athlete_id, reached_out: true }, then shows what a fresh read says', async () => {
    const fetchImpl = scriptedFetch({ body: LIST }, { body: { ok: true, outcome: 'marked' } }, { body: firstMarked(MARK) });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(requests(fetchImpl)).toHaveLength(3));
    const [url, init] = requests(fetchImpl)[1];
    expect(url).toMatch(/\/api\/pilot\/stopped-coming$/);
    expect(init).toMatchObject({ method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(init?.body))).toStrictEqual({ athlete_id: 'ath-2', reached_out: true });
    // The third request is the list read again (a GET), and the row shows that answer: the name
    // and the day come only from it, so a row marked by the press itself would not have them.
    expect(requests(fetchImpl)[2][1]?.method).toBeUndefined();
    await waitFor(() => expect(markButton(row(0)).textContent).toBe('Take back mark'));
    expect(row(0).textContent).toContain(`Reached out by Coach Ana T. on ${formatCalendarDay('2026-03-09')}.`);
    expect(row(0).textContent).not.toMatch(/ath-\d/);
    expect(markButton(row(1)).textContent).toBe('Mark reached out');
    expect(announced()).toBe('Rosa D. is marked as reached out.');
  });

  test('"already_marked" (another coach got there first): the fresh read shows their mark, and nothing is refused', async () => {
    const theirs = { by_name: 'Coach Bo R.', on_day: '2026-03-08' };
    const fetchImpl = scriptedFetch({ body: LIST }, { body: { ok: true, outcome: 'already_marked' } }, { body: firstMarked(theirs) });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(row(0).textContent).toContain(`Reached out by Coach Bo R. on ${formatCalendarDay('2026-03-08')}.`));
    expect(announced()).toBe('Rosa D. was already marked as reached out, so nothing new was saved.');
    expect(document.querySelector('[data-refusal-stamp]')).toBeNull();
    expect(document.querySelector('.alert')).toBeNull();
  });

  test('"Take back mark" reads the list first, sends reached_out: false while the mark is the one shown, and says so', async () => {
    const fetchImpl = scriptedFetch(
      { body: firstMarked(MARK) },
      { body: firstMarked(MARK) },
      { body: { ok: true, outcome: 'taken_back' } },
      { body: LIST },
    );
    await renderPage(fetchImpl);
    expect(row(0).textContent).toContain(`Reached out by Coach Ana T. on ${formatCalendarDay('2026-03-09')}.`);
    expect(markButton(row(0)).textContent).toBe('Take back mark');
    expect(markButton(row(0)).getAttribute('aria-label')).toBe('Take back mark: Rosa D.');
    expect(markButton(row(0)).hasAttribute('aria-pressed')).toBe(false);

    await press(markButton(row(0)));
    await waitFor(() => expect(requests(fetchImpl)).toHaveLength(4));
    expect(requests(fetchImpl).map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'GET', 'PUT', 'GET']);
    expect(JSON.parse(String(requests(fetchImpl)[2][1]?.body))).toStrictEqual({ athlete_id: 'ath-2', reached_out: false });
    // Taken back, by the fresh read: the row stays on the list, unmarked.
    await waitFor(() => expect(markButton(row(0)).textContent).toBe('Mark reached out'));
    expect(row(0).textContent).not.toMatch(/Reached out (by|on)/);
    expect(announced()).toBe('The mark on Rosa D. was taken back.');
    expect(pageText()).toContain('The mark on Rosa D. was taken back.');
  });

  test.each([
    ['another coach\'s mark', { by_name: 'Coach Bo R.', on_day: '2026-03-09' }],
    ['a mark of another day', { by_name: 'Coach Ana T.', on_day: '2026-03-10' }],
    ['no mark', null],
  ])('a take-back whose fresh read shows %s sends nothing, and shows the list as it is', async (_label, now) => {
    const fetchImpl = scriptedFetch({ body: firstMarked(MARK) }, { body: firstMarked(now) });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(announced()).toBe('The mark on Rosa D. has changed since it was shown, so nothing was taken back.'));
    expect(puts(fetchImpl)).toHaveLength(0);
    expect(row(0).textContent).toContain(now ? `on ${formatCalendarDay(now.on_day)}` : '');
    expect(markButton(row(0)).textContent).toBe(now ? 'Take back mark' : 'Mark reached out');
  });

  test('a take-back for an athlete the fresh read no longer lists sends nothing', async () => {
    const fetchImpl = scriptedFetch({ body: firstMarked(MARK) }, { body: { ...LIST, athletes: [LIST.athletes[1]] } });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(announced()).toBe('Rosa D. is no longer on the stopped-coming list, so nothing was taken back.'));
    expect(puts(fetchImpl)).toHaveLength(0);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  test('a take-back whose first read fails sends nothing, and says the list could not be read', async () => {
    const fetchImpl = scriptedFetch({ body: firstMarked(MARK) }, { status: 500, body: {} });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(announced()).toBe('The mark on Rosa D. could not be checked, so nothing was taken back.'));
    expect(puts(fetchImpl)).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain(READ_FAILED);
  });

  test.each([
    ['null', null],
    ['blank', '  '],
  ])('a marker the server cannot name (%s) is not named, and the row says who marked it cannot be shown', async (_label, byName) => {
    await renderPage(mockFetch({ body: firstMarked({ by_name: byName, on_day: '2026-03-09' }) }));
    expect(row(0).textContent).toContain(`Reached out on ${formatCalendarDay('2026-03-09')}; who marked it cannot be shown.`);
    // No stand-in name in its place.
    expect(row(0).textContent).not.toMatch(/Reached out by|null|undefined|unknown|your coach|a coach|staff/i);
    expect(markButton(row(0)).textContent).toBe('Take back mark');
  });

  test('a 409 (no longer on the list) is a refusal stamp, and the list is read again', async () => {
    const fetchImpl = scriptedFetch(
      { body: LIST },
      {
        status: 409,
        body: { error: 'This athlete is not on the stopped-coming list now. Reload the page.', code: 'NOT_ON_STOPPED_COMING_LIST' },
      },
      { body: { ...LIST, athletes: [LIST.athletes[1]] } },
    );
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(requests(fetchImpl)[2][1]?.method).toBeUndefined();
    const stamp = document.querySelector('[data-refusal-stamp="cannot_be_done"]') as HTMLElement;
    // Words, not colour alone (Law 3), and nothing on it to dismiss it.
    expect(stamp.textContent).toContain('CANNOT BE DONE');
    expect(stamp.textContent).toContain('Rosa D. is no longer on the stopped-coming list, so nothing was marked.');
    expect(within(stamp).queryByRole('button')).toBeNull();
    // The stamp is its own role="status" and carries the words; the page's status line stays empty,
    // so they are not read out twice.
    expect(stamp.getAttribute('role')).toBe('status');
    expect(announced()).toBe('');
    expect(pageText()).not.toMatch(/Reload the page|read again/);
    expect(row(0).textContent).toContain('Jordan P.');
  });

  test('a refusal stays on screen as time passes, and clears on the next press', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = scriptedFetch(
        { body: LIST },
        { status: 409, body: { code: 'NOT_ON_STOPPED_COMING_LIST' } },
        { body: { ...LIST, athletes: [LIST.athletes[1]] } },
        { body: { ok: true, outcome: 'marked' } },
        { body: { ...LIST, athletes: [{ ...LIST.athletes[1], reached_out: MARK }] } },
      );
      await renderPage(fetchImpl);
      await press(markButton(row(0)));
      await waitFor(() => expect(document.querySelector('[data-refusal-stamp="cannot_be_done"]')).not.toBeNull());

      await act(async () => {
        jest.advanceTimersByTime(60 * 60 * 1000);
      });
      expect(document.querySelector('[data-refusal-stamp="cannot_be_done"]')).not.toBeNull();

      await press(markButton(row(0)));
      await waitFor(() => expect(announced()).toBe('Jordan P. is marked as reached out.'));
      expect(document.querySelector('[data-refusal-stamp]')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    ['REACHED_OUT_MARK_CHANGED', 409, 'the mark on Rosa D. changed while it was being saved, so nothing was saved; try again.'],
    ['a 404', 404, 'Rosa D. was not found in this gym, so nothing was saved.'],
    ['a 400', 400, 'the server refused the change for Rosa D., so nothing was saved.'],
  ])('%s is a refusal stamp in its own words', async (label, status, words) => {
    const code = label === 'REACHED_OUT_MARK_CHANGED' ? label : undefined;
    const fetchImpl = scriptedFetch({ body: LIST }, { status, body: { error: 'x', code } }, { body: LIST });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(requests(fetchImpl)).toHaveLength(3));
    const stamp = await waitFor(() => document.querySelector('[data-refusal-stamp="cannot_be_done"]') as HTMLElement);
    expect(stamp.textContent).toContain(words);
    expect(stamp.textContent).not.toContain('no longer on the stopped-coming list');
  });

  test('the buttons wait while a request is on its way (aria-disabled, so focus stays): no second PUT', async () => {
    let answer: (reply: Reply) => void = () => {};
    const held = new Promise<Reply>((resolve) => { answer = resolve; });
    const fetchImpl = scriptedFetch({ body: LIST }, held, { body: firstMarked(MARK) });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    expect(markButton(row(0)).getAttribute('aria-disabled')).toBe('true');
    expect(markButton(row(0)).getAttribute('aria-busy')).toBe('true');
    expect(markButton(row(0)).textContent).toBe('Saving…');
    expect(markButton(row(0)).disabled).toBe(false);
    expect(markButton(row(1)).getAttribute('aria-disabled')).toBe('true');
    await press(markButton(row(0)));
    await press(markButton(row(1)));
    expect(puts(fetchImpl)).toHaveLength(1);

    await act(async () => {
      answer({ body: { ok: true, outcome: 'marked' } });
    });
    await waitFor(() => expect(markButton(row(0)).getAttribute('aria-disabled')).toBe('false'));
    expect(puts(fetchImpl)).toHaveLength(1);
    expect(markButton(row(0)).textContent).toBe('Take back mark');
  });

  test('the last outcome is gone as soon as the next press starts, before its answer comes', async () => {
    let answer: (reply: Reply) => void = () => {};
    const held = new Promise<Reply>((resolve) => { answer = resolve; });
    const fetchImpl = scriptedFetch(
      { body: LIST },
      { status: 409, body: { code: 'NOT_ON_STOPPED_COMING_LIST' } },
      { body: { ...LIST, athletes: [LIST.athletes[1]] } },
      held,
      { body: { ...LIST, athletes: [{ ...LIST.athletes[1], reached_out: MARK }] } },
    );
    await renderPage(fetchImpl);
    await press(markButton(row(0)));
    await waitFor(() => expect(document.querySelector('[data-refusal-stamp="cannot_be_done"]')).not.toBeNull());

    await press(markButton(row(0)));
    // The PUT is on its way and unanswered: the old stamp is already gone.
    expect(puts(fetchImpl)).toHaveLength(2);
    expect(markButton(row(0)).textContent).toBe('Saving…');
    expect(document.querySelector('[data-refusal-stamp]')).toBeNull();
    expect(pageText()).not.toContain('no longer on the stopped-coming list');
    expect(announced()).toBe('');

    await act(async () => {
      answer({ body: { ok: true, outcome: 'marked' } });
    });
    await waitFor(() => expect(announced()).toBe('Jordan P. is marked as reached out.'));
  });

  test('a take-back says "Checking…" while its check-read runs, and "Saving…" once the PUT is sent', async () => {
    let readAnswer: (reply: Reply) => void = () => {};
    let putAnswer: (reply: Reply) => void = () => {};
    const heldRead = new Promise<Reply>((resolve) => { readAnswer = resolve; });
    const heldPut = new Promise<Reply>((resolve) => { putAnswer = resolve; });
    const fetchImpl = scriptedFetch({ body: firstMarked(MARK) }, heldRead, heldPut, { body: LIST });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    expect(markButton(row(0)).textContent).toBe('Checking…');
    expect(markButton(row(0)).getAttribute('aria-label')).toBe('Checking…: Rosa D.');
    expect(markButton(row(0)).getAttribute('aria-busy')).toBe('true');
    expect(puts(fetchImpl)).toHaveLength(0);

    await act(async () => {
      readAnswer({ body: firstMarked(MARK) });
    });
    await waitFor(() => expect(puts(fetchImpl)).toHaveLength(1));
    expect(markButton(row(0)).textContent).toBe('Saving…');
    expect(markButton(row(0)).getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      putAnswer({ body: { ok: true, outcome: 'taken_back' } });
    });
    await waitFor(() => expect(markButton(row(0)).textContent).toBe('Mark reached out'));
    expect(markButton(row(0)).getAttribute('aria-busy')).toBe('false');
  });

  test('a double click in one task sends one PUT', async () => {
    const fetchImpl = scriptedFetch({ body: LIST }, { body: { ok: true, outcome: 'marked' } }, { body: firstMarked(MARK) });
    await renderPage(fetchImpl);
    const button = markButton(row(0));
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(markButton(row(0)).textContent).toBe('Take back mark'));
    expect(puts(fetchImpl)).toHaveLength(1);
  });

  test.each([
    ['a dropped connection on a mark', 'network' as Reply, firstMarked(null), 'It is not known whether Rosa D. was marked as reached out.'],
    ['a server error on a mark', { status: 500, body: { error: 'Internal' } } as Reply, firstMarked(null), 'It is not known whether Rosa D. was marked as reached out.'],
    ['a dropped connection on a take-back', 'network' as Reply, firstMarked(MARK), 'It is not known whether the mark on Rosa D. was taken back.'],
  ])('%s says it is not known whether it saved, in a warning, never the medical-stop mark', async (_label, reply, start, words) => {
    const taking = start.athletes[0].reached_out !== null;
    const fetchImpl = taking
      ? scriptedFetch({ body: start }, { body: start }, reply, { body: start })
      : scriptedFetch({ body: start }, reply, { body: start });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(announced()).toBe(`${words} The list has been read again.`));
    const warning = document.querySelector('.alert') as HTMLElement;
    expect(warning.textContent).toContain(`${words} The list has been read again.`);
    expect(warning.classList.contains('alert--warning')).toBe(true);
    expect(warning.className).not.toMatch(/critical|locked|danger/);
    expect(warning.textContent).not.toMatch(/Failed to fetch|Internal|500/);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  test('a mark the server confirmed, then a read that fails, says both', async () => {
    await renderPage(scriptedFetch({ body: LIST }, { body: { ok: true, outcome: 'marked' } }, { status: 500, body: {} }));
    await press(markButton(row(0)));

    await waitFor(() => expect(announced()).toBe('Rosa D. is marked as reached out. The list could not be read again.'));
    expect(screen.getByRole('alert').textContent).toContain(READ_FAILED);
  });

  test.each([
    [401, 'signed_out'],
    [403, 'wrong_door'],
  ])('a press refused (%i) is the page\'s %s stamp, as a refused read is, and no rows stay', async (status, kind) => {
    await renderPage(scriptedFetch({ body: LIST }, { status, body: { error: 'Forbidden' } }));
    await press(markButton(row(0)));

    await waitFor(() => expect(document.querySelector('[data-refusal-stamp]')?.getAttribute('data-refusal-stamp')).toBe(kind));
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  test.each([
    ['no reached_out field', { athlete_id: 'ath-9', full_name: 'Kai M.', last_came_day: '2026-02-08', days_since_came: 30 }],
    ['a mark with no day', { athlete_id: 'ath-9', full_name: 'Kai M.', last_came_day: '2026-02-08', days_since_came: 30, reached_out: { by_name: 'Coach Ana T.' } }],
    ['a mark with an empty day', { athlete_id: 'ath-9', full_name: 'Kai M.', last_came_day: '2026-02-08', days_since_came: 30, reached_out: { by_name: null, on_day: ' ' } }],
  ])('a row with %s is not shown as unmarked: the page says it could not read the list', async (_label, athlete) => {
    await renderPage(mockFetch({ body: { ...LIST, athletes: [athlete] } }));
    expect(screen.getByRole('alert').textContent).toContain(READ_FAILED);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  test('the mark button is a .btn, which the kiosk surface floors at --tap, and never the medical-stop mark', async () => {
    await renderPage(mockFetch({ body: firstMarked(MARK) }));
    for (const listed of screen.getAllByRole('listitem')) {
      // kioskTapFloor.test.tsx holds the floor itself: this page's layout, and the kiosk .btn rule.
      expect(markButton(listed).classList.contains('btn')).toBe(true);
      expect(markButton(listed).className).not.toMatch(/locked|danger|critical/);
    }
  });
});
