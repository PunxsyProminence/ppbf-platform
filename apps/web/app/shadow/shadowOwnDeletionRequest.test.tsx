/**
 * @jest-environment jsdom
 */

/**
 * Asking for your SHADOW history to be cleared.
 *
 * POST /api/pilot/shadow/data has filed these requests since the SHADOW
 * runtime slice, answering `fulfillment: 'manual_review_required'` while
 * nothing anywhere read the table. The review exists now, in the compliance
 * center, which is the only reason this control may exist at all: a button
 * promising a review nobody could perform would be a worse state than no
 * button.
 *
 * These cases are about the ways the control would lie anyway. Calling a
 * request a deletion. Offering to file a second one over a pending first.
 * Saying "you have not asked" when the check failed. Or hiding a refusal so a
 * person cannot tell a denied request from one that never landed.
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ShadowChatPage from './page';
import {
  fetchOwnShadowDeletionRequest,
  listOwnedShadowSessions,
  requestOwnShadowDeletion,
  ShadowSessionsRequestError,
  type OwnShadowDeletionRequest,
} from '@/client/shadowSessions';

const replace = jest.fn();
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
  readRoleSession: () => ({ role: 'coach', expiresAt: 8.64e15 }),
  clearRoleSession: jest.fn(),
}));

jest.mock('@/client/shadowSessions', () => {
  const actual = jest.requireActual('@/client/shadowSessions');
  return {
    ...actual,
    listOwnedShadowSessions: jest.fn(),
    fetchOwnShadowDeletionRequest: jest.fn(),
    requestOwnShadowDeletion: jest.fn(),
  };
});

const mockListSessions = listOwnedShadowSessions as jest.MockedFunction<typeof listOwnedShadowSessions>;
const mockFetchRequest = fetchOwnShadowDeletionRequest as jest.MockedFunction<
  typeof fetchOwnShadowDeletionRequest
>;
const mockFileRequest = requestOwnShadowDeletion as jest.MockedFunction<typeof requestOwnShadowDeletion>;

const originalFetch = global.fetch;

function deletionRequest(
  overrides: Partial<OwnShadowDeletionRequest> = {},
): OwnShadowDeletionRequest {
  return {
    requestId: 'req-1',
    status: 'pending',
    requestedAt: '2026-08-20T10:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListSessions.mockResolvedValue([]);
  mockFetchRequest.mockResolvedValue(null);
  mockFileRequest.mockResolvedValue({ requestId: 'req-1' });
  Element.prototype.scrollIntoView = jest.fn();

  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/auth/session')) {
      return { ok: true, json: async () => ({ authenticated: true, role: 'coach' }) };
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
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

async function renderPage(): Promise<void> {
  await act(async () => {
    render(<ShadowChatPage />);
  });
}

const ASK = /Ask for my history to be cleared/;

describe('the control appears only when the platform knows where things stand', () => {
  it('offers to file a request when there is none', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: ASK })).not.toBeNull();
  });

  it('renders nothing at all when the check failed', async () => {
    // "You have not asked" is not a claim this screen may make on a failed
    // read. A person told that files a second request -- which the server's
    // idempotency check absorbs, and the confusion it does not.
    mockFetchRequest.mockRejectedValue(new ShadowSessionsRequestError(500, 'boom'));
    await renderPage();

    expect(screen.queryByRole('button', { name: ASK })).toBeNull();
    expect(screen.queryByText(/You have asked/)).toBeNull();
  });
});

describe('a request that is already open', () => {
  it.each(['pending', 'approved'] as const)('says so for %s and offers no second button', async (status) => {
    mockFetchRequest.mockResolvedValue(deletionRequest({ status }));
    await renderPage();

    expect(screen.getByText(/You have asked for your SHADOW conversation history to be cleared/))
      .not.toBeNull();
    expect(screen.getByText(/asking again would not make it sooner/)).not.toBeNull();
    expect(screen.queryByRole('button', { name: ASK })).toBeNull();
  });
});

describe('a request that was refused', () => {
  it('says it was declined rather than quietly offering a fresh button', async () => {
    // A person whose request was refused is entitled to know it was refused,
    // not to find a new button and wonder whether the last one worked.
    mockFetchRequest.mockResolvedValue(deletionRequest({
      status: 'denied',
      completedAt: '2026-08-21T09:00:00.000Z',
    }));
    await renderPage();

    expect(screen.getByText(/reviewed and declined/)).not.toBeNull();
    // They may still ask again -- a denial is not a ban.
    expect(screen.getByRole('button', { name: ASK })).not.toBeNull();
  });
});

describe('filing one', () => {
  it('asks first, and the first click sends nothing', async () => {
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ASK }));
    });

    expect(mockFileRequest).not.toHaveBeenCalled();
    // THE SENTENCE THIS FILE EXISTS FOR. It is a request, and the copy says so
    // before anything is sent.
    expect(screen.getByText(/It is a request, not a deletion/)).not.toBeNull();
    expect(screen.getByText(/nothing goes until an admin works it/)).not.toBeNull();
  });

  it('points at the immediate per-chat delete rather than routing one chat through review', async () => {
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ASK }));
    });

    expect(screen.getByText(/To remove one chat now, use Delete beside it above/)).not.toBeNull();
  });

  it('says what is NOT affected', async () => {
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ASK }));
    });

    expect(screen.getByText(/Your account, your sessions and your training records are not affected/))
      .not.toBeNull();
  });

  it('files it and re-reads the status rather than assuming it', async () => {
    mockFetchRequest.mockResolvedValueOnce(null).mockResolvedValueOnce(deletionRequest());
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ASK }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send the request' }));
    });

    expect(mockFileRequest).toHaveBeenCalledTimes(1);
    // Two reads: the page load and the re-check. The status the person is
    // shown is the server's, not one the click inferred.
    await waitFor(() => {
      expect(mockFetchRequest).toHaveBeenCalledTimes(2);
    });
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('nothing is deleted yet');
  });

  it('backs out without sending', async () => {
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ASK }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    expect(mockFileRequest).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: ASK })).not.toBeNull();
  });

  it('says nothing was sent when the request failed', async () => {
    mockFileRequest.mockRejectedValue(
      new ShadowSessionsRequestError(500, 'SHADOW could not file your request.'),
    );
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: ASK }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send the request' }));
    });

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('SHADOW could not file your request.');
    // Not moved to "you have asked" on a request that never landed.
    expect(screen.queryByText(/You have asked/)).toBeNull();
  });
});

describe('a completed request', () => {
  it('says the history was cleared and that new chats are not', async () => {
    mockFetchRequest.mockResolvedValue(deletionRequest({
      status: 'completed',
      completedAt: '2026-08-21T09:00:00.000Z',
    }));
    await renderPage();

    expect(screen.getByText(/Your SHADOW conversation history was cleared/)).not.toBeNull();
    expect(screen.getByText(/Anything you have said since is still here/)).not.toBeNull();
  });
});
