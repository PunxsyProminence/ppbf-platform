/**
 * @jest-environment jsdom
 */

// The aggregate endpoint is the only measured data a board seat may read, so
// the hub has to actually ask for it and has to show what came back.

import type { ReactNode } from 'react';
import { act, render, screen, within } from '@testing-library/react';

import { useBoardSession } from '@/components/BoardRoleGate';

import BoardHubPage from './page';
import type { BoardSummary } from './BoardSummaryPanel';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// The hub is rendered here without its layout's BoardRoleGate, so the session
// the gate would hand down is supplied per test (null where none is given).
jest.mock('@/components/BoardRoleGate', () => ({
  __esModule: true,
  useBoardSession: jest.fn(),
}));

const mockUseBoardSession = jest.mocked(useBoardSession);

beforeEach(() => {
  mockUseBoardSession.mockReturnValue(null);
});

const summary: BoardSummary = {
  scope: 'organization_aggregate',
  minimumCohortSize: 5,
  generatedAt: '2026-07-24T12:00:00.000Z',
  activeAthletes: { status: 'available', count: 12 },
  trainingSessions30Days: {
    status: 'available',
    count: 40,
    completedCount: 30,
    completionRate: 0.75,
  },
  goalStatusBuckets: {
    active: { status: 'insufficient_data', count: null },
    completed: { status: 'unavailable', count: null },
    other: { status: 'unavailable', count: null },
  },
  coachReviews30Days: {
    status: 'insufficient_data',
    count: null,
    approvedCount: null,
    approvalRate: null,
  },
};

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('reads the board aggregate endpoint and shows the figures it returns', async () => {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, summary }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  await act(async () => {
    render(<BoardHubPage />);
  });

  expect(fetchMock.mock.calls[0][0]).toContain('/api/pilot/board/summary');
  expect(screen.getByText('12')).toBeTruthy();
  expect(screen.getByText('Measured 2026-07-24 12:00 UTC')).toBeTruthy();
  expect(screen.getAllByText('Suppressed').length).toBeGreaterThan(0);
});

// Lane AS-12, BOA-04: a board member with no seat lands on the hub
// (pilotRoleRouting.ts), and the hub linked none of the board's three reads.
describe('the hub links the board\'s reads directly under its header (lane AS-12, BOA-04)', () => {
  const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  async function renderHub(session: ReturnType<typeof useBoardSession>) {
    mockUseBoardSession.mockReturnValue(session);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, summary }),
    }) as unknown as typeof fetch;
    await act(async () => {
      render(<BoardHubPage />);
    });
  }

  test('a board member with no seat reaches the three reads and Board Seats from the first block under the header', async () => {
    await renderHub({ role: 'board', seats: [] });

    const header = screen.getByRole('heading', { name: 'Board Hub' }).closest('header') as HTMLElement;
    const row = screen.getByRole('navigation', { name: 'Workspace Links' });
    expect(header.nextElementSibling).toBe(row);
    expect(follows(row, screen.getByRole('heading', { name: 'Aggregate boundary' }))).toBe(true);
    expect(within(row).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Program Aggregates', '/board/aggregates'],
      ['Escalation Ladder', '/board/escalation-monitoring'],
      ['Hand-Filed Compliance Register', '/board/compliance-monitoring'],
      ['Board Seats', '/admin/board-seats'],
    ]);
  });

  // OD-2026-10-05-006 part (b), F-003 option A: those pages are not served to the platform owner.
  test('the platform owner is shown no link to a page that refuses that role', async () => {
    await renderHub({ role: 'platform_owner', seats: [] });

    expect(screen.getByRole('heading', { name: 'Board Hub' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Workspace Links' })).toBeNull();
    for (const href of ['/board/aggregates', '/board/escalation-monitoring', '/board/compliance-monitoring', '/admin/board-seats']) {
      expect(document.querySelector(`a[href="${href}"]`)).toBeNull();
    }
  });
});
