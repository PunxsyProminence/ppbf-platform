/**
 * @jest-environment jsdom
 */

/**
 * A review queue that is worse than no queue.
 *
 * pilot.shadow_data_deletion_requests has been written since the SHADOW
 * runtime slice and read by exactly one query: its own writer's idempotency
 * check. POST /api/pilot/shadow/data answers `fulfillment:
 * 'manual_review_required'` for a review nothing surfaced.
 *
 * Putting a screen on it is only an improvement if the screen tells the truth.
 * These cases are the ways it would not: reporting a count it was rendered
 * with rather than the one the server cleared, showing an unreadable queue as
 * an empty one, or claiming a completed request erased more than it did.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ShadowDataDeletionQueue, { type ShadowDeletionRequestRow } from './ShadowDataDeletionQueue';

function row(overrides: Partial<ShadowDeletionRequestRow> = {}): ShadowDeletionRequestRow {
  return {
    requestId: 'req-1',
    accountId: 'acct-child',
    status: 'pending',
    requestedAt: '2026-08-20T10:00:00.000Z',
    completedAt: null,
    processedBy: null,
    conversationsPending: 11,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

interface Routes {
  list?: () => Response;
  /** Successive answers to POST, so a reload after an action can differ. */
  act?: (body: { request_id?: string; action?: string }) => Response;
}

function installFetch(routes: Routes = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/api/pilot/admin/shadow-data-requests')) {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { request_id?: string; action?: string };
      return routes.act
        ? routes.act(body)
        : jsonResponse({ ok: true, requestId: body.request_id, status: 'completed', conversationsCleared: 3 });
    }
    return routes.list ? routes.list() : jsonResponse({ ok: true, items: [row()] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderQueue(routes: Routes = {}): Promise<jest.Mock> {
  const fetchMock = installFetch(routes);
  await act(async () => {
    render(<ShadowDataDeletionQueue />);
  });
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('an unreadable queue is never shown as an empty one', () => {
  it('says the read failed rather than "no requests"', async () => {
    // "Nobody has asked" and "nobody could tell whether anybody asked" are
    // opposite facts about a queue of children's data requests. Collapsing
    // them is how an unread queue looks handled.
    await renderQueue({ list: () => jsonResponse({}, { ok: false, status: 500 }) });

    expect(screen.getByText(/could not be read/)).not.toBeNull();
    expect(screen.queryByText(/No requests are waiting/)).toBeNull();
  });

  it('treats a malformed payload the same way', async () => {
    await renderQueue({ list: () => jsonResponse({ ok: true }) });

    expect(screen.getByText(/could not be read/)).not.toBeNull();
    expect(screen.queryByText(/No requests are waiting/)).toBeNull();
  });

  it('says the queue is clear only when it actually read one', async () => {
    await renderQueue({ list: () => jsonResponse({ ok: true, items: [] }) });

    expect(screen.getByText('No requests are waiting on a decision.')).not.toBeNull();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });
});

describe('working a request', () => {
  it('asks before clearing a person\'s history', async () => {
    const fetchMock = await renderQueue();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    });

    // Armed, not fired.
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'POST'))
      .toHaveLength(0);
    expect(screen.getByText(/clears their SHADOW conversation history now/)).not.toBeNull();
  });

  it('reports the count the SERVER cleared, not the one the row was drawn with', async () => {
    // THE CASE THIS FILE EXISTS FOR. conversationsPending was counted when the
    // queue loaded; the person can have deleted conversations themselves
    // since. Echoing it would tell an admin eleven were cleared when three
    // were, on a record of a data-deletion request.
    await renderQueue({
      act: () => jsonResponse({ ok: true, status: 'completed', conversationsCleared: 3 }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear the history' }));
    });

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Cleared 3 conversations');
    expect(notice.textContent).not.toContain('11');
  });

  it('says what a completion does NOT cover', async () => {
    // Scope is conversation history. A "completed" that implied full erasure
    // would be the same class of lie as the dead letter it replaces.
    await renderQueue();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear the history' }));
    });

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('memory corrections are kept');
  });

  it('reports zero cleared as zero rather than hiding it', async () => {
    // Somebody who deleted everything themselves before the admin arrived has
    // had their request honoured, and the record should say so plainly.
    await renderQueue({
      act: () => jsonResponse({ ok: true, status: 'completed', conversationsCleared: 0 }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear the history' }));
    });

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Cleared 0 conversations');
  });

  it('denies without a confirm step, and says nothing was deleted', async () => {
    // Denying destroys nothing, so it does not need the second act that
    // clearing does. What it does need is to be on the record.
    const fetchMock = await renderQueue({
      act: () => jsonResponse({ ok: true, status: 'denied', conversationsCleared: 0 }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Deny/ }));
    });

    const posted = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    expect(JSON.parse(String((posted?.[1] as RequestInit).body)))
      .toEqual({ request_id: 'req-1', action: 'deny' });
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Nothing was deleted');
    expect(notice.textContent).toContain('on the record with your name against it');
  });

  it('re-reads the queue after acting rather than trusting its own copy', async () => {
    const fetchMock = await renderQueue();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear the history' }));
    });

    await waitFor(() => {
      const gets = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'GET');
      expect(gets.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('an action that did not happen', () => {
  it('surfaces a conflict verbatim and leaves the row alone', async () => {
    // 409 is what the route answers when a colleague already handled the row.
    await renderQueue({
      act: () => jsonResponse(
        { ok: false, error: 'That request is no longer open. Reload the queue.' },
        { ok: false, status: 409 },
      ),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Review/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear the history' }));
    });

    expect(await screen.findByText('That request is no longer open. Reload the queue.')).not.toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says nothing was changed when the request never landed', async () => {
    await renderQueue({
      act: () => {
        throw new Error('offline');
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Deny/ }));
    });

    expect(await screen.findByText(/nothing was changed/)).not.toBeNull();
  });
});

describe('a handled request stays visible and says how it was handled', () => {
  it('shows a completed request without action buttons', async () => {
    // A queue that hides what it did is a queue nobody can audit.
    await renderQueue({
      list: () => jsonResponse({
        ok: true,
        items: [row({
          status: 'completed',
          completedAt: '2026-08-21T09:00:00.000Z',
          processedBy: 'admin-1',
        })],
      }),
    });

    expect(screen.getByText(/CLEARED/)).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Review/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Deny/ })).toBeNull();
  });

  it('does not paint a waiting request in the safeguarding red', async () => {
    // That red is reserved for the top of the safety ladder -- a person who
    // may not participate. A data request waiting on an admin is work owed.
    await renderQueue();

    const badge = screen.getByText(/AWAITING REVIEW/);
    expect(badge.className).toContain('badge--restricted');
    expect(badge.className).not.toContain('badge--locked');
  });
});
