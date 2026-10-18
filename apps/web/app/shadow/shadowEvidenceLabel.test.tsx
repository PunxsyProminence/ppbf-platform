/**
 * @jest-environment jsdom
 */

/*
 * Audit item 11, Jason's ruling A ("Strongest + also-cites", relayed by
 * Overwatch 2026-10-17): the badge names what the grade measures, the strongest
 * source cited, and a second line lists the other cited sources' grades when
 * they differ.
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import ShadowChatPage from './page';
import { listOwnedShadowSessions, loadOwnedShadowSessionMessages } from '@/client/shadowSessions';

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
const mockLoadMessages = loadOwnedShadowSessionMessages as jest.MockedFunction<typeof loadOwnedShadowSessionMessages>;
const originalFetch = global.fetch;

function mockServer(answer: Record<string, unknown>) {
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
          response: 'Pivot off the lead foot [E:ev-1].',
          messageId: 'msg-1',
          citations: [{ evidenceId: 'ev-1', token: '[E:ev-1]', sourceTitle: 'PPBF Footwork Manual', documentName: 'Chapter 2' }],
          ...answer,
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

async function ask() {
  await act(async () => {
    render(<ShadowChatPage />);
  });
  fireEvent.change(await screen.findByLabelText('Your question'), { target: { value: 'How do I pivot as a southpaw?' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Ask SHADOW' }));
  });
}

test('the badge names the strongest source, and the other grades follow', async () => {
  mockServer({ evidenceTier: 'PROVEN', evidenceAlsoCites: ['EMERGING', 'EXPERIMENTAL'], evidenceSourceGraded: true });
  await ask();

  expect(await screen.findByText('Strongest source: Proven')).toBeTruthy();
  expect(screen.getByText('Also cites: Emerging, Experimental')).toBeTruthy();
  expect(screen.queryByText(/^Evidence: /)).toBeNull();
});

test('no "Also cites" line when every cited source grades the same, or a grade is not one the page knows', async () => {
  mockServer({ evidenceTier: 'EMERGING', evidenceAlsoCites: ['VERY_GOOD'], evidenceSourceGraded: true });
  await ask();

  expect(await screen.findByText('Strongest source: Emerging')).toBeTruthy();
  expect(screen.queryByText(/^Also cites:/)).toBeNull();
});

// Overwatch 2026-10-18, under Jason's "Strongest + also-cites" ruling:
// "Strongest source" names a source, so it appears only when one graded the answer.
test('a graded answer with no graded cited source reads "Evidence", with no "Also cites" line', async () => {
  mockServer({ evidenceTier: 'EXPERIMENTAL', evidenceAlsoCites: ['RESEARCH_NEEDED'], evidenceSourceGraded: false, citations: [] });
  await ask();

  expect(await screen.findByText('Evidence: Experimental')).toBeTruthy();
  expect(screen.queryByText(/^Strongest source:/)).toBeNull();
  expect(screen.queryByText(/^Also cites:/)).toBeNull();
});

test('no badge when the evidence lookup failed; the outage notice stands alone', async () => {
  mockServer({ evidenceTier: 'RESEARCH_NEEDED', evidenceNotice: 'EVIDENCE_RETRIEVAL_UNAVAILABLE', citations: [] });
  await ask();

  expect(await screen.findByText(/Evidence lookup temporarily unavailable/)).toBeTruthy();
  expect(screen.queryByText(/^(Strongest source|Evidence): /)).toBeNull();
});

test('no badge on a withheld reply', async () => {
  mockServer({ state: 'filtered', evidenceTier: 'RESEARCH_NEEDED', citations: [] });
  await ask();
  expect((await screen.findAllByText(/Pivot off the lead foot/)).length).toBeGreaterThan(0);
  expect(screen.queryByText(/^(Strongest source|Evidence): /)).toBeNull();
});

test('no badge when the server never graded the answer', async () => {
  mockServer({ evidenceTier: undefined, citations: [] });
  await ask();

  expect((await screen.findAllByText(/Pivot off the lead foot/)).length).toBeGreaterThan(0);
  expect(screen.queryByText(/^(Strongest source|Evidence): /)).toBeNull();
});

test('the legend says what each grade measures', async () => {
  mockServer({ evidenceTier: 'EMERGING' });
  await ask();

  expect(screen.getByText(/The strongest source cited is verified, boxing-specific evidence from a top-tier source\./)).toBeTruthy();
  expect(screen.queryByText(/not yet fully verified/)).toBeNull();
});

test('a reopened conversation shows the same badge and "Also cites" line', async () => {
  mockServer({});
  mockListSessions.mockResolvedValue([{
    conversationId: 'conv-1',
    title: 'Southpaw pivots',
    athleteId: null,
    sessionType: 'quick_round',
    createdAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-12T10:00:00.000Z',
  }] as never);
  mockLoadMessages.mockResolvedValue([{
    messageId: 'msg-stored',
    role: 'assistant',
    content: 'Pivot off the lead foot.',
    responseState: 'ok',
    evidenceTier: 'EMERGING',
    evidenceAlsoCites: ['EXPERIMENTAL'],
    evidenceSourceGraded: true,
    handoff: null,
    createdAt: '2026-10-12T10:00:01.000Z',
    citations: [],
  }] as never);
  await act(async () => {
    render(<ShadowChatPage />);
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Southpaw pivots/ }));
  });

  expect(await screen.findByText('Strongest source: Emerging')).toBeTruthy();
  expect(screen.getByText('Also cites: Experimental')).toBeTruthy();
});
