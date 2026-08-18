/**
 * @jest-environment jsdom
 */

// The rollup is a staff reporting surface over records the gym already keeps.
// What these pin: the empty state never shows while the request is in flight
// ("no athletes" is a claim about the roster, not the network); a loaded row
// carries its numbers; the readiness trend badge only renders when both
// halves of the window have data; and switching the window refetches with
// the selected window_days.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import PerformanceAnalyticsPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const ITEM = {
  athlete_id: 'ath-1',
  full_name: 'Jordan Doe',
  sessions_total: 4,
  sessions_completed: 3,
  avg_rpe: 6.5,
  training_days: 8,
  readiness_count: 6,
  avg_readiness: 7.1,
  readiness_early_avg: 6.4,
  readiness_late_avg: 7.6,
  open_gaps: 1,
  active_assignments: 2,
  avg_assignment_completion: 55,
};

function mockFetch(responder: (url: string) => Promise<Response> | Response) {
  return jest.fn(async (input: RequestInfo | URL) => responder(String(input))) as unknown as typeof fetch;
}

const okWith = (items: unknown[]) =>
  ({ ok: true, json: async () => ({ window_days: 28, items }) }) as Response;

afterEach(() => {
  jest.restoreAllMocks();
});

test('the empty state is withheld while the rollup is still loading', async () => {
  global.fetch = mockFetch(() => new Promise<Response>(() => {}));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText(/Loading performance rollup/);
  expect(screen.queryByText('No athletes on your roster')).toBeNull();
});

test('the empty state appears once loading settles with an empty roster', async () => {
  global.fetch = mockFetch(() => okWith([]));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText('No athletes on your roster');
  await waitFor(() => expect(screen.queryByText(/Loading performance rollup/)).toBeNull());
});

test('a failed fetch shows the failure, never "No athletes on your roster"', async () => {
  global.fetch = mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }) as Response);

  render(<PerformanceAnalyticsPage />);

  await screen.findByText('Failed to load performance analytics: 500');
  // The regression this closes: the catch block resets `items` to `[]`, and
  // an unguarded empty check rendered the roster-empty copy right under the
  // failure banner for the same request.
  expect(screen.queryByText('No athletes on your roster')).toBeNull();
});

test('a loaded row shows its numbers and a rising readiness trend', async () => {
  global.fetch = mockFetch(() => okWith([ITEM]));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText('Jordan Doe');
  expect(screen.getByText('3/4')).toBeTruthy();
  expect(screen.getByText('8')).toBeTruthy();
  expect(screen.getByText('rising')).toBeTruthy();
  expect(screen.getByText('55%')).toBeTruthy();
});

test('no trend badge renders when only one half of the window has check-ins', async () => {
  global.fetch = mockFetch(() => okWith([{ ...ITEM, readiness_early_avg: null }]));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText('Jordan Doe');
  expect(screen.queryByText('rising')).toBeNull();
  expect(screen.queryByText('falling')).toBeNull();
  expect(screen.queryByText('steady')).toBeNull();
});

test('switching the window refetches with the selected window_days', async () => {
  const seenUrls: string[] = [];
  global.fetch = mockFetch((url) => {
    seenUrls.push(url);
    return okWith([ITEM]);
  });

  render(<PerformanceAnalyticsPage />);
  await screen.findByText('Jordan Doe');

  fireEvent.click(screen.getByRole('button', { name: '90 days' }));

  await waitFor(() => {
    expect(seenUrls[seenUrls.length - 1]).toContain('window_days=90');
  });
});
