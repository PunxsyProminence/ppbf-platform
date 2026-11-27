/**
 * @jest-environment jsdom
 */

// Every seat page rendered the same workspace to any board session, so the
// Treasurer page was the Treasurer page in name only. It now opens for the
// holders of that seat, for the President and Chair, and for the platform
// owner reading -- and everyone else on the board leaves for the hub rather
// than for /login, which they have already satisfied.

import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';

import BoardMemberDashboard from './BoardMemberDashboard';
import {
  BOARD_AGGREGATE_BOUNDARY_STATEMENT,
  boardSeatMap,
  type BoardSeatSlug,
} from '@/app/board/boardWorkspaceConfig';
import { useBoardSession } from './BoardRoleGate';

const replace = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: (path: string) => replace(path) }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// The aggregate panel owns its own fetch and its own suppression rules; this
// suite is about who may see the workspace at all.
jest.mock('@/app/board/BoardSummaryPanel', () => ({
  __esModule: true,
  default: () => <div>organization aggregate panel</div>,
}));

jest.mock('./BoardRoleGate', () => ({
  __esModule: true,
  useBoardSession: jest.fn(),
}));

const mockUseBoardSession = jest.mocked(useBoardSession);

function renderSeat(
  seat: BoardSeatSlug,
  session: { role: 'board' | 'platform_owner'; seats: BoardSeatSlug[] } | null,
) {
  mockUseBoardSession.mockReturnValue(session);
  render(<BoardMemberDashboard seat={boardSeatMap[seat]} />);
}

afterEach(() => {
  jest.clearAllMocks();
});

test('the holder of a seat opens that seat workspace', () => {
  renderSeat('treasurer', { role: 'board', seats: ['treasurer'] });

  expect(screen.getByRole('heading', { name: 'Treasurer Workspace' })).toBeDefined();
  expect(screen.getByText('You hold this seat.')).toBeDefined();
  expect(replace).not.toHaveBeenCalled();
});

test.each(['president', 'chair'] as const)('%s opens another seat under governance oversight', (oversight) => {
  renderSeat('treasurer', { role: 'board', seats: [oversight] });

  expect(screen.getByRole('heading', { name: 'Treasurer Workspace' })).toBeDefined();
  expect(screen.getByText(/governance oversight of every seat/i)).toBeDefined();
  expect(replace).not.toHaveBeenCalled();
});

test('a board member holding another seat is sent to the hub, not to /login', () => {
  renderSeat('treasurer', { role: 'board', seats: ['secretary'] });

  expect(replace).toHaveBeenCalledWith('/board');
  expect(replace).not.toHaveBeenCalledWith('/login');
  expect(screen.queryByRole('heading', { name: 'Treasurer Workspace' })).toBeNull();
  // Never a dead end: the destination is on screen while the route changes.
  // Named by the title of the page it opens (lane AS-12, BOA-11).
  expect(screen.getByRole('link', { name: 'Board Hub' }).getAttribute('href')).toBe('/board');
});

test('a board member with no seat assigned gets the hub', () => {
  renderSeat('safety-director', { role: 'board', seats: [] });

  expect(replace).toHaveBeenCalledWith('/board');
  expect(screen.queryByRole('heading', { name: 'Program & Safety Director Workspace' })).toBeNull();
});

test('platform owner reads any seat and is told the view is read-only', () => {
  renderSeat('secretary', { role: 'platform_owner', seats: [] });

  expect(screen.getByRole('heading', { name: 'Secretary Workspace' })).toBeDefined();
  expect(screen.getByText(/Read-only, and no board seat is held/)).toBeDefined();
  expect(replace).not.toHaveBeenCalled();
});

test('a page with no board session behind it leaves rather than rendering the seat', () => {
  renderSeat('president', null);

  expect(replace).toHaveBeenCalledWith('/board');
  expect(screen.queryByRole('heading', { name: 'President Workspace' })).toBeNull();
});

test('the seat page repeats the aggregate boundary the hub states, and does not pass its own gate off as the authority', () => {
  renderSeat('at-large', { role: 'board', seats: ['at-large'] });

  expect(screen.getByText(BOARD_AGGREGATE_BOUNDARY_STATEMENT)).toBeDefined();
  expect(screen.getByText(/Access is decided by the server on every request/)).toBeDefined();
});

test('the workspace shows no placeholder standing in for a figure', () => {
  renderSeat('treasurer', { role: 'board', seats: ['treasurer'] });

  // 'Unavailable' beside 'Reserve Monitoring' reads as a reserve figure that
  // failed to load. No reserve is stored anywhere in the platform.
  expect(screen.queryAllByText('Unavailable')).toHaveLength(0);
  expect(screen.getByText('Not stored by this platform')).toBeDefined();
  expect(screen.getByText('- Financial reserves and budgets')).toBeDefined();
});

// Lane BT, BOA-16: grant obligations ARE stored (/admin/grants), so they are not on the
// "not stored" list; the seat is told who keeps them, by that page's title, with no link
// (the page admits the gym admin only).
test('grants are said to be kept by the gym admin, not listed as not stored', () => {
  renderSeat('treasurer', { role: 'board', seats: ['treasurer'] });

  const notHeld = screen.getByRole('heading', { name: 'Not stored by this platform' }).closest('section') as HTMLElement;
  const listed = Array.from(notHeld.querySelectorAll('li')).map((item) => item.textContent ?? '');
  expect(listed.some((item) => /grant/i.test(item))).toBe(false);
  expect(within(notHeld).getByText('Grant obligations are kept by the gym admin, on Grant Obligations.')).toBeDefined();
  expect(notHeld.querySelector('a[href="/admin/grants"]')).toBeNull();
  // Lane BT, BOA-19: "none is being suppressed", the board's one word for it.
  expect(document.body.textContent).not.toMatch(/withheld/i);
});

test('a 501(c)(3) is not described as owned', () => {
  renderSeat('president', { role: 'board', seats: ['president'] });

  expect(screen.queryByText('Veteran-Owned')).toBeNull();
  expect(screen.getByText('Veteran-Founded')).toBeDefined();
});

test('the compliance link matches what that page actually is', () => {
  renderSeat('safety-director', { role: 'board', seats: ['safety-director'] });

  const link = screen.getByRole('link', { name: 'Hand-Filed Compliance Register' });
  expect(link.getAttribute('href')).toBe('/board/compliance-monitoring');
  expect(screen.queryByText(/Compliance Monitoring \(Planned\)/)).toBeNull();
});

test('the platform owner is not shown the board-only compliance register door (F-003)', () => {
  // compliance-summary serves ['board'] alone; the platform owner reads seat
  // pages as an observer and must not be handed a link that ends in a refusal.
  renderSeat('safety-director', { role: 'platform_owner', seats: [] });

  expect(screen.getByText('Platform owner view. Read-only, and no board seat is held.')).toBeDefined();
  expect(screen.queryByRole('link', { name: 'Hand-Filed Compliance Register' })).toBeNull();
  expect(document.querySelector('a[href="/board/compliance-monitoring"]')).toBeNull();
});

// Lane AS-12, BOA-03: the way to the board's three reads was in the aside, after
// every other block (and under the main column on a narrow screen). It is one
// row, directly under the header. Who is shown which link is pinned in
// app/board/BoardWorkspaceLinks.test.tsx; this pins where the row stands.
describe('Workspace Links stands directly under the header (lane AS-12, BOA-03)', () => {
  const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  test('the row comes after the header and before every other block', () => {
    renderSeat('treasurer', { role: 'board', seats: ['treasurer'] });

    const header = screen.getByRole('heading', { name: 'Treasurer Workspace' }).closest('header') as HTMLElement;
    const row = screen.getByRole('navigation', { name: 'Workspace Links' });
    expect(header.nextElementSibling).toBe(row);
    expect(follows(row, screen.getByText('Seat Access'))).toBe(true);
    expect(follows(row, screen.getByText('organization aggregate panel'))).toBe(true);
    expect(follows(row, screen.getByRole('heading', { name: 'Not stored by this platform' }))).toBe(true);
  });

  test('there is one Workspace Links block, and it holds Board Hub and the three reads', () => {
    renderSeat('treasurer', { role: 'board', seats: ['treasurer'] });

    expect(screen.getAllByText('Workspace Links')).toHaveLength(1);
    const row = within(screen.getByRole('navigation', { name: 'Workspace Links' }));
    expect(row.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Board Hub', '/board'],
      ['Program Aggregates', '/board/aggregates'],
      ['Escalation Ladder', '/board/escalation-monitoring'],
      ['Hand-Filed Compliance Register', '/board/compliance-monitoring'],
    ]);
    // Each read is linked once on the page: the aside's copy moved, it was not doubled.
    expect(document.querySelectorAll('a[href="/board/aggregates"]')).toHaveLength(1);
  });

  // BOA-07: seat assignment is the President's one administrative control.
  test('the President workspace links Board Seats; another seat does not', () => {
    renderSeat('president', { role: 'board', seats: ['president'] });
    expect(screen.getByRole('link', { name: 'Board Seats' }).getAttribute('href')).toBe('/admin/board-seats');
  });

  test('the Treasurer workspace has no Board Seats link', () => {
    renderSeat('treasurer', { role: 'board', seats: ['treasurer'] });
    expect(screen.queryByRole('link', { name: 'Board Seats' })).toBeNull();
  });

  // OD-2026-10-05-006 part (b), F-003 option A: the platform owner is not served
  // the board's aggregates. Program Aggregates and Escalation Ladder were still
  // offered to that role here and opened on "served to board members only".
  test('the platform owner is offered Board Hub and none of the board-only pages', () => {
    renderSeat('president', { role: 'platform_owner', seats: [] });

    const row = within(screen.getByRole('navigation', { name: 'Workspace Links' }));
    expect(row.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/board']);
    for (const href of ['/board/aggregates', '/board/escalation-monitoring', '/board/compliance-monitoring', '/admin/board-seats']) {
      expect(document.querySelector(`a[href="${href}"]`)).toBeNull();
    }
  });
});

test('an unbuilt module carries the placeholder stamp in the same view as a built one', () => {
  renderSeat('chair', { role: 'board', seats: ['chair'] });

  expect(screen.getByText('Organization Aggregate')).toBeDefined();
  expect(screen.getAllByText('Available now').length).toBeGreaterThan(0);
  expect(screen.getAllByText('PLANNED | FRONT-END PLACEHOLDER | BACKEND REQUIRED').length).toBeGreaterThan(0);
});

test('a tab with nothing behind it says so in the strip, before it is opened', () => {
  // Eight of the ten tabs are entirely placeholder, and the strip used to
  // render all of them identically -- a fiduciary found out which by clicking
  // through them one at a time.
  renderSeat('treasurer', { role: 'board', seats: ['treasurer'] });

  const tabs = screen.getAllByRole('button').filter((node) => node.getAttribute('aria-pressed') !== null);
  expect(tabs).toHaveLength(10);

  const stamped = tabs.filter((tab) => tab.textContent?.includes('Planned')).map((tab) => tab.textContent);
  expect(stamped).toEqual([
    'GovernancePlanned', 'StrategyPlanned', 'MeetingsPlanned', 'TasksPlanned',
    'PoliciesPlanned', 'ResolutionsPlanned', 'CommitteesPlanned', 'DocumentsPlanned',
  ]);

  // The two tabs that can load something are the two that escape the stamp.
  expect(tabs.find((tab) => tab.textContent === 'Overview')).toBeDefined();
  expect(tabs.find((tab) => tab.textContent === 'Compliance')).toBeDefined();
});

test('the word SHADOW does not appear on a board wall', () => {
  // The room's purpose line forbids the ask-SHADOW surface here outright. An
  // eleventh tab named SHADOW, and a permanent article narrating the denial
  // across four bullets, were both honest and both put the word on this wall
  // on every seat page. The boundary is stated instead, in fiduciary voice.
  renderSeat('treasurer', { role: 'board', seats: ['treasurer'] });

  expect(document.body.textContent).not.toMatch(/shadow/i);
  expect(screen.getByText(BOARD_AGGREGATE_BOUNDARY_STATEMENT)).toBeDefined();
});

test('the identity panel carries the two facts and neither slogan', () => {
  renderSeat('president', { role: 'board', seats: ['president'] });

  expect(screen.getByText('Veteran-Founded')).toBeDefined();
  expect(screen.getByText('501(c)(3) Public Charity')).toBeDefined();
  // 'Mission-Focused Governance' and 'Community Impact Oversight' said nothing
  // and said it in the same material and voice as the count tiles.
  expect(screen.queryByText('Mission-Focused Governance')).toBeNull();
  expect(screen.queryByText('Community Impact Oversight')).toBeNull();
});

// Lane W4-3, FN-4b (GO on #2192, 7206014991): what is running on the floor now sits after the seat's
// aggregate panel, for a board reader only. The platform owner reading a seat does not get it.
describe('what is running on the floor now, on a seat page (lane W4-3, FN-4b)', () => {
  const originalFetch = global.fetch;
  const CLASSES = { ok: true, read_at: '2026-11-25T23:12:00.000Z', classes: [], rounds: [], total: { status: 'available', count: 6 } };
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => CLASSES }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('the seat holder gets the line directly after the aggregate panel, read once', async () => {
    renderSeat('treasurer', { role: 'board', seats: ['treasurer'] });
    const line = screen.getByRole('region', { name: 'What is running on the floor' });
    expect(await within(line).findByText('On the floor now: 6')).toBeTruthy();
    expect(line.previousElementSibling?.textContent).toBe('organization aggregate panel');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/pilot/on-the-floor/classes');
  });

  test('the platform owner reading a seat gets no line, and nothing is read for it', () => {
    renderSeat('treasurer', { role: 'platform_owner', seats: [] });
    expect(screen.getByText(/Platform owner view/)).toBeDefined();
    expect(screen.queryByRole('region', { name: 'What is running on the floor' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
