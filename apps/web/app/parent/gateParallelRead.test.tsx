/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';

import GuardianSafetyPage from './safety/page';
import GuardianMediaConsentPage from './consent/page';

/* Parent walk item 13 (lane LG2): what the 2-5 s on /parent/safety and
   /parent/consent are made of, held with the REAL RoleSessionGate.

   Each page starts its own data read on mount, from the page component, which
   sits OUTSIDE the gate; so the read runs alongside the sign-in check rather
   than after it, and the server route (requirePrincipal + requireRole parent)
   is what refuses a caller who is not signed in. What the gate keeps is the
   rendering: nothing the read returned reaches the screen until the check has
   passed as a parent. These cases hold both halves, so moving the read behind
   the gate (slower) or rendering before the gate passes (a leak) fails here. */

const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const CHILD = 'Jordan T.';

const SAFETY_ITEMS = [
  { athlete_id: 'ath-1', athlete_name: CHILD, hold: null, gates: [], waivers: {} },
];

const CONSENT_ITEMS = [
  {
    athlete_id: 'ath-1',
    athlete_name: CHILD,
    consent_ok: false,
    guardian_count: 1,
    missing_guardian_count: 1,
    per_guardian: [{ you: true, status: null, covers_video: null, public_use_allowed: null, signed_at: null }],
  },
];

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const originalFetch = global.fetch;

/** fetch with the sign-in check held open until `answerSession` is called. */
function holdSessionCheck() {
  let answer: (response: Response) => void = () => {};
  const session = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  const fetchMock = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) return session;
    if (url.includes('/api/pilot/parent/safety')) return Promise.resolve(jsonResponse(200, { items: SAFETY_ITEMS }));
    if (url.includes('/api/pilot/parent/consent')) return Promise.resolve(jsonResponse(200, { items: CONSENT_ITEMS }));
    if (url.includes('/api/pilot/athlete/injuries')) return Promise.resolve(jsonResponse(200, { injuries: [] }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  const urls = () => fetchMock.mock.calls.map((call) => String(call[0]));
  const answerSession = async (role: string) => {
    await act(async () => {
      answer(jsonResponse(200, { authenticated: true, role, auth_provider: 'microsoft' }));
    });
  };
  return { urls, answerSession };
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
  window.localStorage.clear();
});

const PAGES = [
  { name: '/parent/safety', Page: GuardianSafetyPage, dataRoute: '/api/pilot/parent/safety', heading: 'Safety Status' },
  { name: '/parent/consent', Page: GuardianMediaConsentPage, dataRoute: '/api/pilot/parent/consent', heading: 'Photo & Video Consent' },
];

describe.each(PAGES)('$name', ({ Page, dataRoute, heading }) => {
  test('its data read is already out while the sign-in check is still out, and nothing it returned is shown', async () => {
    const { urls } = holdSessionCheck();

    await act(async () => {
      render(<Page />);
    });

    expect(urls().some((url) => url.includes('/api/pilot/auth/session'))).toBe(true);
    expect(urls().some((url) => url.includes(dataRoute))).toBe(true);

    // The read has answered; the gate has not. Only the holding screen shows.
    expect(screen.getByRole('heading', { name: 'Checking access' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: heading })).toBeNull();
    expect(screen.queryByText(CHILD)).toBeNull();
  });

  test('when the check passes as a parent, what the read returned renders', async () => {
    const { answerSession } = holdSessionCheck();

    await act(async () => {
      render(<Page />);
    });
    await answerSession('parent');

    expect(await screen.findByText(CHILD)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Checking access' })).toBeNull();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('when the check comes back as a role the page does not admit, the data already in hand is never shown', async () => {
    const { answerSession } = holdSessionCheck();

    await act(async () => {
      render(<Page />);
    });
    await answerSession('coach');

    expect(mockRouter.replace).toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: heading })).toBeNull();
    expect(screen.queryByText(CHILD)).toBeNull();
  });
});
