/**
 * @jest-environment jsdom
 */

// Non-blocking membership flag (capability-network audit finding):
// registerForClassTransactionally never refuses a lapsed/ended membership --
// only a training hold does that -- but the coach/admin who just registered
// this athlete needs to see it. This proves the UI half: the register
// action's success banner surfaces membership_flags from the response
// instead of silently dropping them, and stays a plain success message when
// there is nothing to flag.

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

const classes = [
  {
    class_id: 'class-1',
    title: 'Morning Fundamentals',
    start_at: '2026-08-03T13:00:00.000Z',
    end_at: '2026-08-03T14:00:00.000Z',
    location: 'Main Floor',
    capacity: 16,
    coach_account_id: 'account-coach',
    status: 'open',
    registered_count: 2,
  },
];

const athletes = [{ athlete_id: 'athlete-1', full_name: 'First Athlete' }];

function jsonResponse(payload: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
}

function installFetchMock(registerResponse: unknown): jest.Mock {
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, role: 'coach', athlete_id: null });
    }

    if (url.endsWith('/api/pilot/athletes/list')) {
      return jsonResponse({ items: athletes });
    }

    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { action?: string };
      if (body.action === 'register_class') {
        return jsonResponse(registerResponse);
      }
      throw new Error(`Unexpected POST action: ${body.action}`);
    }

    if (url.endsWith('/api/pilot/scheduler')) {
      return jsonResponse({
        ok: true,
        role: 'coach',
        classes,
        registrations: [],
        coaching_requests: [],
        attendance: [],
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('register_class membership flag banner', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a clean registration (no flags) shows the plain success message', async () => {
    installFetchMock({ ok: true, class_id: 'class-1', athlete_id: 'athlete-1', status: 'registered', membership_flags: [] });

    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');

    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Class registration submitted.'));
    expect(screen.queryByText(/membership is not active/)).toBeNull();
  });

  // The heart of the fix: registration still SUCCEEDS (this is not a block),
  // and the lapsed membership is now visible to whoever just registered the
  // athlete, where before nothing in the class-registration flow ever
  // mentioned membership status at all.
  test('a lapsed membership rides along as a visible, non-blocking warning', async () => {
    installFetchMock({
      ok: true,
      class_id: 'class-1',
      athlete_id: 'athlete-1',
      status: 'registered',
      membership_flags: [{ membership_id: 'mem-1', program_name: 'Youth Boxing', status: 'lapsed' }],
    });

    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');

    fireEvent.click(screen.getByRole('button', { name: 'Register' }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('Class registration submitted.'));
    expect(status).toHaveTextContent("this athlete's membership is not active");
    expect(status).toHaveTextContent('Youth Boxing (lapsed)');
    expect(status).toHaveTextContent('Registration was NOT blocked');
  });
});
