/**
 * @jest-environment jsdom
 */

// A failed scheduler read leaves the class, record and request lists unread.
// The page must say so, not print "No classes scheduled yet." under the error
// (the #991 class). An empty read still gets its empty sentences.

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

function respond(payload: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(payload) } as Response);
}

function installFetch(schedulerOk: boolean) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/pilot/auth/session')) {
      return respond({ authenticated: true, role: 'coach', athlete_id: null });
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      return schedulerOk
        ? respond({ ok: true, role: 'coach', classes: [], registrations: [], coaching_requests: [], attendance: [] })
        : respond({ ok: false, error: 'Failed to load scheduler state' }, false);
    }
    if (url.endsWith('/api/pilot/athletes/list')) return respond({ items: [] });
    return respond({});
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('a failed scheduler read says the lists could not be loaded, never that they are empty', async () => {
  installFetch(false);
  render(<SchedulerPage />);

  expect(await screen.findByText('The schedule could not be loaded just now.')).toBeTruthy();
  expect(screen.getByText('Records could not be loaded just now.')).toBeTruthy();
  expect(screen.getByText('Coaching requests could not be loaded just now.')).toBeTruthy();
  expect(screen.queryByText('No classes scheduled yet.')).toBeNull();
  expect(screen.queryByText('No registration or attendance records visible for your role.')).toBeNull();
  expect(screen.queryByText('No coaching requests yet.')).toBeNull();
});

test('an empty scheduler read still says there is nothing yet', async () => {
  installFetch(true);
  render(<SchedulerPage />);

  expect(await screen.findByText('No classes scheduled yet.')).toBeTruthy();
  expect(screen.getByText('No coaching requests yet.')).toBeTruthy();
  expect(screen.queryByText(/could not be loaded/)).toBeNull();
});
