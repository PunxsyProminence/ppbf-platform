/**
 * @jest-environment jsdom
 */

// Every seat page rendered the same workspace to any board session, so the
// Treasurer page was the Treasurer page in name only. It now opens for the
// holders of that seat, for the President and Chair, and for the platform
// owner reading -- and everyone else on the board leaves for the hub rather
// than for /login, which they have already satisfied.

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

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
  render(<BoardMemberDashboard seat={boardSeatMap[seat]} links={[{ label: 'Board hub', href: '/board' }]} />);
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
  expect(screen.getByRole('link', { name: 'Board hub' }).getAttribute('href')).toBe('/board');
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
  expect(screen.getByText(/Financial reserves, grants, and budgets/)).toBeDefined();
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

test('an unbuilt module carries the placeholder stamp in the same view as a built one', () => {
  renderSeat('chair', { role: 'board', seats: ['chair'] });

  expect(screen.getByText('Organization Aggregate')).toBeDefined();
  expect(screen.getAllByText('Available now').length).toBeGreaterThan(0);
  expect(screen.getAllByText('PLANNED | FRONT-END PLACEHOLDER | BACKEND REQUIRED').length).toBeGreaterThan(0);
});
