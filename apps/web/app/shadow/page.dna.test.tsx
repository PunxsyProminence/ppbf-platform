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
  feedbackBodies.length = 0;
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

/** Every POST body the page sent to the feedback route, in order. */
const feedbackBodies: Array<Record<string, unknown>> = [];

function shadowFetchMock(mode: 'omega' | 'master' | 'scoped', role = 'admin') {
  return jest.fn(async (url: string, init?: RequestInit) => {
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
    if (target.includes('/shadow/feedback')) {
      feedbackBodies.push(JSON.parse(String(init?.body ?? '{}')));
      return jsonResponse({ ok: true });
    }
    if (target.includes('/shadow/chat')) {
      // A durable, server-persisted answer: state 'ok' with both a
      // conversation and a message id is exactly the combination the page
      // requires before it will offer a rating at all.
      return jsonResponse({
        success: true,
        state: 'ok',
        response: 'Drop the lead shoulder on the exit.\n\n- Reset the guard first.\n- Then the pivot.',
        messageId: '11111111-2222-4333-8444-555555555555',
        conversationId: 'conv-1',
        tier: 'quick_round',
        modelUsed: 'scout-1',
        evidenceTier: 'EMERGING',
      });
    }
    return jsonResponse({ ok: true });
  });
}

/** Ask a question and wait for the answer bubble to land. */
async function askShadow() {
  fireEvent.change(await screen.findByLabelText('Your question'), {
    target: { value: 'What does the third round look like' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask SHADOW' }));
  await screen.findByText('Drop the lead shoulder on the exit.');
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
  await askShadow();

  await waitFor(() => expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy());
  expect(screen.getByRole('button', { name: 'Not yet' })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/[\u{1F44D}\u{1F44E}]/u);
  expect(document.body.textContent).not.toMatch(/RLHF/);
});

/* THE FIFTH THING THIS PAGE GOT WRONG, and the one nothing above caught: the
   rating block rendered under EVERY shadow bubble, so the opening line -- a
   sentence the page wrote itself, which no server ever stored and no reviewer
   could ever act on -- came with a required-reason textarea and two disabled
   buttons under it. A rating belongs to an answer that exists on the server. */
it('offers no rating on the line the page wrote itself', async () => {
  await renderShadow('scoped', 'coach');

  expect(screen.queryByText('Did this help?')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull();

  await askShadow();

  // Exactly one rating on screen: the answer's. Not the welcome's, and not
  // one under the coach's own question either.
  expect(screen.getAllByText('Did this help?')).toHaveLength(1);
});

/* Saying yes was a paragraph of writing: sendFeedback returned early without
   a reason, on a route whose `comment` field is optional. */
it('takes a positive rating in one action, with no reason demanded', async () => {
  await renderShadow('scoped', 'coach');
  await askShadow();

  fireEvent.click(await screen.findByRole('button', { name: 'Yes' }));

  await waitFor(() => expect(feedbackBodies).toHaveLength(1));
  expect(feedbackBodies[0]).toEqual({
    helpful: true,
    message_id: '11111111-2222-4333-8444-555555555555',
  });
  // outcome_signal is the server's to derive. A client-supplied one outside
  // the review queue's allowlist would strand the row unapprovable forever.
  expect(feedbackBodies[0]).not.toHaveProperty('outcome_signal');
  await screen.findByText('Feedback recorded.');
});

/* Running text was `.t-body` -- 14px -- and one <p> per answer however many
   paragraphs the model wrote. The transcript itself announced nothing. */
it('sets the answer for reading and announces the transcript', async () => {
  await renderShadow('scoped', 'coach');
  await askShadow();

  const log = document.querySelector('[role="log"]');
  expect(log?.getAttribute('aria-live')).toBe('polite');
  expect(log?.getAttribute('aria-label')).toBe('SHADOW conversation');

  const answer = screen.getByText('Drop the lead shoulder on the exit.');
  const prose = answer.parentElement;
  expect(prose?.className).toContain('text-[16px]');
  expect(prose?.className).toContain('max-w-[66ch]');
  // The bulleted half of the answer is a real list, not more of the paragraph.
  expect(prose?.querySelectorAll('ul li')).toHaveLength(2);
});

/* Which model ran and when it answered are diagnostics. They sat at full
   contrast between the answer and the controls, on a surface an athlete or a
   parent reaches. */
it('keeps model, tier and timestamp behind a disclosure', async () => {
  await renderShadow('scoped', 'coach');
  await askShadow();

  const details = screen.getByText('Details').closest('details');
  expect(details).toBeTruthy();
  expect((details as HTMLDetailsElement).open).toBe(false);
  expect(details?.textContent).toContain('scout-1');
  expect(details?.textContent).toContain('Quick Round');
});

/* The page carried its own Logout next to the role badge while the signed-in
   header carried one too -- two doors to the same POST, two tab stops apart,
   on the surface where a mis-click costs a conversation in progress. */
it('does not hang a second Logout beside the global one', async () => {
  await renderShadow('scoped', 'coach');

  expect(screen.queryByRole('button', { name: 'Logout' })).toBeNull();
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
