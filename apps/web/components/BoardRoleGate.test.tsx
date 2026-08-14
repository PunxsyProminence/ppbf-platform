/**
 * @jest-environment jsdom
 */

// The /board subtree resolves the session once, in this gate, and hands the
// seats down. Two things it has to get right: the platform owner reads the
// board surface instead of being bounced to a login form it has already
// satisfied, and a valid session that is not board-shaped goes to its own
// dashboard rather than to /login.

import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';

import BoardRoleGate, { useBoardSession } from './BoardRoleGate';

const replace = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: (path: string) => replace(path) }),
}));

function SeatProbe() {
  const session = useBoardSession();
  return <div>{`role:${session?.role ?? 'none'} seats:${(session?.seats ?? []).join(',') || 'none'}`}</div>;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  window.localStorage.clear();
  jest.clearAllMocks();
});

async function renderGate(payload: unknown, ok = true, status = 200, children: ReactNode = <SeatProbe />) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<BoardRoleGate>{children}</BoardRoleGate>);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  // The gate settles on the render after the session resolves.
  await waitFor(() => expect(
    replace.mock.calls.length > 0 || screen.queryByText(/^role:/) !== null || screen.queryByRole('button', { name: 'Retry' }) !== null,
  ).toBe(true));
}

test('hands a board session its seats', async () => {
  await renderGate({
    authenticated: true,
    role: 'board',
    auth_provider: 'microsoft',
    board_seat: 'treasurer',
    board_seats: [{ seat: 'treasurer', is_primary: true }, { seat: 'at-large', is_primary: false }],
  });

  expect(screen.getByText('role:board seats:treasurer,at-large')).toBeDefined();
  expect(replace).not.toHaveBeenCalled();
});

test('a board session with no seat row is admitted holding no seat', async () => {
  await renderGate({ authenticated: true, role: 'board', auth_provider: 'microsoft', board_seats: [] });

  expect(screen.getByText('role:board seats:none')).toBeDefined();
  expect(replace).not.toHaveBeenCalled();
});

test('the platform owner reads the board surface and is given no seat', async () => {
  await renderGate({ authenticated: true, role: 'platform_owner', auth_provider: 'microsoft' });

  expect(screen.getByText('role:platform_owner seats:none')).toBeDefined();
  expect(replace).not.toHaveBeenCalled();
});

test('a signed-in non-board session goes to its own dashboard, not to /login', async () => {
  await renderGate({ authenticated: true, role: 'coach', auth_provider: 'microsoft' });

  expect(replace).toHaveBeenCalledWith('/coach/environment/intake-router');
  expect(screen.queryByText(/^role:/)).toBeNull();
});

test('an unauthenticated visitor goes to /login', async () => {
  await renderGate({ authenticated: false });

  expect(replace).toHaveBeenCalledWith('/login');
});

test('a board session still on the starting PIN goes to the one page that resolves it', async () => {
  await renderGate({
    authenticated: true,
    role: 'board',
    auth_provider: 'microsoft',
    must_change_pin: true,
  });

  expect(replace).toHaveBeenCalledWith('/change-pin');
});

test('a board session that skipped the privileged sign-in is refused', async () => {
  await renderGate({ authenticated: true, role: 'board', auth_provider: 'ppbf_local' });

  expect(replace).toHaveBeenCalledWith('/login?error=privileged_auth_required');
});

test('a server failure offers a retry instead of clearing the session', async () => {
  await renderGate(null, false, 503);

  expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  expect(replace).not.toHaveBeenCalled();
});
