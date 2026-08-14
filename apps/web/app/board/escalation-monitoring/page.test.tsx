/**
 * @jest-environment jsdom
 */

// The board's only window into the escalation ladder is count-only and
// k-anonymity-gated. These pin the two ways a number here could mislead a
// board member: an empty ladder drawn as a measured zero, and a small-cohort
// count published instead of being withheld.

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import BoardEscalationMonitoringPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

type Metric = { status: 'available' | 'unavailable' | 'insufficient_data'; count: number | null };

const empty: Metric = { status: 'unavailable', count: null };

function summaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'organization_aggregate',
    minimumCohortSize: 5,
    generatedAt: '2026-08-10T12:00:00.000Z',
    openBySeverity: { critical: empty, high: empty, moderate: empty, low: empty },
    ...overrides,
  };
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPage(summary: unknown) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, summary }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  await act(async () => {
    render(<BoardEscalationMonitoringPage />);
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

test('reads the board summary endpoint, never the escalation rows', async () => {
  const fetchMock = await renderPage(summaryFixture());

  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain('/api/pilot/board/escalation-summary');
});

test('an empty ladder says which zero it is instead of printing a bare 0', async () => {
  await renderPage(summaryFixture());

  expect(screen.getByText('Read this zero correctly')).toBeTruthy();
  expect(screen.getAllByText('None open')).toHaveLength(4);
  expect(screen.queryByText('0')).toBeNull();
});

test('a suppressed cohort is a withheld stamp, never a small real number', async () => {
  await renderPage(summaryFixture({
    openBySeverity: {
      critical: { status: 'insufficient_data', count: null },
      high: empty,
      moderate: empty,
      low: empty,
    },
  }));

  const critical = tile('Critical');
  expect(critical.textContent).toContain('Suppressed');
  expect(critical.textContent).toContain('Fewer than 5 athletes');
  // A suppressed bucket is not "nothing open" -- the reassuring note must
  // not render alongside a withheld count.
  expect(screen.queryByText('Read this zero correctly')).toBeNull();
});

test('a live critical count wears the severity band with its count', async () => {
  await renderPage(summaryFixture({
    openBySeverity: {
      critical: { status: 'available', count: 7 },
      high: empty,
      moderate: empty,
      low: empty,
    },
  }));

  const critical = tile('Critical');
  expect(critical.textContent).toContain('7');
  expect(critical.textContent).toContain('Open escalations staff have raised');
});

test('a failed read is an error, never an empty ladder', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;

  await act(async () => {
    render(<BoardEscalationMonitoringPage />);
  });

  expect(screen.getByText('Unable to load the escalation summary.')).toBeTruthy();
  expect(screen.queryByText('Read this zero correctly')).toBeNull();
});
