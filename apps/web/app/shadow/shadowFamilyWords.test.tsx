/**
 * @jest-environment jsdom
 */

/**
 * SHADOW chat in words a family reads (UXB-21, UXB-37; lane U3, UXB-L6).
 *
 * An athlete or parent saw "Role: ATHLETE", a "LIVE" marker, the mode name
 * "Scout", "Your server-stored conversation history", raw session codes such
 * as "quick round", raw response states such as "degraded", and "Human
 * Handoff Required". None is something they act on. Filtering is untouched
 * (the "B: Relax for everyone" ruling stands): this is wording only.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

import ShadowChatPage from './page';
import { fetchOwnShadowDeletionRequest, listOwnedShadowSessions } from '@/client/shadowSessions';

let signedInRole = 'athlete';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/roleSession', () => ({
  readRoleSession: () => ({ role: signedInRole, expiresAt: 8.64e15 }),
  clearRoleSession: jest.fn(),
}));

jest.mock('@/client/shadowSessions', () => {
  const actual = jest.requireActual('@/client/shadowSessions');
  return { ...actual, listOwnedShadowSessions: jest.fn(), fetchOwnShadowDeletionRequest: jest.fn() };
});

const mockList = listOwnedShadowSessions as jest.MockedFunction<typeof listOwnedShadowSessions>;
const mockDeletion = fetchOwnShadowDeletionRequest as jest.MockedFunction<typeof fetchOwnShadowDeletionRequest>;
const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  Element.prototype.scrollIntoView = jest.fn();
  mockDeletion.mockResolvedValue(null);
  mockList.mockResolvedValue([{
    conversationId: 'c1', title: 'Footwork question', athleteId: null, sessionType: 'quick_round',
    createdAt: '2026-10-15T14:00:00.000Z', updatedAt: '2026-10-15T14:05:00.000Z',
  }]);
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/auth/session')) {
      return { ok: true, json: async () => ({ authenticated: true, role: signedInRole }) };
    }
    if (String(url).includes('/api/pilot/shadow/capabilities')) {
      return { ok: true, json: async () => ({ success: true, capabilities: { allowedSessionTypes: ['quick_round'], mode: 'scoped' } }) };
    }
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  signedInRole = 'athlete';
});

async function renderPage(): Promise<void> {
  await act(async () => {
    render(<ShadowChatPage />);
  });
}

describe.each(['athlete', 'parent'])('a %s reading SHADOW', (role) => {
  test('sees no role code, LIVE marker or mode name in the header', async () => {
    signedInRole = role;
    await renderPage();
    await screen.findByText('Footwork question');

    expect(screen.queryByText(/^Role:/)).toBeNull();
    expect(screen.queryByText('LIVE')).toBeNull();
    expect(screen.queryByText('Scout')).toBeNull();
  });

  test('reads its saved chats in words: no "server-stored", no session code', async () => {
    signedInRole = role;
    await renderPage();
    await screen.findByText('Footwork question');

    expect(screen.getByText('Your past chats.')).toBeTruthy();
    expect(screen.queryByText(/server-stored/)).toBeNull();
    await waitFor(() => expect(screen.getByText(/^Quick Round · /)).toBeTruthy());
    expect(screen.queryByText(/quick round/)).toBeNull();
  });
});

describe('words the page can print to anyone', () => {
  const source = readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');

  test('a response state is words, never the stored state', () => {
    // The badge used to print msg.state, so "degraded" and "queued" reached people.
    expect(source).not.toMatch(/'Withheld' : msg\.state/);
    expect(source).toMatch(/responseStateWords\(msg\.state\)/);
  });

  test('no "Human Handoff Required", no signed-in role code on the refusal, no "Secure Session"', () => {
    expect(source).not.toMatch(/Human Handoff Required/);
    expect(source).not.toMatch(/your signed-in role \(\$\{/);
    expect(source).not.toMatch(/>Secure Session</);
  });

  test('the deletion request points at the list where Delete actually is', () => {
    expect(source).not.toMatch(/use Delete beside it above/);
  });
});
