/**
 * @jest-environment jsdom
 */

// The dashboard's Show on TV switch (gym TV S1; Jason, Q3: "it should be a
// capability in the coaches dashboard"). It is the live screen's switch on the
// Today's Session card: it sends the value it wants, shows the server's answer,
// and re-reads the run when the server says the run is no longer live.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import CoachWorkspace from './CoachWorkspace';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

/** A live run as GET /api/pilot/session-scripts/runs returns it in `run`. */
function liveRunRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'run_1',
    script_id: 'scr_1',
    script_version: 3,
    activity_id: null,
    delivered_by_account_id: 'acct_coach_1',
    delivered_on: '2026-08-28',
    athletes_present: 11,
    run_state: 'in_progress',
    started_at: '2026-08-28T22:00:00.000Z',
    ended_at: null,
    current_block_id: 'blk_2',
    paused_at: null,
    paused_seconds: 0,
    show_on_wall: false,
    elapsed_seconds: 1530,
    is_paused: false,
    ...overrides,
  };
}

interface Routes {
  liveRunGet?: () => Response;
  runPatch?: (body: Record<string, unknown>) => Response;
}

function installFetch(routes: Routes): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_coach_1' });
    }
    if (url.includes('/api/pilot/session-scripts/runs/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return routes.runPatch ? routes.runPatch(body) : jsonResponse({ run: liveRunRow({ show_on_wall: body.show }) });
    }
    if (url.includes('/api/pilot/session-scripts/runs')) {
      return routes.liveRunGet ? routes.liveRunGet() : jsonResponse({ run: null });
    }
    if (url.includes('/api/pilot/scheduler')) return jsonResponse({ ok: true, classes: [] });
    if (url.includes('/api/pilot/coach/credentials')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/coach/attendance-today')) {
      return jsonResponse({ ok: true, day: '2026-08-28', covered: [], marks: [] });
    }
    if (url.includes('/api/pilot/coach/development')) return jsonResponse({ ok: true, goals: [], activities: [] });
    if (url.includes('/api/pilot/coach/readiness-board')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/athletes/list')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/announcements')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/escalations')) return jsonResponse({ items: [] });
    return jsonResponse({ items: [], reports: [] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderWorkspace(routes: Routes = {}): Promise<jest.Mock> {
  const fetchMock = installFetch(routes);
  await act(async () => {
    render(<CoachWorkspace />);
  });
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('no live run: no TV switch is offered', async () => {
  await renderWorkspace();
  expect(screen.queryByText('No session in progress.')).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'Show on TV' })).toBeNull();
  expect(screen.queryByText('NOT ON THE TV')).toBeNull();
});

test('a live run starts off the TV and the switch sends show:true, then shows the server state', async () => {
  const fetchMock = await renderWorkspace({ liveRunGet: () => jsonResponse({ run: liveRunRow() }) });

  expect(screen.queryByText('NOT ON THE TV')).not.toBeNull();
  expect(screen.queryByText('ON THE TV')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Show on TV' }));

  await waitFor(() => expect(screen.queryByText('ON THE TV')).not.toBeNull());
  expect(screen.queryByText('NOT ON THE TV')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Take off the TV' })).not.toBeNull();

  const patch = fetchMock.mock.calls.find(
    (call) => String(call[0]).includes('/api/pilot/session-scripts/runs/run_1') && (call[1] as RequestInit).method === 'PATCH',
  );
  expect(patch).toBeDefined();
  expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ action: 'show_on_wall', show: true });
});

test('a run already on the TV offers Take off the TV and sends show:false (never a toggle)', async () => {
  const fetchMock = await renderWorkspace({
    liveRunGet: () => jsonResponse({ run: liveRunRow({ show_on_wall: true }) }),
  });
  expect(screen.queryByText('ON THE TV')).not.toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Take off the TV' }));
  await waitFor(() => expect(screen.queryByText('NOT ON THE TV')).not.toBeNull());

  const patch = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PATCH');
  expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ action: 'show_on_wall', show: false });
});

test('the badge is the server\'s answer, not the tap: a refused switch stays off and says so', async () => {
  await renderWorkspace({
    liveRunGet: () => jsonResponse({ run: liveRunRow() }),
    runPatch: () => jsonResponse({ error: 'SOME_REFUSAL' }, { ok: false, status: 409 }),
  });

  fireEvent.click(screen.getByRole('button', { name: 'Show on TV' }));

  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
  expect(screen.getByRole('alert').textContent).toContain('SOME_REFUSAL');
  expect(screen.queryByText('NOT ON THE TV')).not.toBeNull();
  expect(screen.queryByText('ON THE TV')).toBeNull();
});

test('the badge is the server answer even on success: asked for true, told false, shows NOT ON THE TV', async () => {
  await renderWorkspace({
    liveRunGet: () => jsonResponse({ run: liveRunRow() }),
    runPatch: () => jsonResponse({ run: liveRunRow({ show_on_wall: false }) }),
  });

  fireEvent.click(screen.getByRole('button', { name: 'Show on TV' }));

  // The request completes; the component must take the server's value, not the tap's.
  await waitFor(() => expect((screen.getByRole('button', { name: 'Show on TV' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText('NOT ON THE TV')).not.toBeNull();
  expect(screen.queryByText('ON THE TV')).toBeNull();
});

test('a network failure says the state is unconfirmed and leaves the badge alone', async () => {
  const fetchMock = await renderWorkspace({ liveRunGet: () => jsonResponse({ run: liveRunRow() }) });
  fetchMock.mockImplementationOnce(async () => {
    throw new Error('offline');
  });

  fireEvent.click(screen.getByRole('button', { name: 'Show on TV' }));

  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());
  expect(screen.getByRole('alert').textContent).toMatch(/could not confirm/i);
  expect(screen.queryByText('NOT ON THE TV')).not.toBeNull();
});

test('a run the server says is no longer live is re-read, not left showing a stale switch', async () => {
  let reads = 0;
  await renderWorkspace({
    liveRunGet: () => {
      reads += 1;
      return reads === 1 ? jsonResponse({ run: liveRunRow() }) : jsonResponse({ run: null });
    },
    runPatch: () => jsonResponse({ error: 'SESSION_RUN_NOT_LIVE' }, { ok: false, status: 409 }),
  });

  fireEvent.click(screen.getByRole('button', { name: 'Show on TV' }));

  await waitFor(() => expect(screen.queryByText('No session in progress.')).not.toBeNull());
  expect(screen.queryByRole('button', { name: 'Show on TV' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});
