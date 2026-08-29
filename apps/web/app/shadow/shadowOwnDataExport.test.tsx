/**
 * @jest-environment jsdom
 */

/**
 * A person can get their own SHADOW history out.
 *
 * GET /api/pilot/shadow/data shipped with the SHADOW runtime slice and nothing
 * called it, so the only route out of this platform for somebody's own
 * conversation history was to ask an admin to run a query for them.
 *
 * The cases here are about the ways a self-service export lies. It can promise
 * more than it carries -- the payload is SHADOW chat and memory corrections,
 * not everything the gym holds, and the server says so itself. It can hand over
 * a hundred of a hundred and fifty conversations and call it "your history". Or
 * it can fail and leave a reassuring notice standing over a file that was never
 * written.
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ShadowChatPage from './page';
import {
  fetchOwnShadowDataExport,
  listOwnedShadowSessions,
  ShadowSessionsRequestError,
} from '@/client/shadowSessions';

const replace = jest.fn();
/* One router object and one search-params object for the life of the file --
   the page's auth effect depends on [router], so a fresh object per render
   re-runs it forever. Same reason as page.test.tsx. */
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

const clearRoleSession = jest.fn();
jest.mock('@/components/roleSession', () => ({
  readRoleSession: () => ({ role: 'coach', expiresAt: 8.64e15 }),
  clearRoleSession: () => clearRoleSession(),
}));

jest.mock('@/client/shadowSessions', () => {
  const actual = jest.requireActual('@/client/shadowSessions');
  return {
    ...actual,
    listOwnedShadowSessions: jest.fn(),
    fetchOwnShadowDataExport: jest.fn(),
  };
});

const mockListSessions = listOwnedShadowSessions as jest.MockedFunction<typeof listOwnedShadowSessions>;
const mockExport = fetchOwnShadowDataExport as jest.MockedFunction<typeof fetchOwnShadowDataExport>;

const originalFetch = global.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

let createdUrls: number;
let revokedUrls: number;
let downloadClicks: Array<{ href: string; download: string }>;

function installServer(): void {
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
}

function exportResult(overrides: Partial<{
  conversationsStored: number;
  conversationsIncluded: number;
  conversationLimit: number;
}> = {}) {
  return {
    exportedAt: '2026-08-28T12:00:00.000Z',
    exportScope: 'conversation_history_only',
    completeAccountExport: false,
    conversationLimit: 100,
    conversationsStored: 4,
    conversationsIncluded: 4,
    payload: { sessions: [], messages: [], corrections: [] } as Record<string, unknown>,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  createdUrls = 0;
  revokedUrls = 0;
  downloadClicks = [];
  mockListSessions.mockResolvedValue([]);
  installServer();
  Element.prototype.scrollIntoView = jest.fn();

  // jsdom implements neither of these, and no anchor click ever navigates.
  URL.createObjectURL = jest.fn(() => {
    createdUrls += 1;
    return `blob:mock/${createdUrls}`;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = jest.fn(() => {
    revokedUrls += 1;
  }) as unknown as typeof URL.revokeObjectURL;
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
    this: HTMLAnchorElement,
  ) {
    downloadClicks.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  jest.restoreAllMocks();
});

async function renderPage(): Promise<void> {
  await act(async () => {
    render(<ShadowChatPage />);
  });
}

async function clickDownload(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Download my history/ }));
  });
}

describe('the door exists and is labelled for what it carries', () => {
  it('offers the download on the saved-sessions panel', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: 'Download my history' })).not.toBeNull();
  });

  it('does not call itself an export of everything the platform holds', async () => {
    // The payload is exportScope 'conversation_history_only' with
    // completeAccountExport false. A button reading "Export my data" would be
    // the more useful-sounding label and the false one.
    await renderPage();

    expect(screen.queryByRole('button', { name: /Export my data/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download all my data/i })).toBeNull();
  });
});

describe('a complete history', () => {
  it('writes the server payload to a file and says nothing was left out', async () => {
    mockExport.mockResolvedValue(exportResult());
    await renderPage();
    await clickDownload();

    await waitFor(() => {
      expect(downloadClicks).toHaveLength(1);
    });
    expect(downloadClicks[0].download).toBe('shadow-history-2026-08-28.json');

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Downloaded all 4 of your conversations');
    // Still says what it is NOT, even when it is complete on its own terms.
    expect(notice.textContent).toContain('not everything the gym holds about you');
  });

  it('releases the blob rather than leaving the history resident in the tab', async () => {
    mockExport.mockResolvedValue(exportResult());
    await renderPage();
    await clickDownload();

    await waitFor(() => {
      expect(revokedUrls).toBe(createdUrls);
    });
    expect(createdUrls).toBe(1);
  });
});

describe('a partial history says so', () => {
  it('names both counts and the cap', async () => {
    // THE CASE THIS FILE EXISTS FOR. Somebody with 150 conversations gets 100,
    // and the person who asked for their own data has no other way to find out.
    mockExport.mockResolvedValue(exportResult({
      conversationsStored: 150,
      conversationsIncluded: 100,
    }));
    await renderPage();
    await clickDownload();

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Downloaded 100 of your 150 conversations');
    expect(notice.textContent).toContain('at most 100');
    // Both reasons are offered, because the export cannot tell which applied.
    expect(notice.textContent).toContain('an athlete you no longer coach');
  });

  it('never reports a partial download as a complete one', async () => {
    mockExport.mockResolvedValue(exportResult({
      conversationsStored: 150,
      conversationsIncluded: 100,
    }));
    await renderPage();
    await clickDownload();

    const notice = await screen.findByRole('status');
    expect(notice.textContent).not.toContain('Downloaded all');
  });
});

describe('a download that did not happen', () => {
  it('says nothing was downloaded, and writes no file', async () => {
    mockExport.mockRejectedValue(
      new ShadowSessionsRequestError(500, 'SHADOW could not put your history together.'),
    );
    await renderPage();
    await clickDownload();

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('SHADOW could not put your history together.');
    expect(downloadClicks).toHaveLength(0);
    expect(createdUrls).toBe(0);
  });

  it('signs the person out when the session is dead, rather than blaming the export', async () => {
    mockExport.mockRejectedValue(new ShadowSessionsRequestError(401, 'Unauthorized'));
    await renderPage();
    await clickDownload();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
    expect(clearRoleSession).toHaveBeenCalled();
  });

  it('clears the previous notice while the next attempt is in flight', async () => {
    /* The first download worked and its notice is on screen. The moment that
       matters is the SECOND click, not its outcome: while the request is out,
       "Downloaded all 4" must not be sitting beside "Preparing…" over a file
       that has not been written and may never be.

       Asserting the end state instead would prove nothing -- the catch block
       replaces the notice anyway, so both an implementation that clears
       upfront and one that does not finish identically. The gap is only
       visible mid-flight. */
    mockExport.mockResolvedValueOnce(exportResult());
    await renderPage();
    await clickDownload();
    await screen.findByText(/Downloaded all 4/);

    let releaseExport: (() => void) | undefined;
    mockExport.mockReturnValueOnce(new Promise((resolve) => {
      releaseExport = () => resolve(exportResult());
    }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Download my history/ }));
    });

    // In flight: the button says so, and the stale receipt is gone.
    expect(screen.getByRole('button', { name: 'Preparing…' })).not.toBeNull();
    expect(screen.queryByText(/Downloaded all 4/)).toBeNull();

    await act(async () => {
      releaseExport?.();
    });
  });
});
