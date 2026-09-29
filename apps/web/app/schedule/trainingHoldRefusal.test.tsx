/**
 * @jest-environment jsdom
 */

// A training-hold refusal carries its own words. register_class answers a
// held athlete with a 403 holding the explanation the coach wrote FOR the
// athlete and the condition that lifts the hold
// (app/api/pilot/scheduler/route.ts, the training_hold branch). This page
// printed only the one-line error above them -- "Training hold: registration
// is paused for this athlete" -- so a family learned sign-up was paused and
// neither why nor what ends it. These pin the rest of the refusal onto the
// screen, and that it leaves with the failure it belongs to.

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

const HOLD_ERROR = 'Training hold: registration is paused for this athlete';
const EXPLANATION = 'Your coaches want your wrist checked before you train again.';
const LIFT_CONDITION = 'A note from your doctor clearing the wrist.';

const classes = [
  {
    class_id: 'class-1',
    title: 'Morning Fundamentals',
    start_at: '2026-08-03T13:00:00.000Z',
    end_at: '2026-08-03T14:00:00.000Z',
    location: 'Main Floor',
    capacity: 16,
    status: 'open',
    registered_count: 2,
  },
];

function reply(status: number, payload: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(payload) } as Response);
}

type RegisterReply = { status: number; payload: unknown };

// The athlete role registers themself, so no athlete picker stands between
// the Register button and the POST.
function installFetchMock(registerReplies: RegisterReply[]): void {
  const queue = [...registerReplies];
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith('/api/pilot/auth/session')) {
      return reply(200, { authenticated: true, role: 'athlete', athlete_id: 'athlete-1' });
    }

    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { action?: string };
      const next = queue.shift();
      if (body.action !== 'register_class' || !next) {
        throw new Error(`Unexpected POST action: ${body.action}`);
      }
      return reply(next.status, next.payload);
    }

    if (url.endsWith('/api/pilot/scheduler')) {
      return reply(200, {
        ok: true,
        role: 'athlete',
        athlete_id: 'athlete-1',
        classes,
        registrations: [],
        coaching_requests: [],
        attendance: [],
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
}

function clickRegister(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Register' }));
}

describe('register_class training-hold refusal', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("the refusal shows the coach's explanation and what lifts the hold", async () => {
    installFetchMock([
      { status: 403, payload: { error: HOLD_ERROR, athlete_explanation: EXPLANATION, lift_condition: LIFT_CONDITION } },
    ]);

    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');
    clickRegister();

    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert).toHaveTextContent(HOLD_ERROR));
    expect(alert).toHaveTextContent(`Why: ${EXPLANATION}`);
    expect(alert).toHaveTextContent(`To lift it: ${LIFT_CONDITION}`);
  });

  test('a hold placed without a lift condition says so instead of inventing one', async () => {
    // lift_condition_text is `not null default ''`: a hold may be placed
    // without one, and the route passes the blank through.
    installFetchMock([
      { status: 403, payload: { error: HOLD_ERROR, athlete_explanation: EXPLANATION, lift_condition: '' } },
    ]);

    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');
    clickRegister();

    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert).toHaveTextContent(`Why: ${EXPLANATION}`));
    expect(alert).toHaveTextContent('To lift it: not written down — ask whoever placed the hold.');
  });

  test("a later, unrelated failure does not keep the hold's explanation under it", async () => {
    installFetchMock([
      { status: 403, payload: { error: HOLD_ERROR, athlete_explanation: EXPLANATION, lift_condition: LIFT_CONDITION } },
      { status: 409, payload: { error: 'Athlete already registered for this class' } },
    ]);

    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');

    clickRegister();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(`Why: ${EXPLANATION}`));

    clickRegister();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Athlete already registered for this class'));
    expect(screen.getByRole('alert')).not.toHaveTextContent(EXPLANATION);
    expect(screen.getByRole('alert')).not.toHaveTextContent('To lift it');
  });

  test('an ordinary refusal carries no hold lines at all', async () => {
    installFetchMock([{ status: 409, payload: { error: 'Athlete already registered for this class' } }]);

    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');
    clickRegister();

    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert).toHaveTextContent('Athlete already registered for this class'));
    expect(alert).not.toHaveTextContent('Why:');
    expect(alert).not.toHaveTextContent('To lift it');
  });
});
