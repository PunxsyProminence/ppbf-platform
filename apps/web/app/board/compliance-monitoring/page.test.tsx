/**
 * @jest-environment jsdom
 */

// Nothing files into this register except a person, so "0 critical" is a
// statement about reporting. These pin the two ways that number could mislead
// a Program & Safety Director: an empty register drawn as a measured zero, and
// a one-athlete count published next to a date.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import BoardComplianceMonitoringPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

type Metric = { status: 'available' | 'unavailable' | 'insufficient_data'; count: number | null };

const empty: Metric = { status: 'unavailable', count: null };

function summaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    audience: 'board',
    minimumCohortSize: 5,
    generatedAt: '2026-07-24T12:00:00.000Z',
    total: empty,
    severity: { critical: empty, high: empty, medium: empty, low: empty },
    status: {
      new: empty,
      acknowledged: empty,
      escalated: empty,
      resolved: empty,
      dismissed: empty,
    },
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
    render(<BoardComplianceMonitoringPage />);
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

test('says which zero it is instead of printing a bare 0', async () => {
  await renderPage(summaryFixture());

  const critical = tile('Critical');
  expect(within(critical).getByText('None filed')).toBeTruthy();
  expect(within(critical).getByText(/Nobody has filed one/)).toBeTruthy();
  expect(critical.textContent).not.toMatch(/\b0\b/);

  expect(screen.getByText(/No compliance violation has ever been filed/)).toBeTruthy();
  expect(screen.getByText(/no one has filed one, not that nothing has happened/)).toBeTruthy();
});

test('suppresses a bucket drawn from fewer than five athletes', async () => {
  await renderPage(summaryFixture({
    total: { status: 'available', count: 14 },
    severity: {
      critical: { status: 'insufficient_data', count: null },
      high: { status: 'available', count: 13 },
      medium: empty,
      low: empty,
    },
  }));

  const critical = tile('Critical');
  expect(within(critical).getByText('Suppressed')).toBeTruthy();
  expect(within(critical).getByText(/Fewer than 5 athletes are involved/)).toBeTruthy();
  expect(critical.textContent).not.toMatch(/\b1\b/);

  expect(within(tile('High')).getByText('13')).toBeTruthy();
});

test('carries the same distinction into the status filter labels', async () => {
  await renderPage(summaryFixture({
    total: { status: 'available', count: 14 },
    status: {
      new: { status: 'insufficient_data', count: null },
      acknowledged: { status: 'available', count: 9 },
      escalated: empty,
      resolved: empty,
      dismissed: empty,
    },
  }));

  expect(screen.getByRole('button', { name: 'new (suppressed)' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'acknowledged (9)' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'escalated (none filed)' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'All (14)' })).toBeTruthy();
});

test('claims neither automated nor real-time monitoring', async () => {
  await renderPage(summaryFixture());

  expect(document.body.textContent).not.toMatch(/automated/i);
  expect(document.body.textContent).not.toMatch(/real-time/i);
  expect(screen.getByText(/platform runs no violation detector/)).toBeTruthy();
});

test('states when the register was read', async () => {
  await renderPage(summaryFixture());

  expect(screen.getByText('Read 2026-07-24 12:00 UTC')).toBeTruthy();
});

test('refetches with the selected status filter', async () => {
  const fetchMock = await renderPage(summaryFixture());

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'escalated (none filed)' }));
  });

  expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]).toContain('status=escalated');
});

// A filter narrows the view, so the same emptiness means something narrower.
test('does not claim an empty register while a status filter is applied', async () => {
  await renderPage(summaryFixture());

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'escalated (none filed)' }));
  });

  expect(screen.queryByText(/No compliance violation has ever been filed/)).toBeNull();
  expect(screen.getByText(/No violation with the selected status has been filed/)).toBeTruthy();
  expect(within(tile('Critical')).getByText(/Nothing with this status has been filed/)).toBeTruthy();
});
