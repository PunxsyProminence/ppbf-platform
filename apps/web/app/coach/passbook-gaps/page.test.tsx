/**
 * @jest-environment jsdom
 */

// Passbook Gaps -- the first page over `/api/pilot/passbook/gaps`. What these
// pin: rows render in the order the server sent them (the order IS the
// triage, so a page that re-sorts breaks the feature); the retention reading
// and the "no recorded visit" case are both stated honestly; the empty state
// never reads as "nobody is slipping"; a refused role gets a stamp rather
// than an error banner (Law 7); a genuine failure admits gaps may exist; and
// the page never claims to be a queue of absences when the API returns a
// queue of gaps.

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { PASSBOOK_PAGE, PROGRESSION_INTELLIGENCE_PAGE } from '@/components/athleteRecordPages';
import { takeArrivalAthlete } from '@/components/decisionLoopArrival';
import CoachPassbookGapsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// A plain anchor that runs the link's own onClick, as next/link does, without
// navigating (the pattern of the Escalations test, lane AS-5).
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className, onClick }: {
    readonly children: React.ReactNode;
    readonly href: string;
    readonly className?: string;
    readonly onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a href={href} className={className} onClick={(event) => { event.preventDefault(); onClick?.(event); }}>{children}</a>
  ),
}));

// Shaped exactly like `CoachPassbookGapQueueItem` in
// src/server/pilot/passbook.ts -- no invented fields.
const ITEMS = [
  {
    gap_id: 'gap-1',
    gap_type: 'conditioning',
    gap_description: 'Fades in round 3',
    severity: 'high',
    detected_from: 'coach_observation',
    status: 'confirmed',
    created_at: '2026-07-02T10:00:00.000Z',
    athlete_id: 'ath-1',
    athlete_name: 'Rosa D.',
    coach_id: 'coach-1',
    last_attended_on: '2026-07-28',
    recorded_absences_since_last_visit: 6,
  },
  {
    gap_id: 'gap-2',
    gap_type: 'guard_discipline',
    gap_description: 'Drops the right hand under pressure',
    severity: 'critical',
    detected_from: 'session_review',
    status: 'open',
    created_at: '2026-08-01T10:00:00.000Z',
    athlete_id: 'ath-2',
    athlete_name: 'Jordan P.',
    coach_id: 'coach-1',
    last_attended_on: null,
    recorded_absences_since_last_visit: 0,
  },
];

function mockFetch(options: { items?: unknown; status?: number }) {
  const status = options.status ?? 200;
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ items: options.items ?? ITEMS }),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('renders the queue in the order the server sent it, with the retention reading on every row', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<CoachPassbookGapsPage />);
  });

  const rows = screen.getAllByRole('listitem');
  // Server order: absences desc, then longest-unseen. Rosa (6 absences)
  // before Jordan, and the page must not re-sort by severity even though
  // Jordan's gap is the critical one.
  expect(rows).toHaveLength(2);
  expect(within(rows[0]).getByText('Rosa D.')).toBeTruthy();
  expect(within(rows[1]).getByText('Jordan P.')).toBeTruthy();

  expect(within(rows[0]).getByText('Jul 28, 2026')).toBeTruthy();
  expect(within(rows[0]).getByText('6')).toBeTruthy();
  expect(within(rows[0]).getByText(/Fades in round 3/)).toBeTruthy();
  // Stored enum values are spaced for a human, never renamed.
  expect(within(rows[0]).getByText(/detected from coach observation/)).toBeTruthy();
  expect(within(rows[0]).getByText(/status confirmed/)).toBeTruthy();

  // Acting on a gap happens on the surface that owns it.
  expect(within(rows[0]).getByRole('link', { name: 'Assign a drill' }).getAttribute('href'))
    .toBe('/coach/progression-intelligence');
});

test('an athlete with no attendance on record is said to have none, not given a fabricated date', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<CoachPassbookGapsPage />);
  });

  const rows = screen.getAllByRole('listitem');
  expect(within(rows[1]).getByText('No recorded visit')).toBeTruthy();
});

test('every severity carries a glyph and its label, never colour alone (Law 3)', async () => {
  global.fetch = mockFetch({});

  await act(async () => {
    render(<CoachPassbookGapsPage />);
  });

  const rows = screen.getAllByRole('listitem');
  // Queried by class rather than by text precisely because the mark is more
  // than its text: a badge whose glyph went missing still reads 'high'.
  const high = rows[0].querySelector('.badge');
  expect(high?.className).toContain('badge--restricted');
  expect(high?.textContent).toContain('▲');
  expect(high?.textContent).toContain('high');

  const critical = rows[1].querySelector('.badge');
  // A critical gap is not a medical stop: the restricted rung and ▲, told
  // apart from high by its word (OW25-48 A; lane U1, SC2-2).
  expect(critical?.className).toContain('badge--restricted');
  expect(critical?.className).not.toContain('badge--locked');
  expect(critical?.textContent).toContain('▲');
  expect(critical?.textContent).toContain('critical');
});

test('the empty state does not read as "nobody is slipping"', async () => {
  global.fetch = mockFetch({ items: [] });

  await act(async () => {
    render(<CoachPassbookGapsPage />);
  });

  expect(screen.getByText('No open gaps in these books')).toBeTruthy();
  expect(screen.getByText(/not proof that nobody has/)).toBeTruthy();
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
});

test('the page says out loud that it is a queue of gaps, not of absences', async () => {
  global.fetch = mockFetch({ items: [] });

  await act(async () => {
    render(<CoachPassbookGapsPage />);
  });

  expect(screen.getByText(/queue of gaps, not of absences/)).toBeTruthy();
  expect(screen.getByText(/does not appear here however long they have been away/)).toBeTruthy();
});

test('a refused role gets a stamp, not an error banner (Law 7)', async () => {
  global.fetch = mockFetch({ status: 403 });

  await act(async () => {
    render(<CoachPassbookGapsPage />);
  });

  expect(screen.getByText('WRONG DOOR')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('No open gaps in these books')).toBeNull();
});

test('a failed read admits gaps may be open that are not shown', async () => {
  global.fetch = mockFetch({ status: 500 });

  await act(async () => {
    render(<CoachPassbookGapsPage />);
  });

  expect(screen.getByText(/Gaps may be open that are not shown here/)).toBeTruthy();
  expect(screen.queryByText('No open gaps in these books')).toBeNull();
});

// Lane AS-11 (app scrub CF-23): both row links open their page on the row's
// athlete, who travels in page memory, never in an address (#1474 Q2 = C;
// lane AS-11 Q3 = A).
describe('each row opens its pages on that row\'s athlete (lane AS-11)', () => {
  afterEach(() => {
    takeArrivalAthlete(PASSBOOK_PAGE);
    takeArrivalAthlete(PROGRESSION_INTELLIGENCE_PAGE);
  });

  async function rows() {
    global.fetch = mockFetch({});
    await act(async () => {
      render(<CoachPassbookGapsPage />);
    });
    return screen.getAllByRole('listitem');
  }

  test('no link carries an athlete id in its address', async () => {
    const listed = await rows();
    for (const row of listed) {
      expect(within(row).getByRole('link', { name: 'Open passbook' }).getAttribute('href')).toBe('/coach/passbook');
      expect(within(row).getByRole('link', { name: 'Assign a drill' }).getAttribute('href'))
        .toBe('/coach/progression-intelligence');
    }
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toMatch(/ath-1|ath-2|athlete_id/);
    }
  });

  test('"Open passbook" hands the row\'s athlete to the Passbook only', async () => {
    const listed = await rows();
    fireEvent.click(within(listed[1]).getByRole('link', { name: 'Open passbook' }));
    expect(takeArrivalAthlete(PROGRESSION_INTELLIGENCE_PAGE)).toBeNull();
    fireEvent.click(within(listed[1]).getByRole('link', { name: 'Open passbook' }));
    expect(takeArrivalAthlete(PASSBOOK_PAGE)).toBe('ath-2');
  });

  test('"Assign a drill" hands the row\'s athlete to Progression Intelligence only', async () => {
    const listed = await rows();
    fireEvent.click(within(listed[0]).getByRole('link', { name: 'Assign a drill' }));
    expect(takeArrivalAthlete(PASSBOOK_PAGE)).toBeNull();
    fireEvent.click(within(listed[0]).getByRole('link', { name: 'Assign a drill' }));
    expect(takeArrivalAthlete(PROGRESSION_INTELLIGENCE_PAGE)).toBe('ath-1');
  });

  test.each([
    ['ctrl', { ctrlKey: true }],
    ['cmd', { metaKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['middle button', { button: 1 }],
  ])('a %s click, which opens another tab, hands nothing over', async (_name, init) => {
    const listed = await rows();
    // Read after each click: a second hand-off would replace the first.
    fireEvent.click(within(listed[0]).getByRole('link', { name: 'Open passbook' }), init);
    expect(takeArrivalAthlete(PASSBOOK_PAGE)).toBeNull();
    fireEvent.click(within(listed[0]).getByRole('link', { name: 'Assign a drill' }), init);
    expect(takeArrivalAthlete(PROGRESSION_INTELLIGENCE_PAGE)).toBeNull();
  });
});
