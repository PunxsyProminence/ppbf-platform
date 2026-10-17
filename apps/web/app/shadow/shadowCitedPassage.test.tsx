/**
 * @jest-environment jsdom
 */

/*
 * OD-2026-10-08-005 A-Q11, ruling 4: SHADOW shows the passage text under each
 * source, within the rights rule. The server sends `excerpt` only for a
 * passage within that rule (shadowEvidence.ts PASSAGE_DISPLAY_RIGHTS); this
 * pins that the page shows what it is sent, under the source line, and shows
 * a title alone when no passage comes.
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import ShadowChatPage from './page';
import { listOwnedShadowSessions } from '@/client/shadowSessions';

const router = { replace: jest.fn(), push: jest.fn() };
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
  return { ...actual, listOwnedShadowSessions: jest.fn(), loadOwnedShadowSessionMessages: jest.fn() };
});

const mockListSessions = listOwnedShadowSessions as jest.MockedFunction<typeof listOwnedShadowSessions>;
const originalFetch = global.fetch;

const PASSAGE = 'Pivot off the lead foot and keep the rear heel light.';

function mockServer() {
  global.fetch = jest.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/api/pilot/auth/session')) {
      return { ok: true, json: async () => ({ authenticated: true, role: 'coach' }) };
    }
    if (target.includes('/api/pilot/shadow/capabilities')) {
      return {
        ok: true,
        json: async () => ({ success: true, capabilities: { allowedSessionTypes: ['quick_round'], mode: 'scoped' } }),
      };
    }
    if (target.includes('/api/pilot/shadow/chat')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: 'ok',
          response: 'Pivot off the lead foot [E:ev-owned] and keep your guard [E:ev-licensed].',
          evidenceTier: 'EMERGING',
          messageId: 'msg-1',
          citations: [
            { evidenceId: 'ev-owned', token: '[E:ev-owned]', sourceTitle: 'PPBF Footwork Manual', documentName: 'Chapter 2', excerpt: PASSAGE },
            { evidenceId: 'ev-licensed', token: '[E:ev-licensed]', sourceTitle: 'Licensed Text', documentName: 'Excerpt 4' },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListSessions.mockResolvedValue([]);
  Element.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('the passage shows under its source; a source sent without one shows its title alone', async () => {
  mockServer();
  await act(async () => {
    render(<ShadowChatPage />);
  });
  fireEvent.change(await screen.findByLabelText('Your question'), { target: { value: 'How do I pivot as a southpaw?' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Ask SHADOW' }));
  });

  const owned = (await screen.findByText(/PPBF Footwork Manual/)).closest('li') as HTMLElement;
  expect(within(owned).getByText(PASSAGE).tagName).toBe('BLOCKQUOTE');

  const licensed = screen.getByText(/Licensed Text/).closest('li') as HTMLElement;
  expect(within(licensed).queryByRole('blockquote')).toBeNull();
  expect(licensed.querySelector('blockquote')).toBeNull();
  expect(screen.getAllByText(PASSAGE)).toHaveLength(1);
});
