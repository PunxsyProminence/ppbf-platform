/**
 * @jest-environment jsdom
 */

// Pilot blocker B2 (readiness check 2026-10-20; live walkthrough 2026-10-19): the coach's
// Attendance Check-In picker opened on the OLDEST class the scheduler returned (a test class from
// two weeks earlier), so one tap marked the wrong class. It opens on the class running now. The
// rule's cases are pinned with a fixed clock in src/shared/attendanceDefaultClass.test.ts; this
// proves the page uses it. The classes are placed relative to the real clock so the case holds on
// any day the suite runs.
//
// Pinned on the rendered DOM (jsdom). How it looks on a gym tablet has not been checked.

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

const MINUTE = 60_000;

function classAt(class_id: string, title: string, startOffsetMinutes: number) {
  const start = Date.now() + startOffsetMinutes * MINUTE;
  return {
    class_id,
    title,
    start_at: new Date(start).toISOString(),
    end_at: new Date(start + 60 * MINUTE).toISOString(),
    location: 'Main Floor',
    capacity: 16,
    coach_account_id: 'account-coach',
    status: 'open',
    registered_count: 0,
  };
}

function jsonResponse(payload: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
}

function installFetchMock(classes: unknown[]) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, role: 'coach', athlete_id: null });
    }
    if (url.endsWith('/api/pilot/athletes/list')) {
      return jsonResponse({ items: [{ athlete_id: 'athlete-1', full_name: 'An Athlete' }] });
    }
    if (url.endsWith('/api/pilot/admin/staff')) {
      return jsonResponse({ members: [] });
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      return jsonResponse({ ok: true, role: 'coach', classes, registrations: [], coaching_requests: [], attendance: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('a coach\'s attendance picker opens on the class running now, not the oldest class on the list', async () => {
  // Oldest first, the way the scheduler lists them.
  installFetchMock([
    classAt('class-old', 'ZZ old test class', -16 * 24 * 60),
    classAt('class-now', 'Tonight', -10),
    classAt('class-next-week', 'Next week', 7 * 24 * 60),
  ]);
  render(<SchedulerPage />);
  await screen.findByText('Class Schedule');

  const picker = (await screen.findByRole('combobox', { name: 'Class' })) as HTMLSelectElement;
  await waitFor(() => expect(picker.value).toBe('class-now'));
  expect(screen.getByRole('combobox', { name: 'Athlete to mark' })).toBeInTheDocument();
});
