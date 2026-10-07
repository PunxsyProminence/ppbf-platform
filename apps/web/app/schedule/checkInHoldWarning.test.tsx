/**
 * @jest-environment jsdom
 */

// OD-2026-10-06-024 ruling 1, "Warn only, both places": an active training hold
// does not stop an attendance check-in, and the staff member who just marked the
// athlete is told, beside the Attendance Check-In button. The scheduler route
// sends `hold_warning` to a coach or organization admin only; this proves the
// screen half -- the check-in's success still shows, the hold facts appear in
// the document next to it, and an answer without a hold adds nothing.
//
// Pinned on the rendered DOM (jsdom): the words are in the document. How they
// look has not been checked; that needs a signed-in view on staging.

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

const HOLD_WARNING = {
  hold_id: 'hold-1',
  scope: 'all_training',
  reason_category: 'administrative',
  athlete_explanation: 'Training is paused while we sort out paperwork.',
  lift_condition_text: 'Bring the signed waiver.',
  expires_at: null,
};

function jsonResponse(payload: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
}

function installFetchMock(checkInAnswer: Record<string, unknown>): jest.Mock {
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
      if (body.action === 'attendance_checkin') {
        return jsonResponse({ ok: true, class_id: 'class-1', athlete_id: 'athlete-1', ...checkInAnswer });
      }
      throw new Error(`Unexpected POST action: ${body.action}`);
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      return jsonResponse({ ok: true, role: 'coach', classes, registrations: [], coaching_requests: [], attendance: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function checkIn(): Promise<void> {
  render(<SchedulerPage />);
  await screen.findByText('Class Schedule');
  fireEvent.click(await screen.findByRole('button', { name: 'Update Attendance' }));
  await screen.findByText('Attendance updated with override.');
}

describe('attendance check-in on a held athlete', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the check-in still succeeds and the hold facts appear beside the button', async () => {
    installFetchMock({ hold_warning: HOLD_WARNING });

    await checkIn();

    const button = screen.getByRole('button', { name: 'Update Attendance' });
    const card = button.closest('article') as HTMLElement;
    const notice = (await screen.findAllByRole('status')).find((el) => el.textContent?.includes('Active Training Hold'));
    expect(notice).toBeDefined();
    // Beside the action it belongs to, not in a banner somewhere else.
    expect(card).toContainElement(notice as HTMLElement);
    expect(notice).toHaveTextContent('ALL TRAINING is currently paused for this athlete (administrative).');
    expect(notice).toHaveTextContent('The check-in was NOT blocked.');
    expect(notice).toHaveTextContent('Training is paused while we sort out paperwork.');
    expect(notice).toHaveTextContent('To lift it: Bring the signed waiver.');
    // Nothing disabled and nothing to confirm.
    expect(button).toBeEnabled();
    expect(screen.queryByText(/are you sure/i)).toBeNull();
  });

  test('a hold written without a lift condition says so rather than inventing one', async () => {
    installFetchMock({ hold_warning: { ...HOLD_WARNING, lift_condition_text: '' } });

    await checkIn();

    const notice = (await screen.findAllByRole('status')).find((el) => el.textContent?.includes('Active Training Hold'));
    expect(notice).toHaveTextContent('To lift it: not written down — ask whoever placed the hold.');
  });

  test('no hold: the check-in shows its success and nothing about a hold', async () => {
    installFetchMock({});

    await checkIn();

    expect(screen.queryByText(/training hold/i)).toBeNull();
    expect(screen.queryByText(/NOT blocked/)).toBeNull();
  });

  test('a hold that could not be read is said to be unknown, never "no hold"', async () => {
    installFetchMock({ hold_warning: 'unreadable' });

    await checkIn();

    await waitFor(() => expect(screen.getByText(/Training hold: could not be read/)).toBeInTheDocument());
    expect(screen.getByText(/The check-in was saved/)).toBeInTheDocument();
    expect(screen.queryByText('Active Training Hold')).toBeNull();
  });

  test('a malformed hold_warning is ignored rather than drawn', async () => {
    installFetchMock({ hold_warning: { scope: 'made_up', reason_category: 'x', athlete_explanation: 'y' } });

    await checkIn();

    expect(screen.queryByText(/training hold/i)).toBeNull();
  });

  test('the warning does not outlive the next action', async () => {
    const fetchMock = installFetchMock({ hold_warning: HOLD_WARNING });

    await checkIn();
    expect(await screen.findByText('Active Training Hold')).toBeInTheDocument();

    // The next check-in is for an athlete who is not held.
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, role: 'coach', athlete_id: null });
      if (url.endsWith('/api/pilot/athletes/list')) return jsonResponse({ items: athletes });
      if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
        return jsonResponse({ ok: true, class_id: 'class-1', athlete_id: 'athlete-1' });
      }
      return jsonResponse({ ok: true, role: 'coach', classes, registrations: [], coaching_requests: [], attendance: [] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update Attendance' }));

    await waitFor(() => expect(screen.queryByText('Active Training Hold')).toBeNull());
  });
});
