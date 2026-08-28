/**
 * @jest-environment jsdom
 */

// The behaviour probe for the queue that had no screen. What is held here is
// what a reviewer standing in a gym depends on: the critical count is real, the
// order on screen is the server's and not this page's, a stale tab response
// cannot repaint a queue the reviewer has already left, and nothing on this
// page is a door to a member's words.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ShadowReviewsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    review_id: 'rev-1',
    conversation_id: 'conv-1',
    account_id: 'acct-9',
    category: 'urgent_personal_symptom',
    severity: 'critical',
    summary: 'A SHADOW chat request was withheld by the pre-generation safety boundary.',
    status: 'open',
    metadata: { classification: 'urgent_personal_symptom', safetyReasons: ['chest_pain'] },
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-08-01T12:00:00.000Z',
    ...overrides,
  };
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.clearAllMocks();
});

test('the open queue loads first, because that is the queue that needs a person', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse({ reviews: [ticket()] }));

  render(<ShadowReviewsPage />);

  await screen.findByText(/withheld by the pre-generation safety boundary/);
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/pilot/shadow/reviews?status=open',
    expect.objectContaining({ credentials: 'include' }),
  );
});

test('a waiting critical is counted in words, not left to be noticed', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      reviews: [
        ticket({ review_id: 'rev-1' }),
        ticket({ review_id: 'rev-2' }),
        ticket({ review_id: 'rev-3', severity: 'moderate' }),
      ],
    }),
  );

  render(<ShadowReviewsPage />);

  const banner = await screen.findByRole('status');
  // Two, not three: the moderate ticket is in the queue but is not a critical.
  expect(banner.textContent).toContain('2 critical tickets waiting');
});

test('severity is a word on the row, so two similar reds never have to be told apart', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ reviews: [ticket({ severity: 'high' })] }),
  );

  render(<ShadowReviewsPage />);

  expect(await screen.findByText('HIGH')).toBeTruthy();
});

test('the order on screen is the order the server sent, not one this page invents', async () => {
  // Deliberately "wrong-looking" input: a moderate arrives ahead of a critical.
  // listHumanReviews is what sorts (critical -> high -> moderate, oldest first
  // within a severity); if this page ever starts re-sorting, the two orderings
  // can disagree and the row a reviewer works first stops being the row the
  // server decided was most urgent. This test fails the moment that happens.
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      reviews: [
        ticket({ review_id: 'rev-mod', severity: 'moderate', summary: 'second in the payload is second on screen' }),
        ticket({ review_id: 'rev-crit', severity: 'critical', summary: 'first in the payload is first on screen' }),
      ],
    }),
  );

  render(<ShadowReviewsPage />);

  await screen.findByText(/second in the payload is second on screen/);
  const rows = screen.getAllByRole('listitem');
  expect(within(rows[0]).getByText('MODERATE')).toBeTruthy();
  expect(within(rows[1]).getByText('CRITICAL')).toBeTruthy();
});

test('switching tabs asks the server for that status', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ reviews: [] }))
    .mockResolvedValueOnce(jsonResponse({ reviews: [ticket({ status: 'resolved' })] }));

  render(<ShadowReviewsPage />);
  await screen.findByText(/Nothing waiting/);

  fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/pilot/shadow/reviews?status=resolved',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

test('a slow response from a tab the reviewer has left cannot repaint the queue', async () => {
  // The failure this prevents: click Open, click Resolved, and the slower Open
  // response lands second. Without the guard the reviewer is looking at the
  // Resolved tab while unactioned open criticals are painted underneath it --
  // tickets nobody has touched, read as already dealt with.
  let releaseOpen: (value: Response) => void = () => {};
  const slowOpen = new Promise<Response>((resolve) => {
    releaseOpen = resolve;
  });

  fetchMock
    .mockReturnValueOnce(slowOpen)
    .mockResolvedValueOnce(jsonResponse({ reviews: [] }));

  render(<ShadowReviewsPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Dismissed' }));
  await screen.findByText(/No dismissed tickets/);

  // The release has to be flushed to completion before anything is asserted.
  // A waitFor() around an absence is worthless here: it passes on its first
  // tick, before the resolved promise has even reached setReviews, so it holds
  // just as well with the guard deleted. Draining inside act() lets the stale
  // response get all the way to a render -- which is exactly what must not
  // change the screen.
  await act(async () => {
    releaseOpen(jsonResponse({ reviews: [ticket({ summary: 'stale open ticket' })] }));
    await slowOpen;
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.queryByText(/stale open ticket/)).toBeNull();
  expect(screen.getByText(/No dismissed tickets/)).toBeTruthy();
});

test('a triage decision is sent as the transition the route accepts, then the queue is re-read', async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ reviews: [ticket()] }))
    .mockResolvedValueOnce(jsonResponse({ ok: true }))
    .mockResolvedValueOnce(jsonResponse({ reviews: [] }));

  render(<ShadowReviewsPage />);
  await screen.findByText(/withheld by the pre-generation safety boundary/);

  fireEvent.click(screen.getByRole('button', { name: /Resolved — acted on in the gym/ }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pilot/shadow/reviews',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ reviewId: 'rev-1', status: 'resolved' }),
      }),
    );
  });
  // The re-read, not an optimistic removal: what the reviewer sees next is what
  // the server says, so a PATCH that half-succeeded cannot leave the screen
  // claiming a ticket was handled.
  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/pilot/shadow/reviews?status=open',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

test('nothing on the page re-opens a ticket', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ reviews: [ticket({ status: 'in_review', reviewed_by: 'acct-admin' })] }),
  );

  render(<ShadowReviewsPage />);
  await screen.findByText(/withheld by the pre-generation safety boundary/);

  // The route refuses 'open' as a transition so that one reviewer cannot undo
  // another's resolution. The page must not offer what the route refuses.
  expect(screen.queryByRole('button', { name: /re-?open/i })).toBeNull();
  expect(screen.queryByRole('button', { name: 'I am looking at this' })).toBeNull();
});

test('a closed ticket carries no controls', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ reviews: [ticket({ status: 'resolved', reviewed_by: 'acct-admin' })] }),
  );

  render(<ShadowReviewsPage />);
  const row = await screen.findByRole('listitem');

  expect(within(row).queryAllByRole('button')).toHaveLength(0);
});

test('the page never asks for a conversation, and renders no message text of its own', async () => {
  // A ticket carries a conversation_id. This page does not turn it into a door.
  // A reviewer needs to know a child raised something the boundary refused to
  // answer and to act on it in the room; reading the conversation is a separate
  // audited decision behind its own route.
  //
  // The one channel that would carry words is `metadata`, which is rendered
  // verbatim -- honestly, so the screen shows exactly what was recorded. That
  // makes "no message text in metadata" a property of the writers, not of this
  // file. What is enforced here is the rest: no transcript fetch, and no
  // top-level message field rendered even when one is present in the payload.
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      reviews: [ticket({ message: 'my chest hurts when i skip', last_message: 'please help' })],
    }),
  );

  render(<ShadowReviewsPage />);
  await screen.findByText(/withheld by the pre-generation safety boundary/);

  expect(screen.queryByText(/my chest hurts when i skip/)).toBeNull();
  expect(screen.queryByText(/please help/)).toBeNull();
  expect(screen.queryByText('conv-1')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();

  const conversationCalls = fetchMock.mock.calls.filter(
    ([url]) => typeof url === 'string' && /conversation/i.test(url),
  );
  expect(conversationCalls).toHaveLength(0);
});

test("a refused change says so rather than looking like it worked", async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ reviews: [ticket()] }))
    .mockResolvedValueOnce(jsonResponse({ error: 'review not found' }, false));

  render(<ShadowReviewsPage />);
  await screen.findByText(/withheld by the pre-generation safety boundary/);

  fireEvent.click(screen.getByRole('button', { name: /Dismiss — nothing to act on/ }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('review not found');
  // The row is still there: a failed dismissal does not clear the queue.
  expect(screen.getByText(/withheld by the pre-generation safety boundary/)).toBeTruthy();
});

test('an unreachable queue is reported as unreachable, not as an empty queue', async () => {
  // The difference that matters: "nothing waiting" and "we could not ask" look
  // identical to a reviewer unless the page says which one it is.
  fetchMock.mockRejectedValueOnce(new Error('network down'));

  render(<ShadowReviewsPage />);

  expect((await screen.findByRole('alert')).textContent).toContain('Could not reach the review queue.');
  expect(screen.queryByText(/Nothing waiting/)).toBeNull();
});
