/**
 * @jest-environment jsdom
 */

/**
 * "Sign out of every device" (OD-2026-10-06-025 r3 "Build all", feature C7):
 * the self-service caller of /api/pilot/auth/logout-all, which existed with
 * nothing on any screen calling it.
 *
 * Two things must hold. The request names NO account: the route acts on the
 * session's own account and a body naming one would be a route that can be
 * pointed at the wrong person. And a refused call leaves the person signed in
 * HERE and says so, rather than bouncing them to /login as if it had worked.
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import ProfileSettings from './ProfileSettings';

const replace = jest.fn();
jest.mock('next/navigation', () => ({
  usePathname: () => '/profile',
  useRouter: () => ({ replace, push: jest.fn() }),
}));

const clearRoleSession = jest.fn();
jest.mock('./roleSession', () => ({
  clearRoleSession: () => clearRoleSession(),
}));

jest.mock('./FightCard', () => ({
  __esModule: true,
  default: () => null,
}));

const SETTINGS = {
  nickname: null,
  nickname_locked: false,
  corner: 'red',
  program: 'fitness',
  has_photo: false,
  photo_review_state: 'none',
};

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderCorner(onLogoutAll: () => Response): Promise<jest.Mock> {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/auth/logout-all')) return onLogoutAll();
    if (String(url).includes('/api/pilot/profile/me')) return jsonResponse({ settings: SETTINGS, card: null });
    return jsonResponse({}, false);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<ProfileSettings />);
  await screen.findByText('Your sign-in');
  return fetchMock;
}

test('posts to logout-all with the cookie and NO body, clears the client session and goes to /login', async () => {
  const fetchMock = await renderCorner(() => jsonResponse({ ok: true }));

  fireEvent.click(screen.getByRole('button', { name: 'Sign out of every device' }));

  await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/auth/logout-all')) as [string, RequestInit];
  expect(call[1].method).toBe('POST');
  expect(call[1].credentials).toBe('include');
  expect(call[1].body).toBeUndefined();
  expect(clearRoleSession).toHaveBeenCalledTimes(1);
});

test('a refused call keeps the person signed in here and says so, in the server\'s words', async () => {
  await renderCorner(() => jsonResponse({ error: 'Account not found or cannot be revoked' }, false));

  fireEvent.click(screen.getByRole('button', { name: 'Sign out of every device' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Account not found or cannot be revoked');
  expect(replace).not.toHaveBeenCalled();
  expect(clearRoleSession).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Sign out of every device' })).toBeEnabled();
});

test('the wording is the member\'s own act, not the admin control\'s', async () => {
  await renderCorner(() => jsonResponse({ ok: true }));

  expect(screen.getByText(/this ends every session you hold here, including this one/)).toBeInTheDocument();
  expect(screen.queryByText('Sign Out Everywhere')).not.toBeInTheDocument();
});
