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
// the server cannot name is not named; a 2xx without one of the four outcome
// words is not a confirmation; a refusal is a stamp that stays until the next
// press; each outcome is said only once it is true, under the pressed row while
// that row is shown and at the top otherwise, and the page's one status line
// reads every outcome, refusals included; focus moves only when the pressed
// button has gone; and the buttons wait (aria-disabled, one PUT, "Waiting…" on
// the other rows) while a request is on its way.

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

// Synthetic staff names only (public repository). Bare, with no "Coach " in front: the server
// takes a leading title off the name the gym typed before it sends it (getStaffDisplayName, through
// bareTypedStaffName in src/shared/coachDisplayName.ts).
const MARK = { by_name: 'Ana T.', by_role: 'coach', on_day: '2026-03-09' };

/** LIST with the first row (Rosa D., ath-2) carrying `mark`. */
const firstMarked = (mark: unknown) => ({
  ...LIST,
  athletes: LIST.athletes.map((athlete, index) => (index === 0 ? { ...athlete, reached_out: mark } : athlete)),
});

/** `notJson` is a body that is not JSON; a reply with neither it nor `body` has an empty body (a 204). */
type Reply = { status?: number; body?: unknown; notJson?: string } | 'network';

/** Answers each request in turn (the read, the PUT, the read again); a promise holds its answer until resolved. */
function scriptedFetch(...replies: Array<Reply | Promise<Reply>>) {
  const queue = [...replies];
  return jest.fn(async () => {
    const reply = await queue.shift();
    if (reply === undefined) throw new Error('no reply scripted for this request');
    if (reply === 'network') throw new TypeError('Failed to fetch');
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      // As fetch's json() does, a body that is not JSON, or an empty one, is rejected.
      json: async () => {
        if (reply.notJson !== undefined) throw new SyntaxError(`Unexpected token '<', "${reply.notJson}" is not valid JSON`);
        if (!('body' in reply)) throw new SyntaxError('Unexpected end of JSON input');
        return reply.body;
      },
    };
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

/** The page's one persistent announcer (not RefusalStamp's own role="status"). */
const announced = () => document.querySelector('p.sr-only[role="status"]')?.textContent ?? null;

/** The outcome shown at the top of the page (the focusable container), or null. */
const topOutcome = () => document.querySelector('main div[tabindex="-1"]') as HTMLElement | null;

/** The outcome shown under a row: the row's own aria-hidden block, or null. */
const rowOutcome = (row: HTMLElement) => row.querySelector(':scope > div[aria-hidden="true"]') as HTMLElement | null;

// No id leaves the page: an athlete is named, never numbered.
const ID_PATTERN = /ath-\d/;
// A row on this list has an active membership or none, so "active" is the status a row could show; a
// membership record also holds the scholarship and the program, and payment is the membership slot's.
const MEMBERSHIP_PATTERN = /member|status|active|lapsed|ended|program|enrol|scholarship|discount|paid|fee/i;

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
  expect(pageText()).not.toContain('marking who was reached out');
  // On the first read the page's status line stays empty: the stamp shows alone.
  expect(announced()).toBe('');
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
  for (const row of rows) {
    expect(row.textContent).not.toMatch(MEMBERSHIP_PATTERN);
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
  const row = (index: number) => screen.getAllByRole('listitem')[index];

  test('an unmarked row shows one "Mark reached out" button, no toggle state, and only its name and day', async () => {
    await renderPage(mockFetch({}));
    for (const listed of screen.getAllByRole('listitem')) {
      expect(markButton(listed).textContent).toBe('Mark reached out');
      expect(markButton(listed).hasAttribute('aria-pressed')).toBe(false);
      expect(listed.textContent).not.toMatch(/Reached out (by|on)/);
      // No id leaves the row: the athlete is named, never numbered.
      expect(listed.textContent).not.toMatch(ID_PATTERN);
      expect(listed.textContent).not.toMatch(MEMBERSHIP_PATTERN);
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
    expect(init).toMatchObject({ method: 'PUT', credentials: 'include' });
    expect(init?.headers).toStrictEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toStrictEqual({ athlete_id: 'ath-2', reached_out: true });
    // The third request is the list read again (a GET), and the row shows that answer: the name
    // and the day come only from it, so a row marked by the press itself would not have them.
    expect(requests(fetchImpl)[2][1]?.method).toBeUndefined();
    await waitFor(() => expect(markButton(row(0)).textContent).toBe('Take back mark'));
    expect(row(0).textContent).toContain(`Reached out by Ana T. on ${formatCalendarDay('2026-03-09')}.`);
    expect(row(0).textContent).not.toMatch(ID_PATTERN);
    expect(markButton(row(1)).textContent).toBe('Mark reached out');
    expect(announced()).toBe('Rosa D. was marked as reached out.');
    // The row stays, so the outcome is seen under it, aria-hidden (the status line reads it).
    expect(rowOutcome(row(0))?.textContent).toBe('Rosa D. was marked as reached out.');
    expect(topOutcome()).toBeNull();
  });

  test('after a 200 where the row stays, focus is still on that row\'s button', async () => {
    const fetchImpl = scriptedFetch({ body: LIST }, { body: { ok: true, outcome: 'marked' } }, { body: firstMarked(MARK) });
    await renderPage(fetchImpl);
    const button = markButton(row(0));
    button.focus();
    expect(document.activeElement).toBe(button);
    await press(button);

    await waitFor(() => expect(announced()).toBe('Rosa D. was marked as reached out.'));
    expect(markButton(row(0))).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  test('a press with focus never on its button (a mouse click in Safari) moves no focus while the button is there', async () => {
    const fetchImpl = scriptedFetch({ body: LIST }, { body: { ok: true, outcome: 'marked' } }, { body: firstMarked(MARK) });
    await renderPage(fetchImpl);
    expect(document.activeElement).toBe(document.body);
    await press(markButton(row(0)));

    await waitFor(() => expect(announced()).toBe('Rosa D. was marked as reached out.'));
    expect(document.activeElement).toBe(document.body);
  });

  test.each([
    ['a 200 whose body is not JSON', { notJson: '<!doctype html>' } as Reply],
    ['a 200 with an outcome word the route does not send', { body: { ok: true, outcome: 'something_else' } } as Reply],
    ['a 204 with no body', { status: 204 } as Reply],
  ])('%s is not a confirmation: it is not known whether it saved', async (_label, reply) => {
    const fetchImpl = scriptedFetch({ body: LIST }, reply, { body: LIST });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    const notKnown = 'It is not known whether Rosa D. was marked as reached out. The list has been read again.';
    await waitFor(() => expect(announced()).toBe(`Attention: ${notKnown}`));
    const warning = document.querySelector('.alert') as HTMLElement;
    expect(warning.textContent).toContain(notKnown);
    expect(warning.classList.contains('alert--warning')).toBe(true);
    // Nothing reads as a confirmation. The not-known sentence itself holds "was marked", so it is taken out first.
    expect(pageText().split(notKnown).join('')).not.toMatch(/accepted|was marked|was taken back/);
    expect(row(0).textContent).not.toMatch(/Reached out (by|on)/);
    expect(document.querySelector('[data-refusal-stamp]')).toBeNull();
  });

  test('"already_marked" (another coach got there first): the fresh read shows their mark, and nothing is refused', async () => {
    const theirs = { by_name: 'Bo R.', by_role: 'coach', on_day: '2026-03-08' };
    const fetchImpl = scriptedFetch({ body: LIST }, { body: { ok: true, outcome: 'already_marked' } }, { body: firstMarked(theirs) });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(row(0).textContent).toContain(`Reached out by Bo R. on ${formatCalendarDay('2026-03-08')}.`));
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
    expect(row(0).textContent).toContain(`Reached out by Ana T. on ${formatCalendarDay('2026-03-09')}.`);
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

  test('"not_marked" says there was no mark to take back', async () => {
    const fetchImpl = scriptedFetch(
      { body: firstMarked(MARK) },
      { body: firstMarked(MARK) },
      { body: { ok: true, outcome: 'not_marked' } },
      { body: LIST },
    );
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(announced()).toBe('There was no mark on Rosa D. to take back, so nothing was taken back.'));
    expect(puts(fetchImpl)).toHaveLength(1);
    expect(rowOutcome(row(0))?.textContent).toBe('There was no mark on Rosa D. to take back, so nothing was taken back.');
    expect(row(0).textContent).not.toMatch(/Reached out (by|on)/);
  });

  test.each([
    ['the same name with spaces around it', MARK, { ...MARK, by_name: ' Ana T. ' }],
    ['a blank name where none was shown', { ...MARK, by_name: null }, { ...MARK, by_name: '  ' }],
  ])('a take-back whose fresh read shows %s is sent: names are compared trimmed, a blank one as none', async (_label, shown, now) => {
    const fetchImpl = scriptedFetch(
      { body: firstMarked(shown) },
      { body: firstMarked(now) },
      { body: { ok: true, outcome: 'taken_back' } },
      { body: LIST },
    );
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(announced()).toBe('The mark on Rosa D. was taken back.'));
    expect(puts(fetchImpl)).toHaveLength(1);
  });

  test.each([
    ['another coach\'s mark', { by_name: 'Bo R.', by_role: 'coach', on_day: '2026-03-09' }],
    ['a mark of another day', { by_name: 'Ana T.', by_role: 'coach', on_day: '2026-03-10' }],
    ['a marker no longer nameable', { by_name: null, by_role: 'coach', on_day: '2026-03-09' }],
    ['a mark made in another role', { by_name: 'Ana T.', by_role: 'office', on_day: '2026-03-09' }],
    ['no mark', null],
  ])('a take-back whose fresh read shows %s sends nothing, and shows the list as it is', async (_label, now) => {
    const fetchImpl = scriptedFetch({ body: firstMarked(MARK) }, { body: firstMarked(now) });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(announced()).toBe('The mark on Rosa D. has changed since it was shown, so nothing was taken back.'));
    expect(puts(fetchImpl)).toHaveLength(0);
    if (now) {
      expect(row(0).textContent).toContain(`on ${formatCalendarDay(now.on_day)}`);
    } else {
      expect(row(0).textContent).not.toMatch(/Reached out (by|on)/);
    }
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

  // Lane W5-FU, F2 (App Overwatch's answer A on #2248): no name, so the role the mark was made in.
  test.each([
    ['a null', 'coach', 'a coach', null],
    ['a blank', 'coach', 'a coach', '  '],
    ['a null', 'office', 'the gym office', null],
    ['a blank', 'office', 'the gym office', '  '],
  ])('a marker the server cannot name (%s name, by_role %s) is not named: the row says "by %s"', async (_label, byRole, words, byName) => {
    await renderPage(mockFetch({ body: firstMarked({ by_name: byName, by_role: byRole, on_day: '2026-03-09' }) }));
    expect(row(0).textContent).toContain(`Reached out by ${words} on ${formatCalendarDay('2026-03-09')}.`);
    // A role, never a stand-in name, and never the raw value.
    expect(row(0).textContent).not.toMatch(/Your coach|Gym office|null|undefined|unknown|cannot be shown|by office |by coach /);
    expect(markButton(row(0)).textContent).toBe('Take back mark');
  });

  test('a marker the server names is shown by name, whatever the role', async () => {
    await renderPage(mockFetch({ body: firstMarked({ by_name: 'Pat Q.', by_role: 'office', on_day: '2026-03-09' }) }));
    expect(row(0).textContent).toContain(`Reached out by Pat Q. on ${formatCalendarDay('2026-03-09')}.`);
    expect(row(0).textContent).not.toMatch(/gym office|a coach/);
  });

  test('a 409 (no longer on the list) is a refusal stamp at the top, read out, with focus on it once the row has gone', async () => {
    const fetchImpl = scriptedFetch(
      { body: LIST },
      {
        status: 409,
        body: { error: 'This athlete is not on the stopped-coming list now. Reload the page.', code: 'NOT_ON_STOPPED_COMING_LIST' },
      },
      { body: { ...LIST, athletes: [LIST.athletes[1]] } },
    );
    await renderPage(fetchImpl);
    const button = markButton(row(0));
    button.focus();
    await press(button);

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(requests(fetchImpl)[2][1]?.method).toBeUndefined();
    const stamp = document.querySelector('[data-refusal-stamp="cannot_be_done"]') as HTMLElement;
    // Words, not colour alone (Law 3), and nothing on it to dismiss it.
    expect(stamp.textContent).toContain('CANNOT BE DONE');
    expect(stamp.textContent).toContain('Rosa D. is no longer on the stopped-coming list, so nothing was marked.');
    expect(within(stamp).queryByRole('button')).toBeNull();
    // The row is gone, so the stamp is at the top, not under any row, and not aria-hidden.
    const top = topOutcome() as HTMLElement;
    expect(top.contains(stamp)).toBe(true);
    expect(stamp.closest('li')).toBeNull();
    expect(stamp.closest('[aria-hidden="true"]')).toBeNull();
    // The page's status line reads the stamp's words.
    expect(announced()).toBe(
      'CANNOT BE DONE: This action cannot be approved — Rosa D. is no longer on the stopped-coming list, so nothing was marked.',
    );
    // The pressed button went with its row, so focus is on the outcome at the top.
    expect(button.isConnected).toBe(false);
    expect(document.activeElement).toBe(top);
    expect(pageText()).not.toMatch(/Reload the page|read again/);
    expect(row(0).textContent).toContain('Jordan P.');
  });

  test('focus moved to another element during a request stays there, even when the pressed button goes', async () => {
    let answer: (reply: Reply) => void = () => {};
    const held = new Promise<Reply>((resolve) => { answer = resolve; });
    const fetchImpl = scriptedFetch({ body: LIST }, held, { body: { ...LIST, athletes: [LIST.athletes[1]] } });
    await renderPage(fetchImpl);
    const button = markButton(row(0));
    button.focus();
    await press(button);
    const passbook = within(row(1)).getByText('Open passbook');
    passbook.focus();

    await act(async () => {
      answer({ status: 409, body: { code: 'NOT_ON_STOPPED_COMING_LIST' } });
    });
    await waitFor(() => expect(announced()).toMatch(/^CANNOT BE DONE: /));
    expect(button.isConnected).toBe(false);
    expect(topOutcome()).not.toBeNull();
    expect(document.activeElement).toBe(passbook);
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
      await waitFor(() => expect(announced()).toBe('Jordan P. was marked as reached out.'));
      expect(document.querySelector('[data-refusal-stamp]')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    [
      'REACHED_OUT_MARK_CHANGED',
      409,
      'the mark on Rosa D. changed while it was being saved, so nothing was saved; the list was read again and shows the mark as the server holds it now.',
    ],
    ['a 404', 404, 'Rosa D. was not found in this gym, so nothing was saved.'],
    ['a 400', 400, 'the server refused the change for Rosa D., so nothing was saved.'],
  ])('%s, where the row stays, is a refusal stamp in its own words under that row, read out by the status line', async (label, status, words) => {
    const code = label === 'REACHED_OUT_MARK_CHANGED' ? label : undefined;
    const fetchImpl = scriptedFetch({ body: LIST }, { status, body: { error: 'x', code } }, { body: LIST });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(requests(fetchImpl)).toHaveLength(3));
    const stamp = await waitFor(() => document.querySelector('[data-refusal-stamp="cannot_be_done"]') as HTMLElement);
    expect(stamp.textContent).toContain(words);
    expect(stamp.textContent).not.toContain('no longer on the stopped-coming list');
    expect(pageText()).not.toContain('try again');
    // Under the pressed row, in its aria-hidden block; nothing at the top.
    expect(rowOutcome(row(0))?.contains(stamp)).toBe(true);
    expect(rowOutcome(row(1))).toBeNull();
    expect(topOutcome()).toBeNull();
    expect(announced()).toBe(`CANNOT BE DONE: This action cannot be approved — ${words}`);
  });

  test('REACHED_OUT_MARK_CHANGED with a read after it that fails does not say the list was read again', async () => {
    const fetchImpl = scriptedFetch({ body: LIST }, { status: 409, body: { code: 'REACHED_OUT_MARK_CHANGED' } }, { status: 500, body: {} });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    const words = 'the mark on Rosa D. changed while it was being saved, so nothing was saved.';
    await waitFor(() => expect(announced()).toBe(`CANNOT BE DONE: This action cannot be approved — ${words}`));
    // The list is not shown, so the stamp is at the top.
    expect(topOutcome()?.querySelector('[data-refusal-stamp="cannot_be_done"]')?.textContent).toContain(words);
    expect(pageText()).not.toMatch(/try again|read again and shows/);
    expect(screen.getByRole('alert').textContent).toContain(READ_FAILED);
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
    // The other row's button waits too, and says so in words.
    expect(markButton(row(1)).getAttribute('aria-disabled')).toBe('true');
    expect(markButton(row(1)).getAttribute('aria-busy')).toBe('false');
    expect(markButton(row(1)).textContent).toBe('Waiting…');
    expect(markButton(row(1)).getAttribute('aria-label')).toBe('Waiting…: Jordan P.');
    // Nothing is painted before the answer: no mark line that was not there, and nothing said.
    for (const listed of screen.getAllByRole('listitem')) {
      expect(listed.textContent).not.toMatch(/Reached out/);
    }
    expect(announced()).toBe('');
    await press(markButton(row(0)));
    await press(markButton(row(1)));
    expect(puts(fetchImpl)).toHaveLength(1);
    expect(requests(fetchImpl)).toHaveLength(2);

    await act(async () => {
      answer({ body: { ok: true, outcome: 'marked' } });
    });
    await waitFor(() => expect(markButton(row(0)).getAttribute('aria-disabled')).toBe('false'));
    expect(puts(fetchImpl)).toHaveLength(1);
    expect(markButton(row(0)).textContent).toBe('Take back mark');
    expect(markButton(row(1)).textContent).toBe('Mark reached out');
  });

  test('a press while the read after a PUT is still on its way sends no request', async () => {
    let answer: (reply: Reply) => void = () => {};
    const heldRead = new Promise<Reply>((resolve) => { answer = resolve; });
    const fetchImpl = scriptedFetch({ body: LIST }, { body: { ok: true, outcome: 'marked' } }, heldRead);
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(requests(fetchImpl)).toHaveLength(3));
    expect(requests(fetchImpl)[2][1]?.method).toBeUndefined();
    expect(markButton(row(0)).textContent).toBe('Saving…');
    expect(markButton(row(1)).textContent).toBe('Waiting…');
    await press(markButton(row(0)));
    await press(markButton(row(1)));
    expect(requests(fetchImpl)).toHaveLength(3);

    await act(async () => {
      answer({ body: firstMarked(MARK) });
    });
    await waitFor(() => expect(announced()).toBe('Rosa D. was marked as reached out.'));
    expect(requests(fetchImpl)).toHaveLength(3);
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
    await waitFor(() => expect(announced()).toBe('Jordan P. was marked as reached out.'));
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

    await waitFor(() => expect(announced()).toBe(`Attention: ${words} The list has been read again.`));
    const warning = document.querySelector('.alert') as HTMLElement;
    expect(warning.textContent).toContain(`${words} The list has been read again.`);
    expect(warning.classList.contains('alert--warning')).toBe(true);
    // The triangle and the title say "warning" in shape and words, not colour alone (Law 3).
    expect(warning.querySelector('.alert-icon')?.textContent).toBe('▲');
    expect(warning.querySelector('.alert-title')?.textContent).toBe('Attention');
    // The row stays, so the warning is under it, in its aria-hidden block.
    expect(rowOutcome(row(0))?.contains(warning)).toBe(true);
    expect(warning.className).not.toMatch(/critical|locked|danger/);
    expect(warning.textContent).not.toMatch(/Failed to fetch|Internal|500/);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  test('a mark the server confirmed, then a read that fails, says both', async () => {
    await renderPage(scriptedFetch({ body: LIST }, { body: { ok: true, outcome: 'marked' } }, { status: 500, body: {} }));
    await press(markButton(row(0)));

    await waitFor(() => expect(announced()).toBe('Rosa D. was marked as reached out. The list could not be read again.'));
    expect(screen.getByRole('alert').textContent).toContain(READ_FAILED);
    // The list is not shown, so the outcome is at the top, and the list's "As of" line is gone with it.
    expect(topOutcome()?.textContent).toBe('Rosa D. was marked as reached out. The list could not be read again.');
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(pageText()).not.toContain('As of');
    expect(pageText()).not.toContain('so the default, 2 weeks, applies');
  });

  test.each([
    [401, 'signed_out', 'sign in again to read who has stopped coming', 'SIGNED OUT: Your session ended'],
    [403, 'wrong_door', 'marking who was reached out is for a coach or the gym admin of this gym', 'WRONG DOOR: Not available for this role'],
  ])('a press refused (%i) is the page\'s %s stamp, read out, with no read after it and no rows', async (status, kind, detail, opening) => {
    const fetchImpl = scriptedFetch({ body: LIST }, { status, body: { error: 'Forbidden' } });
    await renderPage(fetchImpl);
    const button = markButton(row(0));
    button.focus();
    await press(button);

    await waitFor(() => expect(document.querySelector('[data-refusal-stamp]')?.getAttribute('data-refusal-stamp')).toBe(kind));
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    // The first read and the PUT, and nothing after.
    expect(requests(fetchImpl).map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'PUT']);
    const stamp = document.querySelector('[data-refusal-stamp]') as HTMLElement;
    expect(stamp.textContent).toContain(`${detail}.`);
    expect(stamp.textContent).not.toContain('who has stopped coming is read by');
    expect(announced()).toBe(`${opening} — ${detail}.`);
    // The button went with the list and there is no outcome at the top, so focus is on the heading.
    expect(topOutcome()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  test('a take-back whose check-read is answered 401: the status line says the outcome, then the signed-out stamp', async () => {
    const fetchImpl = scriptedFetch({ body: firstMarked(MARK) }, { status: 401, body: {} });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(document.querySelector('[data-refusal-stamp]')?.getAttribute('data-refusal-stamp')).toBe('signed_out'));
    expect(puts(fetchImpl)).toHaveLength(0);
    expect(announced()).toBe(
      'The mark on Rosa D. could not be checked, so nothing was taken back. '
      + 'SIGNED OUT: Your session ended — sign in again to read who has stopped coming.',
    );
  });

  test('a PUT answered 200 whose read after it is answered 403: the status line says the outcome, then the wrong-door stamp as a read', async () => {
    const fetchImpl = scriptedFetch({ body: LIST }, { body: { ok: true, outcome: 'marked' } }, { status: 403, body: {} });
    await renderPage(fetchImpl);
    await press(markButton(row(0)));

    await waitFor(() => expect(document.querySelector('[data-refusal-stamp]')?.getAttribute('data-refusal-stamp')).toBe('wrong_door'));
    expect(announced()).toBe(
      'Rosa D. was marked as reached out. The list could not be read again. '
      + 'WRONG DOOR: Not available for this role — who has stopped coming is read by a coach or the gym admin of this gym.',
    );
    // The PUT was not refused: the stamp keeps the reading words, on the page and in the status line.
    expect(pageText()).not.toContain('marking who was reached out');
    expect((document.querySelector('[data-refusal-stamp]') as HTMLElement).textContent)
      .toContain('who has stopped coming is read by a coach or the gym admin of this gym.');
  });

  test.each([
    ['a read after the PUT that fails', 'mark', [{ body: { ok: true, outcome: 'marked' } }, { status: 500, body: {} }]],
    ['a read after the PUT answered 403', 'mark', [{ body: { ok: true, outcome: 'marked' } }, { status: 403, body: {} }]],
    ['a check-read answered 401', 'take back', [{ status: 401, body: {} }]],
  ] as Array<[string, 'mark' | 'take back', Reply[]]>)(
    'after %s (%s), the header shows none of the old list\'s values: the gym’s number of days, and no "As of"',
    async (_label, action, replies) => {
      const fetchImpl = scriptedFetch({ body: action === 'mark' ? LIST : firstMarked(MARK) }, ...replies);
      await renderPage(fetchImpl);
      // While the list is shown, its values are.
      expect(pageText()).toContain('have not come for 2 weeks or more');
      expect(pageText()).toContain(`As of ${formatCalendarDay('2026-03-10')}.`);
      await press(markButton(row(0)));

      await waitFor(() => expect(screen.queryAllByRole('listitem')).toHaveLength(0));
      await waitFor(() => expect(announced()).not.toBe(''));
      expect(pageText()).toContain('have not come for the gym’s number of days or more');
      expect(pageText()).not.toMatch(/2 weeks|As of|so the default|own setting/);
    },
  );

  test.each([
    ['no reached_out field', { athlete_id: 'ath-9', full_name: 'Kai M.', last_came_day: '2026-02-08', days_since_came: 30 }],
    ['a mark with no day', { athlete_id: 'ath-9', full_name: 'Kai M.', last_came_day: '2026-02-08', days_since_came: 30, reached_out: { by_name: 'Ana T.', by_role: 'coach' } }],
    ['a mark with an empty day', { athlete_id: 'ath-9', full_name: 'Kai M.', last_came_day: '2026-02-08', days_since_came: 30, reached_out: { by_name: null, by_role: 'coach', on_day: ' ' } }],
    ['a mark whose day is not YYYY-MM-DD', { athlete_id: 'ath-9', full_name: 'Kai M.', last_came_day: '2026-02-08', days_since_came: 30, reached_out: { by_name: 'Ana T.', by_role: 'coach', on_day: 'not-a-date' } }],
    ['a mark whose name is a number', { athlete_id: 'ath-9', full_name: 'Kai M.', last_came_day: '2026-02-08', days_since_came: 30, reached_out: { by_name: 5, by_role: 'coach', on_day: '2026-03-09' } }],
    ['a mark with no by_name key', { athlete_id: 'ath-9', full_name: 'Kai M.', last_came_day: '2026-02-08', days_since_came: 30, reached_out: { by_role: 'coach', on_day: '2026-03-09' } }],
    ['a mark with no by_role key', { athlete_id: 'ath-9', full_name: 'Kai M.', last_came_day: '2026-02-08', days_since_came: 30, reached_out: { by_name: null, on_day: '2026-03-09' } }],
    ['a mark whose by_role is the stored role word', { athlete_id: 'ath-9', full_name: 'Kai M.', last_came_day: '2026-02-08', days_since_came: 30, reached_out: { by_name: null, by_role: 'organization_admin', on_day: '2026-03-09' } }],
  ])('a row with %s is not shown as unmarked: the page says it could not read the list', async (_label, athlete) => {
    await renderPage(mockFetch({ body: { ...LIST, athletes: [athlete] } }));
    expect(screen.getByRole('alert').textContent).toContain(READ_FAILED);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  // A mark carrying a field the page does not use (synthetic): it must never be shown.
  const EXTRA_MARK = { ...MARK, marked_by_account_id: 'acct-x' };
  /** Rosa D. unmarked; Jordan P. marked, with the extra field. */
  const secondMarked = { ...LIST, athletes: [LIST.athletes[0], { ...LIST.athletes[1], reached_out: EXTRA_MARK }] };
  /** Both marked, with the extra field. */
  const bothMarked = { ...LIST, athletes: LIST.athletes.map((athlete) => ({ ...athlete, reached_out: EXTRA_MARK })) };

  test('a mark\'s extra fields never reach the page: the row\'s mark line is exactly its one sentence', async () => {
    await renderPage(mockFetch({ body: firstMarked(EXTRA_MARK) }));
    expect(pageText()).not.toContain('acct-x');
    expect(within(row(0)).getByText(/^Reached out/).textContent).toBe(`Reached out by Ana T. on ${formatCalendarDay('2026-03-09')}.`);
    for (const listed of screen.getAllByRole('listitem')) {
      expect(listed.textContent).not.toMatch(ID_PATTERN);
      expect(listed.textContent).not.toMatch(MEMBERSHIP_PATTERN);
    }
  });

  test.each([
    ['marked', 'mark', [{ body: { ok: true, outcome: 'marked' } }, { body: bothMarked }]],
    ['already_marked', 'mark', [{ body: { ok: true, outcome: 'already_marked' } }, { body: bothMarked }]],
    ['a 409, no longer on the list', 'mark', [{ status: 409, body: { code: 'NOT_ON_STOPPED_COMING_LIST' } }, { body: { ...LIST, athletes: [secondMarked.athletes[1]] } }]],
    ['a 409, the mark changed', 'mark', [{ status: 409, body: { code: 'REACHED_OUT_MARK_CHANGED' } }, { body: bothMarked }]],
    ['a 404', 'mark', [{ status: 404, body: {} }, { body: secondMarked }]],
    ['a 400', 'mark', [{ status: 400, body: {} }, { body: secondMarked }]],
    ['a 500', 'mark', [{ status: 500, body: {} }, { body: secondMarked }]],
    ['a dropped connection', 'mark', ['network', { body: secondMarked }]],
    ['an unknown outcome word', 'mark', [{ body: { ok: true, outcome: 'something_else' } }, { body: secondMarked }]],
    ['marked, then a read that fails', 'mark', [{ body: { ok: true, outcome: 'marked' } }, { status: 500, body: {} }]],
    ['taken_back', 'take back', [{ body: bothMarked }, { body: { ok: true, outcome: 'taken_back' } }, { body: secondMarked }]],
    ['not_marked', 'take back', [{ body: bothMarked }, { body: { ok: true, outcome: 'not_marked' } }, { body: secondMarked }]],
    ['a check-read showing the mark changed', 'take back', [{ body: secondMarked }]],
    ['a check-read without the athlete', 'take back', [{ body: { ...LIST, athletes: [bothMarked.athletes[1]] } }]],
    ['a check-read that fails', 'take back', [{ status: 500, body: {} }]],
  ] as Array<[string, 'mark' | 'take back', Reply[]]>)(
    'after %s (%s), no row, marked or not, and no outcome line shows an id, an account id or a membership word',
    async (_label, action, replies) => {
      const fetchImpl = scriptedFetch({ body: action === 'mark' ? secondMarked : bothMarked }, ...replies);
      await renderPage(fetchImpl);
      expect(markButton(row(0)).textContent).toBe(action === 'mark' ? 'Mark reached out' : 'Take back mark');
      await press(markButton(row(0)));

      await waitFor(() => expect(announced()).not.toBe(''));
      const lines = [
        announced() ?? '',
        topOutcome()?.textContent ?? '',
        ...screen.queryAllByRole('listitem').flatMap((listed) => [listed.textContent ?? '', rowOutcome(listed)?.textContent ?? '']),
      ];
      expect(lines.join(' ').trim()).not.toBe('');
      for (const line of lines) {
        expect(line).not.toMatch(ID_PATTERN);
        expect(line).not.toMatch(MEMBERSHIP_PATTERN);
      }
      expect(pageText()).not.toContain('acct-x');
    },
  );

  test('the mark button is a .btn, which the kiosk surface floors at --tap, and never the medical-stop mark', async () => {
    await renderPage(mockFetch({ body: firstMarked(MARK) }));
    for (const listed of screen.getAllByRole('listitem')) {
      // kioskTapFloor.test.tsx holds the floor itself: this page's layout, and the kiosk .btn rule.
      expect(markButton(listed).classList.contains('btn')).toBe(true);
      expect(markButton(listed).className).not.toMatch(/locked|danger|critical/);
    }
  });
});
