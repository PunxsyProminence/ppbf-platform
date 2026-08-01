/**
 * @jest-environment jsdom
 */

// The board aggregate contract carries three different facts -- a measured
// figure, a cohort too small to publish, and a period with no records. These
// pin that all three survive rendering, because a suppressed safeguarding
// figure drawn as a blank or a zero reads to a director as a measurement.

import { act, render, screen, within } from '@testing-library/react';

import BoardSummaryPanel, {
  boardMetricDisplay,
  formatMeasuredAt,
  type BoardSummary,
} from './BoardSummaryPanel';
import type { BoardSummary as ServerBoardSummary } from '@/src/server/pilot/boardSummary';

// The panel restates the contract locally so no database driver crosses the
// client boundary. This fails the moment the server contract moves.
const contractsMatch: ServerBoardSummary = {} as BoardSummary;
void contractsMatch;

function summaryFixture(overrides: Partial<BoardSummary> = {}): BoardSummary {
  return {
    scope: 'organization_aggregate',
    minimumCohortSize: 5,
    generatedAt: '2026-07-24T12:00:00.000Z',
    activeAthletes: { status: 'available', count: 12 },
    trainingSessions30Days: {
      status: 'insufficient_data',
      count: null,
      completedCount: null,
      completionRate: null,
    },
    goalStatusBuckets: {
      active: { status: 'available', count: 9 },
      completed: { status: 'unavailable', count: null },
      other: { status: 'unavailable', count: null },
    },
    coachReviews30Days: {
      status: 'available',
      count: 8,
      approvedCount: 6,
      approvalRate: 0.75,
    },
    ...overrides,
  };
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPanel(summary: BoardSummary | null, ok = true) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok,
    json: async () => (summary ? { success: true, summary } : { success: false }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  await act(async () => {
    render(<BoardSummaryPanel />);
  });

  return fetchMock;
}

function tile(label: string): HTMLElement {
  const heading = screen.getByText(label);
  const article = heading.closest('article');
  if (!article) {
    throw new Error(`No tile rendered for ${label}`);
  }
  return article;
}

test('calls the board aggregate endpoint with the session cookie', async () => {
  const fetchMock = await renderPanel(summaryFixture());

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toContain('/api/pilot/board/summary');
  expect(init).toMatchObject({ credentials: 'include' });
});

test('renders a measured figure as a number', async () => {
  await renderPanel(summaryFixture());

  expect(within(tile('Active Athletes')).getByText('12')).toBeTruthy();
  expect(within(tile('Coach Reviews (30 Days)')).getByText('Approved 75% (6 of 8)')).toBeTruthy();
});

test('renders a suppressed figure as suppressed, never as blank or zero', async () => {
  await renderPanel(summaryFixture());

  const suppressed = tile('Training Sessions (30 Days)');
  expect(within(suppressed).getByText('Suppressed')).toBeTruthy();
  expect(within(suppressed).getByText(/Fewer than 5 athletes contributed/)).toBeTruthy();
  expect(suppressed.textContent).not.toMatch(/\b0\b/);
});

test('distinguishes an empty period from a suppressed cohort', async () => {
  await renderPanel(summaryFixture());

  const empty = tile('Goals Completed');
  expect(within(empty).getByText('No records')).toBeTruthy();
  expect(within(empty).getByText(/No completed goals recorded in this period/)).toBeTruthy();
  expect(empty.textContent).not.toMatch(/Suppressed/);
  expect(empty.textContent).not.toMatch(/\b0\b/);
});

test('states when the figures were measured', async () => {
  await renderPanel(summaryFixture());

  expect(screen.getByText('Measured 2026-07-24 12:00 UTC')).toBeTruthy();
});

test('reports a failed read instead of drawing an empty aggregate', async () => {
  await renderPanel(null, false);

  expect(screen.getByText('Unable to load the organization aggregate.')).toBeTruthy();
  expect(screen.queryByText('Active Athletes')).toBeNull();
});

describe('boardMetricDisplay', () => {
  test.each([
    ['insufficient_data' as const, 'Suppressed'],
    ['unavailable' as const, 'No records'],
  ])('never yields a numeral for the %s state', (status, expected) => {
    const display = boardMetricDisplay({ status, count: null }, 5, 'sessions');

    expect(display.value).toBe(expected);
    expect(display.value).not.toMatch(/[0-9]/);
  });
});

describe('formatMeasuredAt', () => {
  test('returns null rather than an invented time for an unparseable stamp', () => {
    expect(formatMeasuredAt('not-a-timestamp')).toBeNull();
  });
});
