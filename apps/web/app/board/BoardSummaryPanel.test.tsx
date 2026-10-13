/**
 * @jest-environment jsdom
 */

// The board aggregate contract carries three different facts -- a measured
// figure, a cohort too small to publish, and a period with no records. These
// pin that all three survive rendering, because a suppressed safeguarding
// figure drawn as a blank or a zero reads to a director as a measurement.

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import BoardSummaryPanel, {
  type BoardReport,
  boardMetricDisplay,
  defaultReportWindow,
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

/*
 * THE DATED BOARD REPORT (RP-04): the last 30 gym days by default, the window
 * sent as asked, the report with its window, when it was made, the same three
 * states in words, and its definitions; Print; a refused report says why.
 */
describe('the board report section (RP-04)', () => {
  function reportFixture(): BoardReport {
    return { ...summaryFixture(), window: { from: '2026-09-01', to: '2026-09-30' }, timeZone: 'America/New_York' };
  }

  function routedFetch(reportResponse: () => { ok: boolean; json: () => Promise<unknown> }): jest.Mock {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('from=')) return reportResponse();
      return { ok: true, json: async () => ({ success: true, summary: summaryFixture() }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  test('the default window is the 30 gym days ending today', () => {
    // 03:30 UTC on Oct 14 is 11:30 pm on Oct 13 in the gym.
    expect(defaultReportWindow(Date.parse('2026-10-14T03:30:00.000Z'))).toEqual({ from: '2026-09-14', to: '2026-10-13' });
    // Across a month and a year.
    expect(defaultReportWindow(Date.parse('2026-01-05T15:00:00.000Z'))).toEqual({ from: '2025-12-07', to: '2026-01-05' });
  });

  test('makes the report for the window chosen, with its window, time made, figures in words and definitions', async () => {
    const fetchMock = routedFetch(() => ({ ok: true, json: async () => ({ success: true, report: reportFixture() }) }));
    await act(async () => {
      render(<BoardSummaryPanel />);
    });

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Make report' }));
    });

    const reportCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('from='));
    expect(reportCalls).toHaveLength(1);
    expect(String(reportCalls[0]![0])).toContain('/api/pilot/board/summary?from=2026-09-01&to=2026-09-30');

    const report = screen.getByRole('article', { name: 'Board report' });
    expect(report.textContent).toContain('Reporting window: 2026-09-01 to 2026-09-30 (gym days, inclusive).');
    // 12:00 UTC on Jul 24 is 8:00 am in the gym.
    expect(report.textContent).toMatch(/Made [^(]*8:00[^(]*\(gym time\)/);
    const row = (label: string) => Array.from(within(report).getByText(label).closest('tr')!.querySelectorAll('td')).map((cell) => cell.textContent);
    expect(row('Active athletes')[0]).toBe('12');
    expect(row('Training sessions')[0]).toBe('Suppressed');
    expect(row('Goals completed')[0]).toBe('No records');
    expect(row('Coach reviews')[1]).toContain('Approved 75% (6 of 8)');
    expect(within(report).getByText('Definitions')).toBeTruthy();
    expect(report.textContent).toContain('as of when this report was made');
    expect(report.textContent).toContain('No individual athlete appears in this report.');
  });

  test('Print prints once a report is made', async () => {
    routedFetch(() => ({ ok: true, json: async () => ({ success: true, report: reportFixture() }) }));
    const print = jest.spyOn(window, 'print').mockImplementation(() => undefined);
    await act(async () => {
      render(<BoardSummaryPanel />);
    });
    expect(screen.queryByRole('button', { name: 'Print' })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Make report' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));

    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });

  test('a refused report says why and shows no report', async () => {
    routedFetch(() => ({ ok: false, json: async () => ({ error: 'from must be on or before to.' }) }));
    await act(async () => {
      render(<BoardSummaryPanel />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Make report' }));
    });

    expect(screen.getByRole('alert').textContent).toContain('from must be on or before to.');
    expect(screen.queryByRole('article', { name: 'Board report' })).toBeNull();
  });

  test('a reversed window is not sent', async () => {
    const fetchMock = routedFetch(() => ({ ok: true, json: async () => ({ success: true, report: reportFixture() }) }));
    await act(async () => {
      render(<BoardSummaryPanel />);
    });

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-01' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Make report' }));
    });

    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('from='))).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain('on or before');
  });
});
