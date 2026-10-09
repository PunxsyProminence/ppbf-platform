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

// The shell is the same one /admin/compliance-center and /admin/shadow use. It
// is mocked down to a <main> that carries the room classes the real shell
// emits (components/RoleStandaloneView.tsx: `room room--<room> min-h-screen`),
// and it records the props this page hands it.
const mockShellProps: { allowedRoles: string[]; room?: string; showShellHeader?: boolean }[] = [];
jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({
    children,
    allowedRoles,
    room,
    showShellHeader,
  }: {
    readonly children: ReactNode;
    readonly allowedRoles: string[];
    readonly room?: string;
    readonly showShellHeader?: boolean;
  }) => {
    mockShellProps.push({ allowedRoles, room, showShellHeader });
    return <main className={`room room--${room} min-h-screen`}>{children}</main>;
  },
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

test('the page is gated to organization admins; platform_owner is not admitted (OD-2026-10-05-024 ruling 3)', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse({ reviews: [] }));
  mockShellProps.length = 0;

  render(<ShadowReviewsPage />);

  await waitFor(() => expect(mockShellProps.length).toBeGreaterThan(0));
  for (const { allowedRoles } of mockShellProps) {
    expect(allowedRoles).toContain('admin');
    expect(allowedRoles).not.toContain('platform_owner');
  }
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

// The queue holds three classes of ticket since the human-review foundation:
// a high-risk request (which may have been answered), a generated answer the
// safety boundary withheld or replaced, and the operational rows that already
// existed, such as the empty-Library notice. The page's own words must not
// say every ticket is a refusal.
test('the page says what the queue holds: three classes of ticket, not only refusals', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse({ reviews: [] }));

  render(<ShadowReviewsPage />);

  await screen.findByText('Nothing waiting. Tickets appear when SHADOW sends a chat or generated result for human review.');
  // "\u{2014}" is the em dash in the page's sentence.
  expect(screen.getByText(
    'SHADOW chats sent for a human look. A ticket can come from a high-risk request, a generated answer that was withheld or replaced, or another route condition that needs review \u{2014} not necessarily because SHADOW failed.',
  )).toBeTruthy();
  expect(screen.queryByText(/refused to answer/)).toBeNull();
  expect(screen.queryByText(/withholds an answer/)).toBeNull();
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
  // The one flagged exchange is readable on a click through the reviews route
  // (tested below, "the flagged exchange behind a ticket"); the conversation
  // itself is not, and nothing here fetches or links to it.
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

// STYLING PIN. This page shipped (#779) with class names no stylesheet defines
// -- shadow-reviews, tabs, tab, queue, ticket, severity-critical, actions --
// so the status tabs and action buttons rendered as run-together plain text
// (found on production in the Release 11 walk-through). It now uses the design
// system's own shell and components, the same ones /admin/athlete-consent and
// /admin/compliance-center use. jsdom cannot render CSS, so this pins the
// structure that carries the look: if someone reintroduces the made-up names
// or drops the shared shell, this fails. It is not a visual check.
test('the page uses the shared admin shell and design-system components, not class names with no CSS', async () => {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ reviews: [ticket({ severity: 'high', status: 'open' })] }),
  );

  mockShellProps.length = 0;
  const { container } = render(<ShadowReviewsPage />);
  await screen.findByText(/withheld by the pre-generation safety boundary/);

  // The page hands the shared shell the clinic room, as /admin/compliance-center
  // does, and does not draw a <main> of its own.
  expect(mockShellProps.at(-1)).toMatchObject({ room: 'clinic', showShellHeader: false });
  expect(container.querySelectorAll('main')).toHaveLength(1);
  expect(container.querySelector('header')?.className).toContain('mat-wood');

  // Status tabs are buttons on the design system's button ladder; the active
  // one is the filled button, the others are ghost.
  const tabs = within(screen.getByRole('navigation', { name: 'Review status' })).getAllByRole('button');
  expect(tabs.map((b) => b.textContent)).toEqual(['Open', 'In review', 'Resolved', 'Dismissed']);
  for (const tab of tabs) expect(tab.className).toMatch(/\bbtn\b/);
  expect(tabs[0].className).not.toContain('btn--ghost');
  expect(tabs[1].className).toContain('btn--ghost');

  // The ticket is a raised leather card with a severity badge on the ladder.
  const card = screen.getByRole('listitem');
  expect(card.className).toContain('mat-leather--raised');
  expect(within(card).getByText('HIGH').className).toMatch(/\bbadge\b.*\bbadge--restricted\b/);

  // Every action stays reachable and is a styled button.
  for (const name of [/I am looking at this/, /Resolved — acted on in the gym/, /Dismiss — nothing to act on/]) {
    expect(within(card).getByRole('button', { name }).className).toMatch(/\bbtn\b/);
  }

  // None of the names that had no stylesheet behind them may come back.
  const dead = [
    'shadow-reviews', 'tabs', 'tab', 'tab-active', 'queue', 'ticket', 'ticket-head',
    'severity-critical', 'severity-high', 'severity-moderate', 'severity-badge',
    'critical-banner', 'lede', 'muted', 'secondary', 'actions', 'facts', 'meta',
    'summary', 'when', 'category', 'error',
  ];
  const used = new Set<string>();
  container.querySelectorAll('[class]').forEach((el) => {
    el.className.toString().split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  });
  expect(dead.filter((c) => used.has(c))).toEqual([]);
});

/**
 * The one exchange (OD-2026-10-07-009 question card 2 item 4, "That one
 * exchange"). What is held: nothing is fetched until the reviewer clicks; the
 * click asks the reviews route for that ticket and nothing else; what comes
 * back is rendered with the asker's role and age band and the words of the
 * two messages; the control says the read is recorded; a ticket with no
 * stored message says so; a closed ticket offers no door; and still no
 * conversation is fetched or linked.
 */
describe('the flagged exchange behind a ticket', () => {
  const EXCHANGE = {
    recorded: true,
    subject: { accountId: 'acct-9', role: 'athlete', ageBand: 'under_18' },
    userMessage: { messageId: 'u1', content: 'my chest hurts when i skip', createdAt: '2026-08-01T12:00:00.000Z' },
    assistantMessage: {
      messageId: 'a1',
      content: 'Stop and tell a coach now.',
      createdAt: '2026-08-01T12:00:00.001Z',
      responseState: 'filtered',
    },
  };

  test('nothing is read until the reviewer asks, and the control says the read is recorded', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ reviews: [ticket()] }));
    render(<ShadowReviewsPage />);
    await screen.findByText(/withheld by the pre-generation safety boundary/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const control = screen.getByRole('button', { name: /read the flagged exchange/i });
    expect(control.textContent).toMatch(/recorded against your account/i);
    expect(screen.queryByText(/my chest hurts/)).toBeNull();
  });

  test('the click asks for that ticket only, and renders the two messages labelled by role and age band', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ reviews: [ticket()] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, exchange: EXCHANGE }));
    render(<ShadowReviewsPage />);
    await screen.findByText(/withheld by the pre-generation safety boundary/);

    fireEvent.click(screen.getByRole('button', { name: /read the flagged exchange/i }));

    await screen.findByText('my chest hurts when i skip');
    expect(screen.getByText('Stop and tell a coach now.')).toBeTruthy();
    expect(screen.getByText(/asked by: athlete/i).textContent).toMatch(/under 18/);
    expect(screen.getByText(/what shadow sent instead/i)).toBeTruthy();
    expect(screen.getByText(/only this exchange is shown\. this read has been recorded/i)).toBeTruthy();

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toMatch(/\/api\/pilot\/shadow\/reviews\?reviewId=rev-1$/);
    expect(init.credentials).toBe('include');
    // Still no door to the conversation: no transcript fetch, no link.
    expect(fetchMock.mock.calls.some(([u]) => typeof u === 'string' && /conversation/i.test(u))).toBe(false);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('conv-1')).toBeNull();
    // The control is gone once the exchange is open: one click, one read.
    expect(screen.queryByRole('button', { name: /read the flagged exchange/i })).toBeNull();
  });

  test('an athlete with no date of birth is shown as missing and treated as under 18', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ reviews: [ticket()] }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        exchange: { ...EXCHANGE, subject: { accountId: 'acct-9', role: 'athlete', ageBand: 'age_not_on_record' } },
      }));
    render(<ShadowReviewsPage />);
    await screen.findByText(/withheld by the pre-generation safety boundary/);
    fireEvent.click(screen.getByRole('button', { name: /read the flagged exchange/i }));
    const label = await screen.findByText(/asked by: athlete/i);
    expect(label.textContent).toMatch(/age not on record — treated as under 18/);
  });

  test('a staff account with no athlete record is "age not on record", never "treated as under 18"', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ reviews: [ticket()] }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        exchange: { ...EXCHANGE, subject: { accountId: 'acct-9', role: 'coach', ageBand: 'age_not_on_record' } },
      }));
    render(<ShadowReviewsPage />);
    await screen.findByText(/withheld by the pre-generation safety boundary/);
    fireEvent.click(screen.getByRole('button', { name: /read the flagged exchange/i }));
    const label = await screen.findByText(/asked by: coach/i);
    expect(label.textContent).toMatch(/age not on record$/);
    expect(label.textContent).not.toMatch(/treated as under 18/);
  });

  test('a ticket that names no stored message says so, and shows no words', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ reviews: [ticket()] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, exchange: { recorded: false, reason: 'no_message_on_ticket' } }));
    render(<ShadowReviewsPage />);
    await screen.findByText(/withheld by the pre-generation safety boundary/);
    fireEvent.click(screen.getByRole('button', { name: /read the flagged exchange/i }));
    await screen.findByText(/exchange not recorded/i);
    expect(screen.queryByText(/^the question$/i)).toBeNull();
  });

  test('a refused read is reported on the ticket, not shown as an exchange', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ reviews: [ticket()] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Not found' }, false));
    render(<ShadowReviewsPage />);
    await screen.findByText(/withheld by the pre-generation safety boundary/);
    fireEvent.click(screen.getByRole('button', { name: /read the flagged exchange/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/not found/i);
    expect(screen.queryByText(/^the question$/i)).toBeNull();
  });

  test('a closed ticket offers no door to the exchange', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ reviews: [ticket({ status: 'resolved', reviewed_by: 'acct-admin', reviewed_at: '2026-08-02T09:00:00.000Z' })] }));
    render(<ShadowReviewsPage />);
    await screen.findByText(/withheld by the pre-generation safety boundary/);
    expect(screen.queryByRole('button', { name: /read the flagged exchange/i })).toBeNull();
  });
});

test('a read still in flight when the tab changes cannot refill a cleared panel', async () => {
  let release: (value: Response) => void = () => {};
  const slowExchange = new Promise<Response>((resolve) => { release = resolve; });
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ reviews: [ticket()] }))          // open
    .mockReturnValueOnce(slowExchange)                                       // the click
    .mockResolvedValueOnce(jsonResponse({ reviews: [ticket({ status: 'in_review' })] })); // in_review tab
  render(<ShadowReviewsPage />);
  await screen.findByText(/withheld by the pre-generation safety boundary/);
  fireEvent.click(screen.getByRole('button', { name: /read the flagged exchange/i }));
  fireEvent.click(screen.getByRole('button', { name: 'In review' }));
  await screen.findByText(/withheld by the pre-generation safety boundary/);

  await act(async () => {
    release(jsonResponse({
      success: true,
      exchange: {
        recorded: true,
        subject: { accountId: 'acct-9', role: 'athlete', ageBand: 'under_18' },
        userMessage: { messageId: 'u1', content: 'my chest hurts when i skip', createdAt: '2026-08-01T12:00:00.000Z' },
        assistantMessage: { messageId: 'a1', content: 'Tell a coach now.', createdAt: '2026-08-01T12:00:00.001Z', responseState: 'filtered' },
      },
    }));
    await slowExchange;
  });

  expect(screen.queryByText(/my chest hurts/)).toBeNull();
  expect(screen.getByRole('button', { name: /read the flagged exchange/i })).toBeTruthy();
});
