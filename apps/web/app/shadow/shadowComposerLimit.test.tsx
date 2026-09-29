/**
 * @jest-environment jsdom
 */

// A QUESTION OVER THE LIMIT. The composer cleared the box before the request
// went out, and the route answered an over-long question with "Enter a
// question for SHADOW." -- so a coach who pasted a long question was told
// something false about why, and had it back only as a transcript bubble, not
// in the box where it could be shortened. The page now refuses before sending,
// with the route's own limit and wording, and leaves the text in the box.

import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import ShadowChatPage from './page';

const replace = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const originalFetch = global.fetch;

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function shadowFetchMock() {
  return jest.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/auth/session')) {
      return jsonResponse({ authenticated: true, role: 'coach', auth_provider: 'microsoft' });
    }
    if (target.includes('/shadow/capabilities')) {
      return jsonResponse({ capabilities: { mode: 'scoped', allowedSessionTypes: ['quick_round'] } });
    }
    if (target.includes('/shadow/sessions')) {
      return jsonResponse({ success: true, conversations: [] });
    }
    if (target.includes('/shadow/chat')) {
      return jsonResponse({
        success: true,
        state: 'ok',
        response: 'Answer text.',
        messageId: '11111111-2222-4333-8444-555555555555',
        conversationId: 'conv-1',
        tier: 'quick_round',
        evidenceTier: 'EMERGING',
      });
    }
    return jsonResponse({ ok: true });
  });
}

function chatCalls(fetchMock: jest.Mock): unknown[][] {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes('/shadow/chat'));
}

async function renderShadow() {
  const fetchMock = shadowFetchMock();
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<ShadowChatPage />);
  await screen.findByText('Authority Boundary');
  return fetchMock;
}

test('an over-long question is refused as too long, and stays in the box to shorten', async () => {
  const fetchMock = await renderShadow();
  const longQuestion = 'a'.repeat(12_001);

  const composer = await screen.findByLabelText('Your question') as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: longQuestion } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask SHADOW' }));

  expect(await screen.findByText(
    'That question is too long for SHADOW (limit 12,000 characters). Shorten it and send again.',
  )).toBeTruthy();
  expect(screen.queryByText('Enter a question for SHADOW.')).toBeNull();
  expect((screen.getByLabelText('Your question') as HTMLTextAreaElement).value).toBe(longQuestion);
  expect(chatCalls(fetchMock)).toHaveLength(0);
});

// The other half: without this, refusing every question would pass the test
// above.
test('a question at the limit is still sent', async () => {
  const fetchMock = await renderShadow();

  fireEvent.change(await screen.findByLabelText('Your question'), {
    target: { value: 'a'.repeat(12_000) },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask SHADOW' }));

  await screen.findByText('Answer text.');
  expect(chatCalls(fetchMock)).toHaveLength(1);
});
