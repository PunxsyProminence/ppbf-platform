/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';

import RoleSessionGate from './RoleSessionGate';

/* Parent walk item 13 (lane LG2): the gate's holding screen sat for 2-5 s
   reading only "Checking access". It now says what the wait is, while it
   waits and only then. The real gate, the real session resolver; fetch is the
   only thing stood in for. */

/* ONE router object for the file: the gate's effect depends on [router], so a
   fresh object per render re-runs the session check forever. */
const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

const WAIT_LINE = 'Checking your sign-in. This can take a few seconds.';
const originalFetch = global.fetch;

function sessionResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
  window.localStorage.clear();
});

test('while the sign-in check is out, the holding screen says what the wait is', async () => {
  // The session check never answers, so the gate stays in its checking state.
  global.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;

  await act(async () => {
    render(
      <RoleSessionGate allowedRoles={['parent']}>
        <p>protected child content</p>
      </RoleSessionGate>,
    );
  });

  expect(screen.getByRole('heading', { name: 'Checking access' })).toBeInTheDocument();
  expect(screen.getByText(WAIT_LINE)).toBeInTheDocument();
  expect(screen.queryByText('protected child content')).toBeNull();
});

test('a check that failed on the server reads as a failure with Retry, not as a wait', async () => {
  global.fetch = jest.fn(async () => sessionResponse(500, {})) as unknown as typeof fetch;

  await act(async () => {
    render(
      <RoleSessionGate allowedRoles={['parent']}>
        <p>protected child content</p>
      </RoleSessionGate>,
    );
  });

  expect(screen.getByRole('heading', { name: 'Unable to verify access' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  expect(screen.queryByText(WAIT_LINE)).toBeNull();
  expect(screen.queryByText('protected child content')).toBeNull();
});

test('once the check passes, the holding screen and its line are gone', async () => {
  global.fetch = jest.fn(async () =>
    sessionResponse(200, { authenticated: true, role: 'parent', auth_provider: 'microsoft' }),
  ) as unknown as typeof fetch;

  await act(async () => {
    render(
      <RoleSessionGate allowedRoles={['parent']}>
        <p>protected child content</p>
      </RoleSessionGate>,
    );
  });

  expect(screen.getByText('protected child content')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Checking access' })).toBeNull();
  expect(screen.queryByText(WAIT_LINE)).toBeNull();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});
