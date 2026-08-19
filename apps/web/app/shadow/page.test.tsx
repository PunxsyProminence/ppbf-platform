/**
 * @jest-environment jsdom
 */

/**
 * WHAT THE DENY PATH ASKS FOR.
 *
 * A role outside SHADOW_CHAT_ROLES gets a static refusal here rather than a
 * composer that can only 403 — that part was already right. What was not: the
 * page went on fetching /api/pilot/shadow/capabilities and listing the
 * session's saved SHADOW conversations, both gated only on the auth check
 * having finished. So a board member — a role whose room DNA lists "Ask SHADOW
 * chat" first under FORBIDDEN — was sent crossOrganizationRead,
 * canAccessProtectedHealthInformation, canReviewChatSafetyTelemetry,
 * canExportConversationHistory and the tier in `mode`, on requests this page
 * made on their behalf while showing them a refusal.
 *
 * Nothing rendered any of it. That is exactly why this is a test about which
 * REQUESTS are made, not about what is on the screen.
 */

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import ShadowChatPage from './page';
import { listOwnedShadowSessions } from '@/client/shadowSessions';

const replace = jest.fn();
/* ONE router object and ONE search-params object for the life of the file. The
   page's auth effect depends on [router]: a mock that builds a fresh object per
   render re-runs it on every render, which re-checks the session forever and
   makes the test hang with nothing wrong with the page. */
const router = { replace, push: jest.fn() };
const searchParams = { get: () => null };

jest.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => searchParams,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/components/roleSession', () => ({
  readRoleSession: () => ({ role: 'board', expiresAt: 8.64e15 }),
  clearRoleSession: jest.fn(),
}));

jest.mock('@/client/shadowSessions', () => {
  const actual = jest.requireActual('@/client/shadowSessions');
  return { ...actual, listOwnedShadowSessions: jest.fn() };
});

const mockListSessions = listOwnedShadowSessions as jest.MockedFunction<typeof listOwnedShadowSessions>;

const originalFetch = global.fetch;

/** Every URL the page asked for, in order. */
function requestedUrls(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

function mockServerSaying(role: string) {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/auth/session')) {
      return { ok: true, json: async () => ({ authenticated: true, role }) };
    }
    if (String(url).includes('/api/pilot/shadow/capabilities')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          capabilities: { allowedSessionTypes: ['quick_round'], mode: 'scoped' },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListSessions.mockResolvedValue([]);
  // jsdom implements no scrollIntoView, and the message list scrolls itself on
  // every render of the allowed surface.
  Element.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('a role SHADOW chat refuses', () => {
  test('is shown the refusal', async () => {
    mockServerSaying('board');

    await act(async () => { render(<ShadowChatPage />); });

    expect(screen.getByText(/cannot use SHADOW chat/i)).toBeTruthy();
  });

  test('is never sent the capability names or the tier', async () => {
    const fetchMock = mockServerSaying('board');

    await act(async () => { render(<ShadowChatPage />); });

    expect(requestedUrls(fetchMock).some((url) => url.includes('/shadow/capabilities'))).toBe(false);
  });

  test('has no saved conversations listed on its behalf', async () => {
    mockServerSaying('board');

    await act(async () => { render(<ShadowChatPage />); });

    expect(mockListSessions).not.toHaveBeenCalled();
  });

  test('is not signed out for it — the refusal is not a session death', async () => {
    mockServerSaying('board');

    await act(async () => { render(<ShadowChatPage />); });

    expect(replace).not.toHaveBeenCalled();
  });
});

/* The other half. Guarding the deny path must not have taken the surface away
   from the roles it belongs to: without these, deleting both fetches entirely
   would pass every test above. */
describe('a role SHADOW chat admits', () => {
  test('still asks what it is allowed to do', async () => {
    const fetchMock = mockServerSaying('coach');

    await act(async () => { render(<ShadowChatPage />); });

    expect(requestedUrls(fetchMock).some((url) => url.includes('/shadow/capabilities'))).toBe(true);
  });

  test('still gets its saved conversations listed', async () => {
    mockServerSaying('coach');

    await act(async () => { render(<ShadowChatPage />); });

    expect(mockListSessions).toHaveBeenCalled();
  });
});
