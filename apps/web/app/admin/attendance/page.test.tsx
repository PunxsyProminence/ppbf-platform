/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import AttendanceDashboardPage from './page';

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

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function installFetch(trendBody: unknown) {
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes('trend=1')) {
      return jsonResponse(trendBody);
    }
    return jsonResponse({ ok: true, athletes: [] });
  }) as unknown as typeof fetch;
}

test('a real weekly trend renders the trend strip with a week label', async () => {
  installFetch({
    ok: true,
    trend: [
      { week_start: '2026-07-27', present_count: 5, absent_count: 1, excused_count: 0, total_marked: 6, attendance_rate: 0.833 },
    ],
  });

  render(<AttendanceDashboardPage />);

  await screen.findByText('Weekly trend (last 8 weeks)');
  expect(screen.getByRole('img', { name: /Week of Jul 27: 83%/ })).toBeDefined();
});

test('an empty trend renders no trend strip, not an empty one', async () => {
  installFetch({ ok: true, trend: [] });

  render(<AttendanceDashboardPage />);

  await screen.findByText('No active athletes in scope yet');
  expect(screen.queryByText(/Weekly trend/)).toBeNull();
});

test('a failed trend fetch does not break the rest of the dashboard', async () => {
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes('trend=1')) {
      return jsonResponse({ error: 'nope' }, false);
    }
    return jsonResponse({ ok: true, athletes: [{ athlete_id: 'ath-1', full_name: 'Jordan T.', present_count: 1, absent_count: 0, excused_count: 0, total_marked: 1, last_marked_at: '2026-08-01T00:00:00.000Z', attendance_rate: 1 }] });
  }) as unknown as typeof fetch;

  render(<AttendanceDashboardPage />);

  await screen.findByText('Jordan T.');
  expect(screen.queryByText(/Weekly trend/)).toBeNull();
});
