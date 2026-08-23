/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import SessionScriptLiveDelivery from './SessionScriptLiveDelivery';
import type { LiveSessionScriptRun } from '@/src/server/pilot/sessionScriptRuns';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as Response;
}

function liveRun(overrides: Partial<LiveSessionScriptRun> = {}): LiveSessionScriptRun {
  return {
    organization_id: 'org-1',
    run_id: 'ssrun_1',
    script_id: 'scr-friday',
    script_version: 3,
    activity_id: null,
    delivered_by_account_id: 'acct_coach_1',
    delivered_on: '2026-08-14',
    athletes_present: null,
    blocks_completed: null,
    reset_protocol_used: false,
    deviation_note: '',
    what_worked: '',
    what_did_not: '',
    created_at: '2026-08-14T22:00:00.000Z',
    run_state: 'in_progress',
    started_at: '2026-08-14T22:00:00.000Z',
    ended_at: null,
    current_block_id: 'blk-2',
    paused_at: null,
    paused_seconds: 0,
    elapsed_seconds: 125,
    is_paused: false,
    ...overrides,
  };
}

function block(id: string, order: number, label: string, overrides: Record<string, unknown> = {}) {
  return {
    block_id: id,
    block_order: order,
    start_offset_min: (order - 1) * 10,
    end_offset_min: order * 10,
    block_label: label,
    what_to_say: null,
    what_to_explain: null,
    what_to_watch: null,
    what_to_fix: null,
    block_kind: 'drill_round',
    drill_id: null,
    scale_level: null,
    contact_level: 'none',
    ...overrides,
  };
}

function scriptDetail(overrides: Record<string, unknown> = {}) {
  return {
    script_id: 'scr-friday',
    name: 'Friday sparring',
    version: 3,
    discipline: 'boxing',
    theme: '',
    reset_protocol: '',
    coach_priorities: '',
    blocks: [
      block('blk-1', 1, 'Arrival and wraps'),
      block('blk-2', 2, 'Add slip and visual response', {
        what_to_say: 'Eyes on the chest, not the glove.',
        what_to_fix: null,
      }),
      block('blk-3', 3, 'Conditioning finish'),
    ],
    renderings: [],
    ...overrides,
  };
}

interface Handlers {
  detail?: () => Response | Promise<Response>;
  patch?: (body: Record<string, unknown>) => Response | Promise<Response>;
  runsGet?: () => Response | Promise<Response>;
  athletes?: () => Response | Promise<Response>;
  protocols?: () => Response | Promise<Response>;
  logPost?: (body: Record<string, unknown>) => Response | Promise<Response>;
  roster?: () => Response | Promise<Response>;
  readinessBoard?: () => Response | Promise<Response>;
}

const DEFAULT_LOG_ATHLETES = [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }];
const DEFAULT_LOG_PROTOCOLS = [
  { protocol_id: 'proto-1', title: 'Round-3 endurance block', version: 1, athlete_id: null, status: 'active' },
];

function mockFetch(handlers: Handlers = {}) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/coach/intervention-executions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (handlers.logPost) return handlers.logPost(body);
      return jsonResponse({ item: { execution_id: 'exec-1', created_at: '2026-08-17T00:00:00.000Z' } });
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return handlers.athletes ? handlers.athletes() : jsonResponse({ items: DEFAULT_LOG_ATHLETES });
    }
    if (url.includes('/api/pilot/profile/roster')) {
      return handlers.roster ? handlers.roster() : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/coach/readiness-board')) {
      return handlers.readinessBoard ? handlers.readinessBoard() : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/coach/intervention-protocols')) {
      return handlers.protocols ? handlers.protocols() : jsonResponse({ items: DEFAULT_LOG_PROTOCOLS });
    }
    if (url.includes('/api/pilot/session-scripts/runs/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (handlers.patch) return handlers.patch(body);
      throw new Error(`Unexpected PATCH: ${url}`);
    }
    if (url.includes('/api/pilot/session-scripts/runs')) {
      if (handlers.runsGet) return handlers.runsGet();
      throw new Error(`Unexpected runs GET: ${url}`);
    }
    if (url.includes('script_id=')) {
      return handlers.detail ? handlers.detail() : jsonResponse({ script: scriptDetail() });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function patchCalls(fetchMock: jest.Mock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).includes('/api/pilot/session-scripts/runs/'))
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
}

function logPostCalls(fetchMock: jest.Mock): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).includes('/api/pilot/coach/intervention-executions') && (call[1] as RequestInit | undefined)?.method === 'POST')
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
}

async function renderLive(
  run: LiveSessionScriptRun,
  handlers: Handlers = {},
  callbacks: { onSettled?: jest.Mock; onRunGone?: jest.Mock } = {},
) {
  const fetchMock = mockFetch(handlers);
  const onSettled = callbacks.onSettled ?? jest.fn();
  const onRunGone = callbacks.onRunGone ?? jest.fn();
  await act(async () => {
    render(
      <SessionScriptLiveDelivery initialRun={run} onSettled={onSettled} onRunGone={onRunGone} />,
    );
  });
  return { fetchMock, onSettled, onRunGone };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('live surface renders the real script and run', () => {
  it('shows the script name, server elapsed time, running state, and the current block distinctly', async () => {
    await renderLive(liveRun());

    expect(screen.getByText('Friday sparring')).toBeInTheDocument();
    // 125 seconds from the SERVER, formatted -- not computed from started_at.
    expect(screen.getByLabelText('Elapsed delivery time')).toHaveTextContent('2:05');
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(screen.getByText(/Pinned at version 3/)).toBeInTheDocument();

    // The current block is first-class and its authored fields render.
    expect(screen.getByText('Current block')).toBeInTheDocument();
    expect(screen.getAllByText('Add slip and visual response').length).toBeGreaterThan(0);
    expect(screen.getByText(/Eyes on the chest/)).toBeInTheDocument();
    // Null authored fields are omitted, never printed as empty labels.
    expect(screen.queryByText('Fix:')).not.toBeInTheDocument();

    // Position labels: before the cursor is Earlier, after it is Upcoming.
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('Earlier');
    expect(items[1].textContent).toContain('Current');
    expect(items[2].textContent).toContain('Upcoming');
  });

  it('warns when the plan shown is a different version than the run pinned', async () => {
    await renderLive(liveRun({ script_version: 2 }));
    expect(await screen.findByText(/The plan below is version 3; this session pinned version 2/)).toBeInTheDocument();
  });

  it('a failed plan read keeps the session controls and says the plan is missing, not empty', async () => {
    await renderLive(liveRun(), { detail: () => jsonResponse({}, false) });

    expect(screen.getByText(/The plan for this session could not be loaded/)).toBeInTheDocument();
    // The run is still live and still controllable.
    expect(screen.getByRole('button', { name: 'Pause session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End session...' })).toBeInTheDocument();
    // No block can be named, so navigation is disabled rather than guessing.
    expect(screen.getByRole('button', { name: 'Next block' })).toBeDisabled();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });
});

describe('the server owns the clock', () => {
  it('ticks the display forward between responses without ever writing time back', async () => {
    jest.useFakeTimers();
    const { fetchMock } = await renderLive(liveRun({ elapsed_seconds: 125 }));

    expect(screen.getByLabelText('Elapsed delivery time')).toHaveTextContent('2:05');
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByLabelText('Elapsed delivery time')).toHaveTextContent('2:08');

    // Presentation only: the tick produced zero requests.
    expect(patchCalls(fetchMock)).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/runs')),
    ).toHaveLength(0);
  });

  it('a paused run\'s display is frozen and Resume is the offered action', async () => {
    jest.useFakeTimers();
    await renderLive(liveRun({ is_paused: true, paused_at: '2026-08-14T22:05:00.000Z', elapsed_seconds: 300 }));

    expect(screen.getByText('PAUSED')).toBeInTheDocument();
    expect(screen.getByLabelText('Elapsed delivery time')).toHaveTextContent('5:00');
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(screen.getByLabelText('Elapsed delivery time')).toHaveTextContent('5:00');
    expect(screen.getByRole('button', { name: 'Resume session' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause session' })).not.toBeInTheDocument();
  });

  it('adopts the server\'s elapsed value after a mutation, not its own count', async () => {
    const { fetchMock } = await renderLive(liveRun({ elapsed_seconds: 125 }), {
      // The server says 200 seconds, whatever this tab believed.
      patch: () => jsonResponse({ run: liveRun({ is_paused: true, paused_at: 'x', elapsed_seconds: 200 }) }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause session' }));
    });

    expect(screen.getByLabelText('Elapsed delivery time')).toHaveTextContent('3:20');
    expect(patchCalls(fetchMock)).toEqual([{ action: 'pause' }]);
  });
});

describe('pause and resume', () => {
  it('pause sends exactly the pause action and shows the paused state the server returned', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: liveRun({ is_paused: true, paused_at: 'x', elapsed_seconds: 130 }) }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause session' }));
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'pause' }]);
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
  });

  it('a double-tap on pause sends one request', async () => {
    let release: (() => void) | undefined;
    const { fetchMock } = await renderLive(liveRun(), {
      patch: () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse({ run: liveRun({ is_paused: true, paused_at: 'x' }) }));
        }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pause session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause session' }));
    expect(patchCalls(fetchMock)).toHaveLength(1);

    await act(async () => {
      release?.();
    });
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
  });

  it('resume sends exactly the resume action and unfreezes into the running state', async () => {
    const { fetchMock } = await renderLive(
      liveRun({ is_paused: true, paused_at: 'x', elapsed_seconds: 300 }),
      { patch: () => jsonResponse({ run: liveRun({ elapsed_seconds: 300 }) }) },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume session' }));
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'resume' }]);
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
  });
});

describe('block movement always names the target block', () => {
  it('Next sends the following block\'s real id', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: liveRun({ current_block_id: 'blk-3' }) }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next block' }));
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'advance', to_block_id: 'blk-3' }]);
    const items = screen.getAllByRole('listitem');
    expect(items[2].textContent).toContain('Current');
  });

  it('Previous sends the preceding block\'s real id', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: liveRun({ current_block_id: 'blk-1' }) }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Previous block' }));
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'advance', to_block_id: 'blk-1' }]);
  });

  it('jumping straight to any listed block sends that block\'s id', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: liveRun({ current_block_id: 'blk-1' }) }),
    });

    // blk-1 and blk-3 are not current; the first Go button belongs to blk-1.
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Go to this block' })[0]);
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'advance', to_block_id: 'blk-1' }]);
  });

  it('the server\'s refusal of a block outside the script is shown and the cursor does not move', async () => {
    await renderLive(liveRun(), {
      patch: () => jsonResponse({ error: 'SESSION_RUN_BLOCK_NOT_IN_SCRIPT' }, false, 422),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next block' }));
    });

    expect(screen.getByRole('alert').textContent).toContain('not part of this session\'s script');
    expect(screen.getByRole('alert').textContent).toContain('SESSION_RUN_BLOCK_NOT_IN_SCRIPT');
    // The cursor stayed where the server left it.
    expect(screen.getAllByRole('listitem')[1].textContent).toContain('Current');
  });
});

describe('finishing a session', () => {
  it('End session opens a settle panel instead of settling -- a stray tap changes nothing', async () => {
    const { fetchMock } = await renderLive(liveRun());

    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));

    expect(screen.getByRole('button', { name: 'Record as completed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record as abandoned' })).toBeInTheDocument();
    expect(patchCalls(fetchMock)).toHaveLength(0);

    // Backing out is a real option.
    fireEvent.click(screen.getByRole('button', { name: 'Keep delivering' }));
    expect(screen.queryByRole('button', { name: 'Record as completed' })).not.toBeInTheDocument();
  });

  it('completed finish sends the existing summary fields exactly and hands over the settled run', async () => {
    const settledRow = { ...liveRun(), run_state: 'completed', ended_at: '2026-08-14T23:00:00.000Z' };
    const { fetchMock, onSettled } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: settledRow }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    fireEvent.change(screen.getByLabelText('Blocks completed'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Athletes present'), { target: { value: '9' } });
    fireEvent.click(screen.getByLabelText('Reset protocol was used'));
    fireEvent.change(screen.getByLabelText('Deviation from the plan'), { target: { value: 'Cut conditioning short.' } });
    fireEvent.change(screen.getByLabelText('What worked'), { target: { value: 'Slip line clicked.' } });
    fireEvent.change(screen.getByLabelText('What did not'), { target: { value: 'Room too loud for teaching minute.' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record as completed' }));
    });

    expect(patchCalls(fetchMock)).toEqual([
      {
        action: 'finish',
        run_state: 'completed',
        blocks_completed: 5,
        athletes_present: 9,
        reset_protocol_used: true,
        deviation_note: 'Cut conditioning short.',
        what_worked: 'Slip line clicked.',
        what_did_not: 'Room too loud for teaching minute.',
      },
    ]);
    expect(onSettled).toHaveBeenCalledWith(settledRow);
  });

  it('abandoned is its own named outcome, not a variant of completed', async () => {
    const settledRow = { ...liveRun(), run_state: 'abandoned', ended_at: '2026-08-14T22:30:00.000Z' };
    const { fetchMock, onSettled } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: settledRow }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record as abandoned' }));
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'finish', run_state: 'abandoned' }]);
    expect(onSettled).toHaveBeenCalledWith(settledRow);
  });

  it('empty optional fields are omitted, never sent as zeroes', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: { ...liveRun(), run_state: 'completed' } }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record as completed' }));
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'finish', run_state: 'completed' }]);
  });

  it('a non-numeric count is refused before any request', async () => {
    const { fetchMock } = await renderLive(liveRun());

    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    fireEvent.change(screen.getByLabelText('Blocks completed'), { target: { value: 'five' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record as completed' }));
    });

    expect(screen.getByRole('alert').textContent).toContain('whole number');
    expect(patchCalls(fetchMock)).toHaveLength(0);
  });
});

describe('a run that stops being live underneath the screen', () => {
  it('resyncs from the server and hands control back when nothing is live', async () => {
    const { onRunGone } = await renderLive(
      liveRun(),
      {
        patch: () => jsonResponse({ error: 'SESSION_RUN_NOT_LIVE' }, false, 409),
        runsGet: () => jsonResponse({ run: null }),
      },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause session' }));
    });

    expect(onRunGone).toHaveBeenCalledWith(expect.stringContaining('no longer live'));
  });

  it('reloads the live run the server reports instead of trusting the stale screen', async () => {
    const fresher = liveRun({ elapsed_seconds: 500, current_block_id: 'blk-3' });
    const { onRunGone } = await renderLive(
      liveRun(),
      {
        patch: () => jsonResponse({ error: 'SESSION_RUN_NOT_LIVE' }, false, 409),
        runsGet: () => jsonResponse({ run: fresher }),
      },
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause session' }));
    });

    expect(onRunGone).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Elapsed delivery time')).toHaveTextContent('8:20');
    expect(screen.getByRole('alert').textContent).toContain('out of date');
  });
});

describe('logging an intervention against this run', () => {
  it('sends the run\'s own id as session_run_id and shows the logged execution', async () => {
    const { fetchMock } = await renderLive(liveRun());

    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    fireEvent.change(await screen.findByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.change(screen.getByLabelText('Protocol (its intended exposure becomes the frozen plan)'), {
      target: { value: 'proto-1' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Log intervention' }));
    });

    expect(logPostCalls(fetchMock)).toEqual([
      { athlete_id: 'ath-1', protocol_id: 'proto-1', session_run_id: 'ssrun_1' },
    ]);
    expect(screen.getByText('Round-3 endurance block')).toBeInTheDocument();
    expect(screen.getByText('logged')).toBeInTheDocument();
  });

  it('refuses to submit before an athlete and a protocol are both picked, with no request sent', async () => {
    const { fetchMock } = await renderLive(liveRun());

    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Log intervention' }));
    });

    expect(screen.getByRole('alert').textContent).toContain('Pick an athlete and a protocol first.');
    expect(logPostCalls(fetchMock)).toHaveLength(0);
  });

  it('a protocol authored for a different athlete never appears once that athlete is picked', async () => {
    await renderLive(liveRun(), {
      protocols: () =>
        jsonResponse({
          items: [
            { protocol_id: 'proto-mine', title: 'For Jordan only', version: 1, athlete_id: 'ath-1', status: 'active' },
            { protocol_id: 'proto-other', title: 'For someone else', version: 1, athlete_id: 'ath-2', status: 'active' },
            { protocol_id: 'proto-shared', title: 'Org-wide protocol', version: 1, athlete_id: null, status: 'active' },
          ],
        }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    fireEvent.change(await screen.findByLabelText('Athlete'), { target: { value: 'ath-1' } });

    const protocolSelect = screen.getByLabelText('Protocol (its intended exposure becomes the frozen plan)');
    expect(within(protocolSelect).getByText('For Jordan only (v1)')).toBeInTheDocument();
    expect(within(protocolSelect).getByText('Org-wide protocol (v1)')).toBeInTheDocument();
    expect(within(protocolSelect).queryByText('For someone else (v1)')).not.toBeInTheDocument();
  });

  it('the server\'s refusal is shown and nothing is added to the logged list', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      logPost: () => jsonResponse({ error: 'Not found' }, false, 404),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    fireEvent.change(await screen.findByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.change(screen.getByLabelText('Protocol (its intended exposure becomes the frozen plan)'), {
      target: { value: 'proto-1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Log intervention' }));
    });

    expect(screen.getByRole('alert').textContent).toContain('Not found');
    expect(screen.queryByText('logged')).not.toBeInTheDocument();
    expect(logPostCalls(fetchMock)).toHaveLength(1);
  });

  it('a failed roster or protocol load disables logging instead of pretending the lists are empty', async () => {
    await renderLive(liveRun(), { athletes: () => jsonResponse({}, false, 500) });

    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    expect(await screen.findByText(/athlete roster could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log intervention' })).toBeDisabled();
  });
});

describe('readiness is not presence', () => {
  /* THE DEFECT THIS REPLACES.
   *
   * This screen carried an "On the floor" panel that listed every athlete
   * returned by /api/pilot/coach/readiness-board and called them "athletes
   * with a fresh check-in". The readiness board reads pilot.readiness, and
   * every row in that table was typed by a staff member during intake review
   * -- method 'staff_entered_intake' or 'UNKNOWN', and nothing else exists
   * (readinessProvenance.ts). Nobody arrived. Nobody checked in. Nothing was
   * observed.
   *
   * The test that used to stand here asserted the substitution was working:
   * it fed one board row and required that athlete to render as present. It
   * was green, and it was pinning the bug.
   *
   * THE MUTATION IS THE CASE ITSELF. A fresh staff-entered readiness row, with
   * no presence fact anywhere, must not put an athlete on the floor. Because
   * there is no authorized presence source for a coach today -- athlete
   * check-ins are self-only by contract, and attendance is the register --
   * the honest outcome is that the panel does not exist, so the assertion is
   * that nothing on this screen makes a presence claim at all.
   */
  const freshStaffEnteredReadiness = (id: string) => ({
    athlete_id: id,
    status: 'GREEN',
    score: 8,
    measured_at: new Date().toISOString(),
    // The provenance that proves this is a desk judgement, not an arrival.
    method: 'staff_entered_intake',
    reliability_status: '',
    validity_status: '',
    evidence_class: '',
  });

  it('a fresh staff-entered readiness row does not put an athlete on the floor', async () => {
    await renderLive(liveRun(), {
      roster: () => jsonResponse({
        items: [{
          athlete_id: 'ath-1',
          account_id: null,
          full_name: 'Jordan Packer',
          initials: 'JP',
          ring_name: null,
          photo_available: false,
        }],
      }),
      readinessBoard: () => jsonResponse({ items: [freshStaffEnteredReadiness('ath-1')] }),
    });

    expect(screen.queryByRole('region', { name: 'On the floor' })).not.toBeInTheDocument();
    expect(screen.queryByText(/on the floor/i)).not.toBeInTheDocument();
    // And no weaker phrasing of the same claim survived the removal.
    expect(screen.queryByText(/fresh check-in/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/checked in/i)).not.toBeInTheDocument();
  });

  it('does not read the readiness board at all', async () => {
    // Repointing the panel at a different query would satisfy the assertions
    // above while keeping a triage feed on a delivery screen. The request
    // itself is what must be gone.
    const { fetchMock } = await renderLive(liveRun(), {
      readinessBoard: () => jsonResponse({ items: [freshStaffEnteredReadiness('ath-1')] }),
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/api/pilot/coach/readiness-board'))).toBe(false);
  });

  it('does not reach for athlete check-ins instead', async () => {
    // app/api/pilot/athlete/check-in/route.ts is SELF ONLY and says so:
    // "coach/admin views of arrivals are a later, separate read surface".
    // Swapping one unauthorized presence proxy for another is the failure
    // mode this case exists to catch.
    const { fetchMock } = await renderLive(liveRun());

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('check-in'))).toBe(false);
  });

  it('the session controls are unaffected by the removal', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: liveRun({ is_paused: true, paused_at: 'x' }) }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause session' }));
    });
    expect(patchCalls(fetchMock)).toEqual([{ action: 'pause' }]);
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
  });
});
