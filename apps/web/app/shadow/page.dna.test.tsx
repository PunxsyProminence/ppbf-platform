/**
 * @jest-environment jsdom
 */

// After Hours room DNA. Four things this page got wrong for its whole life and
// that nothing asserted:
//   1. the welcome was a 45-word first-person product tour;
//   2. the h1 said MASTER SHADOW while the eyebrow above it said Architect --
//      two names for one mode, and the second is vocabulary this room forbids;
//   3. the feedback block shipped two medal emoji 1,100 lines after the file
//      states Law 3 (the tier is carried by its uppercase word, never a medal
//      that vanishes in greyscale packets and screen readers alike);
//   4. a nine-link footer advertised every allowed role's door with no role
//      filtering at all -- a BOARD surface linked from After Hours, and The
//      Library, which the server reports canViewEvidence:false for everyone.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const savedSession = {
  conversationId: 'conv-1',
  title: 'What does a bad third round look like',
  athleteId: null,
  sessionType: 'quick_round',
  createdAt: '2026-07-30T12:00:00.000Z',
  updatedAt: '2026-07-30T12:00:00.000Z',
};

function shadowFetchMock(mode: 'omega' | 'master' | 'scoped', role = 'admin') {
  return jest.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('/auth/session')) {
      return jsonResponse({ authenticated: true, role, auth_provider: 'microsoft' });
    }
    if (target.includes('/shadow/capabilities')) {
      return jsonResponse({ capabilities: { mode, allowedSessionTypes: ['quick_round'] } });
    }
    if (target.includes('/shadow/sessions')) {
      return jsonResponse({ success: true, conversations: [savedSession] });
    }
    return jsonResponse({ ok: true });
  });
}

async function renderShadow(mode: 'omega' | 'master' | 'scoped', role = 'admin') {
  global.fetch = shadowFetchMock(mode, role) as unknown as typeof fetch;
  render(<ShadowChatPage />);
  // Wait past the "Opening SHADOW" screen: the h1 is only the mode name once
  // the server-authoritative capabilities have landed.
  await screen.findByText('Authority Boundary');
}

it('names the Architect once, in the room vocabulary, with no Master heading', async () => {
  await renderShadow('master');

  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ARCHITECT');
  expect(screen.getByText('Architect')).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/Master/i);
});

it('opens with one spare line and a scope sentence instead of a first-person menu', async () => {
  await renderShadow('omega');

  const welcome = await screen.findByText(/^OMEGA ONLINE\./);
  const text = welcome.textContent ?? '';
  expect(text).toBe('OMEGA ONLINE. Platform tier. No organization-private athlete records.');
  // No first person anywhere in the opening line.
  expect(text).not.toMatch(/\bI\b|\bmy\b|\bme\b/);
  // The scope sentence is the one the header already prints, not a second
  // hand-written copy that can drift away from it.
  expect(screen.getByText('Platform tier. No organization-private athlete records.')).toBeTruthy();
});

it('carries the rating on its word, never a medal emoji', async () => {
  await renderShadow('scoped', 'coach');

  await waitFor(() => expect(screen.getByRole('button', { name: 'Helpful' })).toBeTruthy());
  expect(screen.getByRole('button', { name: 'Not helpful' })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/[\u{1F44D}\u{1F44E}]/u);
  expect(document.body.textContent).not.toMatch(/RLHF/);
});

it('advertises no doors: the unfiltered nine-link row is gone', async () => {
  await renderShadow('scoped', 'coach');

  for (const href of [
    '/board/compliance-monitoring',
    '/research/chat',
    '/coach/video-analysis',
    '/athlete/progression-intelligence',
    '/source-control/publication-workflow',
  ]) {
    expect(document.querySelector(`a[href="${href}"]`)).toBeNull();
  }
  expect(document.body.textContent).not.toMatch(/\(Planned\)/);
});

it('does not wear the File Room typeface', async () => {
  await renderShadow('scoped', 'coach');

  const main = document.querySelector('main');
  expect(main?.className).toContain('room--night');
  expect(main?.className).not.toContain('--font-type');
});

it('gives the rename field the design system input, not a 34px one-off', async () => {
  await renderShadow('scoped', 'coach');

  fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
  const field = await screen.findByLabelText(/New name for/);
  expect(field.className.split(/\s+/)).toContain('input');
  expect(field.className).not.toMatch(/min-h-\[/);
});
