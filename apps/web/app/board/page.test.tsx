/**
 * @jest-environment jsdom
 */

// The aggregate endpoint is the only measured data a board seat may read, so
// the hub has to actually ask for it and has to show what came back.

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import BoardHubPage from './page';
import type { BoardSummary } from './BoardSummaryPanel';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

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
