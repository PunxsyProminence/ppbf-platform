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

import { act, fireEvent, render, screen, within } from '@testing-library/react';

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
  today: '2026-11-25',
  // Longest gone first, and NOT in name order, so a page that re-sorted by name would show it.
  athletes: [
    { athlete_id: 'ath-2', full_name: 'Rosa D.', last_came_day: '2026-10-26', days_since_came: 30 },
    { athlete_id: 'ath-1', full_name: 'Jordan P.', last_came_day: '2026-11-11', days_since_came: 14 },
  ],
};

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
  expect(within(rows[0]).getByText(formatCalendarDay('2026-10-26'))).toBeTruthy();
  expect(within(rows[0]).getByText('30')).toBeTruthy();
  expect(within(rows[1]).getByText(formatCalendarDay('2026-11-11'))).toBeTruthy();
  expect(within(rows[1]).getByText('14')).toBeTruthy();
  expect(within(rows[0]).getByText('Last came')).toBeTruthy();
  expect(within(rows[0]).getByText('Days since')).toBeTruthy();
});

test('the gym\'s number reads in weeks, and says when it is the default', async () => {
  await renderPage(mockFetch({}));
  expect(pageText()).toContain('have not come for 2 weeks or more, longest gone first');
  expect(pageText()).toContain('The gym has not set its own number of days, so the default, 2 weeks, applies.');
  expect(pageText()).toContain(`As of ${formatCalendarDay('2026-11-25')}.`);
});

test('one week reads as "1 week" and "the last week"', async () => {
  await renderPage(mockFetch({ body: { ...LIST, gap_days: 7, is_default: false, athletes: [] } }));
  expect(pageText()).toContain('have not come for 1 week or more');
  expect(pageText()).toContain('No one who has come before has gone 1 week without coming');
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
  expect(pageText()).toContain('No one who has come before has gone 2 weeks without coming');
  expect(pageText()).toContain('Every athlete on the roster who has come before came within the last 2 weeks.');
  expect(pageText()).toContain('Athletes who have never come, and athletes marked as left the gym, are not on this list.');
});

test.each([401, 403])('a refused read (%i) is a stamp, not an error banner, and shows no rows', async (status) => {
  await renderPage(mockFetch({ status }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  expect(pageText()).toContain('who has stopped coming is read by a coach or the gym admin of this gym');
});

test('a 401 is the signed-out stamp and a 403 the wrong-door stamp', async () => {
  await renderPage(mockFetch({ status: 401 }));
  const signedOut = pageText();
  document.body.innerHTML = '';
  await renderPage(mockFetch({ status: 403 }));
  expect(pageText()).not.toBe(signedOut);
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
  expect(pageText()).not.toContain('No one who has come before');
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
});

test('the page shows no attendance figure or rate', async () => {
  await renderPage(mockFetch({}));
  expect(pageText()).not.toMatch(/attendance|%/i);
});
