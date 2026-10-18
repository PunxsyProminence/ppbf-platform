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
    show_on_wall: false,
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
  /** GET of the intervention ledger for one athlete (the before picture and the recovery read). */
  logGet?: () => Response | Promise<Response>;
  /** GET /runs?finished=true: the gym's finished sessions (the recovery read after a finish). */
  finishedGet?: () => Response | Promise<Response>;
  roster?: () => Response | Promise<Response>;
  readinessBoard?: () => Response | Promise<Response>;
  /** GET /runs/[runId]/athletes: who is marked here, and the gym's athletes (F-067). */
  presence?: () => Response | Promise<Response>;
  /** GET /api/pilot/drill-library?drill_id=: the drill a block links (audit 2026-10-17 item 1). */
  drill?: (url: string) => Response | Promise<Response>;
}

const DEFAULT_LOG_ATHLETES = [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }];
const DEFAULT_LOG_PROTOCOLS = [
  { protocol_id: 'proto-1', title: 'Round-3 endurance block', version: 1, athlete_id: null, status: 'active' },
];

function mockFetch(handlers: Handlers = {}) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/coach/intervention-executions')) {
      if (init?.method !== 'POST') return handlers.logGet ? handlers.logGet() : jsonResponse({ items: [] });
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
    // The round timer (WO-N1-03) has its own route and its own suite (roundTimerControls.test.tsx);
    // here it simply has no rounds set.
    if (url.endsWith('/timer')) {
      return jsonResponse({ timer: null });
    }
    // Who is here (F-067) has its own route and its own suite (sessionRunPresence.test.tsx); here
    // the default is a healthy read of a gym where nobody is marked yet.
    if (url.endsWith('/athletes')) {
      return handlers.presence ? handlers.presence() : jsonResponse({ present: [], gym: [] });
    }
    if (url.includes('/api/pilot/session-scripts/runs/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (handlers.patch) return handlers.patch(body);
      throw new Error(`Unexpected PATCH: ${url}`);
    }
    if (url.includes('/api/pilot/session-scripts/runs?finished=true')) {
      if (handlers.finishedGet) return handlers.finishedGet();
      throw new Error(`Unexpected finished GET: ${url}`);
    }
    if (url.includes('/api/pilot/session-scripts/runs')) {
      if (handlers.runsGet) return handlers.runsGet();
      throw new Error(`Unexpected runs GET: ${url}`);
    }
    if (url.includes('/api/pilot/drill-library')) {
      return handlers.drill ? handlers.drill(url) : jsonResponse({ error: 'DRILL_NOT_FOUND' }, false, 404);
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
    .filter((call) => String(call[0]).includes('/api/pilot/session-scripts/runs/') && !String(call[0]).endsWith('/timer') && !String(call[0]).endsWith('/athletes'))
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
  it("labels the current block's template facts as the template's, in words (F-078)", async () => {
    await renderLive(liveRun(), {
      detail: () => jsonResponse({
        script: scriptDetail({
          blocks: [
            block('blk-1', 1, 'Arrival and wraps'),
            block('blk-2', 2, 'Jab drill', { what_to_say: null, what_to_explain: 'From the template: Warm-up, 3 reps', what_to_watch: null, what_to_fix: null }),
          ],
        }),
      }),
    });

    expect((await screen.findAllByText('Warm-up, 3 reps')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/From the template/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Explain/)).not.toBeInTheDocument();
  });

  it('shows the script name, server elapsed time, running state, and the current block distinctly', async () => {
    await renderLive(liveRun());

    expect(screen.getByText('Friday sparring')).toBeInTheDocument();
    // 125 seconds from the SERVER, formatted -- not computed from started_at.
    expect(screen.getByLabelText('Elapsed delivery time')).toHaveTextContent('2:05');
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(screen.getByText(/the plan as it was when the session started \(version 3\)/)).toBeInTheDocument();

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

    // Presentation only: the tick produced zero requests. (The round timer and who-is-here each
    // read once when the screen opens, by GET; neither is the clock.)
    expect(patchCalls(fetchMock)).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/runs') && !String(call[0]).endsWith('/timer') && !String(call[0]).endsWith('/athletes')),
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

describe('the Show on TV switch', () => {
  it('a new run is off the TV, and Show on TV sends show: true and adopts the server answer', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: liveRun({ show_on_wall: true }) }),
    });
    expect(screen.getByText('NOT ON THE TV')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show on TV' }));
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'show_on_wall', show: true }]);
    expect(screen.getByText('ON THE TV')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take off the TV' })).toBeInTheDocument();
  });

  it('Take off the TV sends show: false -- an explicit value, never a toggle', async () => {
    const { fetchMock } = await renderLive(liveRun({ show_on_wall: true }), {
      patch: () => jsonResponse({ run: liveRun({ show_on_wall: false }) }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Take off the TV' }));
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'show_on_wall', show: false }]);
    expect(screen.getByText('NOT ON THE TV')).toBeInTheDocument();
  });

  it('the badge is the server answer even on success: asked for true, told false, stays NOT ON THE TV', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: liveRun({ show_on_wall: false }) }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show on TV' }));
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'show_on_wall', show: true }]);
    expect(screen.getByText('NOT ON THE TV')).toBeInTheDocument();
    expect(screen.queryByText('ON THE TV')).toBeNull();
  });

  it('a refused switch leaves the shown state as it was and says why', async () => {
    await renderLive(liveRun(), {
      patch: () => jsonResponse({ error: 'SOMETHING_ELSE' }, false, 422),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show on TV' }));
    });

    expect(screen.getByText('NOT ON THE TV')).toBeInTheDocument();
    // Words, never the stored code (UXB-09).
    expect(screen.getByRole('alert')).toHaveTextContent('That did not go through. Nothing was changed. Try again.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('SOMETHING_ELSE');
  });

  // F-060: the TV has shown sessions since Release 21. The switch alone puts
  // nothing on it; the coach sends the run from Gym TVs on coach home.
  it('says how the session reaches a TV, not that TVs cannot show it', async () => {
    await renderLive(liveRun());
    expect(screen.getByText('Switching this on lets you send the session to a gym TV from Gym TVs on your coach home.')).toBeInTheDocument();
    expect(screen.queryByText(/does not show sessions yet/)).toBeNull();
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

    expect(screen.getByRole('alert').textContent).toBe("That block is not part of this session's plan, so the session stayed where it was.");
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

  it('the athletes present box starts from the athletes marked here, and the coach\'s own number is what is sent', async () => {
    const marked = {
      present: [
        { athlete_id: 'ath-1', full_name: 'Ada Reyes', marked_at: '2026-08-14T22:05:00.000Z' },
        { athlete_id: 'ath-2', full_name: 'Ben Ortiz', marked_at: '2026-08-14T22:06:00.000Z' },
      ],
      gym: [
        { athlete_id: 'ath-1', full_name: 'Ada Reyes' },
        { athlete_id: 'ath-2', full_name: 'Ben Ortiz' },
        { athlete_id: 'ath-3', full_name: 'Cy Marsh' },
      ],
    };
    const settledRow = { ...liveRun(), run_state: 'completed', ended_at: '2026-08-14T23:00:00.000Z' };
    const { fetchMock } = await renderLive(liveRun(), {
      presence: () => jsonResponse(marked),
      patch: () => jsonResponse({ run: settledRow }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    expect(screen.getByLabelText('Athletes present')).toHaveValue('2');
    expect(screen.getByText('Filled in from the athletes marked here. Change it if your count is different.')).toBeInTheDocument();

    // The coach counted a late arrival nobody marked: their number wins and is what is saved.
    fireEvent.change(screen.getByLabelText('Athletes present'), { target: { value: '3' } });
    expect(screen.queryByText('Filled in from the athletes marked here. Change it if your count is different.')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record as completed' }));
    });
    expect(patchCalls(fetchMock)).toEqual([{ action: 'finish', run_state: 'completed', athletes_present: 3 }]);
  });

  it('a number the coach typed stays when more athletes are marked afterwards (ruling G)', async () => {
    const settledRow = { ...liveRun(), run_state: 'completed', ended_at: '2026-08-14T23:00:00.000Z' };
    const { fetchMock } = await renderLive(liveRun(), {
      presence: () => jsonResponse({
        present: [{ athlete_id: 'ath-1', full_name: 'Ada Reyes', marked_at: '2026-08-14T22:05:00.000Z' }],
        gym: [{ athlete_id: 'ath-1', full_name: 'Ada Reyes' }, { athlete_id: 'ath-3', full_name: 'Cy Marsh' }],
      }),
      patch: () => jsonResponse({ run: settledRow }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    expect(screen.getByLabelText('Athletes present')).toHaveValue('1');
    fireEvent.change(screen.getByLabelText('Athletes present'), { target: { value: '5' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark here Cy Marsh' }));
    });
    expect(screen.getByText('2 marked here.')).toBeInTheDocument();
    expect(screen.getByLabelText('Athletes present')).toHaveValue('5');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record as completed' }));
    });
    expect(patchCalls(fetchMock)).toEqual([{ action: 'finish', run_state: 'completed', athletes_present: 5 }]);
  });

  it('a count stated when the session started is kept; the marks do not replace it', async () => {
    await renderLive(liveRun({ athletes_present: 11 }), {
      presence: () => jsonResponse({
        present: [{ athlete_id: 'ath-1', full_name: 'Ada Reyes', marked_at: '2026-08-14T22:05:00.000Z' }],
        gym: [{ athlete_id: 'ath-1', full_name: 'Ada Reyes' }],
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    expect(screen.getByLabelText('Athletes present')).toHaveValue('11');
    expect(screen.queryByText('Filled in from the athletes marked here. Change it if your count is different.')).not.toBeInTheDocument();
  });

  it('with nobody marked the box stays empty, so no empty room is recorded that nobody counted', async () => {
    const settledRow = { ...liveRun(), run_state: 'completed', ended_at: '2026-08-14T23:00:00.000Z' };
    const { fetchMock } = await renderLive(liveRun(), {
      presence: () => jsonResponse({ present: [], gym: [{ athlete_id: 'ath-1', full_name: 'Ada Reyes' }] }),
      patch: () => jsonResponse({ run: settledRow }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    expect(screen.getByLabelText('Athletes present')).toHaveValue('');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record as completed' }));
    });
    expect(patchCalls(fetchMock)).toEqual([{ action: 'finish', run_state: 'completed' }]);
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
    fireEvent.change(screen.getByLabelText('Protocol'), {
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

    const protocolSelect = screen.getByLabelText('Protocol');
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
    fireEvent.change(screen.getByLabelText('Protocol'), {
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

    // The requirement stated directly: athlete A is not on this screen. The
    // region and phrasing assertions below are the supporting cast -- this is
    // the one that fails if a future panel renders the same substitution under
    // any other heading.
    expect(screen.queryByText('Jordan Packer')).not.toBeInTheDocument();

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

describe('the round timer (WO-N1-03)', () => {
  it("the live screen carries the run's round timer, read from its own route with a GET only", async () => {
    const { fetchMock } = await renderLive(liveRun());
    const section = await screen.findByRole('region', { name: 'Round timer' });
    expect(within(section).getByText('No rounds set for this session.')).toBeInTheDocument();
    const timerCalls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/runs/ssrun_1/timer'));
    expect(timerCalls.length).toBeGreaterThan(0);
    for (const call of timerCalls) {
      expect((call[1] as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
    }
    // A timer read is never a session action.
    expect(patchCalls(fetchMock)).toEqual([]);
  });
});

// Issue #1523 (Jason 2026-10-12, "allow a plain session"): a session with no plan.
describe('a plain session', () => {
  const plainRun = () => liveRun({ script_id: null, script_version: null, current_block_id: null });

  test('is named plainly, reads no plan, and offers no blocks to move between', async () => {
    const { fetchMock } = await renderLive(plainRun());

    expect(screen.getByRole('heading', { name: 'Plain session' })).toBeTruthy();
    expect(screen.queryByText(/Pinned at version/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous block' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next block' })).toBeNull();
    expect(screen.queryByText(/Loading the plan/)).toBeNull();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('script_id='))).toBe(false);
  });

  test('pauses, goes on the TV, and keeps the clock like any session', async () => {
    const { fetchMock } = await renderLive(plainRun(), {
      patch: (body) => jsonResponse({
        run: {
          ...plainRun(),
          is_paused: body.action === 'pause',
          show_on_wall: body.action === 'show_on_wall' ? body.show === true : false,
        },
      }),
    });

    expect(screen.getByLabelText('Elapsed delivery time').textContent).toBe('2:05');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause session' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show on TV' }));
    });

    expect(patchCalls(fetchMock)).toEqual([
      { action: 'pause' },
      { action: 'show_on_wall', show: true },
    ]);
  });
});

test('a plain session is not asked how many blocks it completed', async () => {
  await renderLive(liveRun({ script_id: null, script_version: null, current_block_id: null }));
  fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
  expect(screen.queryByLabelText('Blocks completed')).toBeNull();
  expect(screen.getByLabelText('Athletes present')).toBeTruthy();
});

// ChatGPT pilot audit 2026-10-17, item 1. A lost answer does not prove a write failed: the server
// may already have committed it. Every write here now says one of three things -- refused (4xx,
// in words), saved, or not saved -- and says "saved" or "not saved" only after reading what the
// server holds. Never "nothing was changed" on a guess, and never an invitation to repeat a write
// that already landed.
describe('a write whose answer proves nothing is checked against the server (audit 2026-10-17 item 1)', () => {
  const dropped = () => Promise.reject(new TypeError('Failed to fetch'));
  const runsGetCalls = (fetchMock: jest.Mock) =>
    fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/api/pilot/session-scripts/runs'));
  const NOT_SAVED = 'No clear answer came back, and the server shows it was not saved. Try again.';
  const UNCHECKED = 'No clear answer came back and the server could not be checked. Reload the page before trying again.';

  const runActions = [
    { action: 'pause', start: liveRun(), button: 'Pause session', saved: liveRun({ is_paused: true, paused_at: 'x' }), words: 'the session is paused', badge: 'PAUSED' },
    { action: 'resume', start: liveRun({ is_paused: true, paused_at: 'x' }), button: 'Resume session', saved: liveRun(), words: 'the session is running', badge: 'RUNNING' },
    { action: 'advance', start: liveRun(), button: 'Next block', saved: liveRun({ current_block_id: 'blk-3' }), words: 'the session is on Conditioning finish', badge: null },
    { action: 'show_on_wall', start: liveRun(), button: 'Show on TV', saved: liveRun({ show_on_wall: true }), words: 'the session is on the TV', badge: 'ON THE TV' },
  ] as const;

  async function press(name: string) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
    });
  }

  describe.each(runActions)('$action', ({ start, button, saved, words, badge }) => {
    it('(a) the request never reached the server: the server shows it was not saved, so try again', async () => {
      const { fetchMock } = await renderLive(start, { patch: dropped, runsGet: () => jsonResponse({ run: start }) });
      await press(button);
      expect(await screen.findByRole('alert')).toHaveTextContent(NOT_SAVED);
      expect(screen.queryByText(/nothing was changed/i)).toBeNull();
      expect(runsGetCalls(fetchMock)).toHaveLength(1);
    });

    it('(b) the server committed and the answer was lost: the screen says saved, shows it, and offers no repeat', async () => {
      await renderLive(start, { patch: dropped, runsGet: () => jsonResponse({ run: saved }) });
      await press(button);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(`No clear answer came back, but the server shows it was saved: ${words}.`);
      expect(alert).not.toHaveTextContent(/try again/i);
      if (badge) expect(screen.getByText(badge)).toBeInTheDocument();
    });

    it('(c) a yes with no run in it is checked, not trusted or ignored', async () => {
      await renderLive(start, { patch: () => jsonResponse({}), runsGet: () => jsonResponse({ run: saved }) });
      await press(button);
      expect(await screen.findByRole('alert')).toHaveTextContent(`the server shows it was saved: ${words}.`);
    });

    it('(d) a refusal is shown in words and needs no check', async () => {
      const { fetchMock } = await renderLive(start, { patch: () => jsonResponse({ error: 'SOME_CODE' }, false, 422) });
      await press(button);
      expect(screen.getByRole('alert')).toHaveTextContent('That did not go through. Nothing was changed. Try again.');
      expect(runsGetCalls(fetchMock)).toHaveLength(0);
    });

    it('a server failure (5xx) is checked: it may have written before failing', async () => {
      await renderLive(start, {
        patch: () => jsonResponse({ error: 'Internal server error' }, false, 500),
        runsGet: () => jsonResponse({ run: saved }),
      });
      await press(button);
      expect(await screen.findByRole('alert')).toHaveTextContent(`the server shows it was saved: ${words}.`);
    });

    it('when the check itself fails, the screen says it does not know', async () => {
      await renderLive(start, { patch: dropped, runsGet: () => jsonResponse({}, false, 500) });
      await press(button);
      expect(await screen.findByRole('alert')).toHaveTextContent(UNCHECKED);
    });
  });

  describe('finish', () => {
    const settledSummary = { run_id: 'ssrun_1', script_id: 'scr-friday', run_state: 'completed', delivered_by_me: true };

    async function finish() {
      fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
      await press('Record as completed');
    }

    it('(a) the request never reached the server: the session is still live, so try again', async () => {
      const { onSettled } = await renderLive(liveRun(), { patch: dropped, runsGet: () => jsonResponse({ run: liveRun() }) });
      await finish();
      expect(await screen.findByRole('alert')).toHaveTextContent(NOT_SAVED);
      expect(onSettled).not.toHaveBeenCalled();
    });

    it('(b) the server finished it and the answer was lost: it is handed over as settled, with the outcome the server holds', async () => {
      const { onSettled, onRunGone } = await renderLive(liveRun(), {
        patch: dropped,
        runsGet: () => jsonResponse({ run: null }),
        finishedGet: () => jsonResponse({ runs: [settledSummary] }),
      });
      await finish();
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ run_id: 'ssrun_1', run_state: 'completed' }));
      expect(onRunGone).not.toHaveBeenCalled();
    });

    it('(c) a yes with no run in it is checked the same way', async () => {
      const { onSettled } = await renderLive(liveRun(), {
        patch: () => jsonResponse({}),
        runsGet: () => jsonResponse({ run: null }),
        finishedGet: () => jsonResponse({ runs: [{ ...settledSummary, run_state: 'abandoned' }] }),
      });
      await finish();
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ run_id: 'ssrun_1', run_state: 'abandoned' }));
    });

    it('(d) a refusal is shown in words and needs no check', async () => {
      const { fetchMock, onSettled } = await renderLive(liveRun(), { patch: () => jsonResponse({ error: 'SOME_CODE' }, false, 422) });
      await finish();
      expect(screen.getByRole('alert')).toHaveTextContent('That did not go through. Nothing was changed. Try again.');
      expect(runsGetCalls(fetchMock)).toHaveLength(0);
      expect(onSettled).not.toHaveBeenCalled();
    });

    it('not live and not found among the finished sessions: the screen says it does not know', async () => {
      const { onSettled } = await renderLive(liveRun(), {
        patch: dropped,
        runsGet: () => jsonResponse({ run: null }),
        finishedGet: () => jsonResponse({}, false, 500),
      });
      await finish();
      expect(await screen.findByRole('alert')).toHaveTextContent(UNCHECKED);
      expect(onSettled).not.toHaveBeenCalled();
    });
  });

  describe('logging an intervention', () => {
    const execution = (id: string) => ({
      execution_id: id,
      created_at: '2026-08-17T00:00:00.000Z',
      session_run_id: 'ssrun_1',
      protocol_id: 'proto-1',
      athlete_id: 'ath-1',
    });

    async function pickAndLog() {
      fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
      fireEvent.change(await screen.findByLabelText('Athlete'), { target: { value: 'ath-1' } });
      fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'proto-1' } });
      await press('Log intervention');
    }

    it('(a) the request never reached the server: the ledger shows nothing new, so try again', async () => {
      await renderLive(liveRun(), { logPost: dropped, logGet: () => jsonResponse({ items: [] }) });
      await pickAndLog();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'No clear answer came back, and the server shows the intervention was not logged. Try again.',
      );
      expect(screen.queryByText('logged')).toBeNull();
    });

    it('(b) the server logged it and the answer was lost: it is listed once and no repeat is offered', async () => {
      let committed = false;
      const { fetchMock } = await renderLive(liveRun(), {
        logPost: () => {
          committed = true;
          return dropped();
        },
        logGet: () => jsonResponse({ items: committed ? [execution('exec-new')] : [] }),
      });
      await pickAndLog();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('No clear answer came back, but the server shows the intervention was logged.');
      expect(alert).not.toHaveTextContent(/try again/i);
      expect(screen.getAllByText('logged')).toHaveLength(1);
      expect(logPostCalls(fetchMock)).toHaveLength(1);
    });

    it('an earlier log of the same pair in this run is not mistaken for this one', async () => {
      // exec-old was logged before a reload, so this screen's own list does not hold it.
      await renderLive(liveRun(), { logPost: dropped, logGet: () => jsonResponse({ items: [execution('exec-old')] }) });
      await pickAndLog();
      expect(await screen.findByRole('alert')).toHaveTextContent('the server shows the intervention was not logged. Try again.');
      expect(screen.queryByText('logged')).toBeNull();
    });

    it('(c) a yes with no execution in it is checked, not read as a refusal', async () => {
      let committed = false;
      await renderLive(liveRun(), {
        logPost: () => {
          committed = true;
          return jsonResponse({});
        },
        logGet: () => jsonResponse({ items: committed ? [execution('exec-new')] : [] }),
      });
      await pickAndLog();
      expect(await screen.findByRole('alert')).toHaveTextContent('the server shows the intervention was logged.');
      expect(screen.getAllByText('logged')).toHaveLength(1);
    });

    it('(d) a refusal is shown in words and needs no check after it', async () => {
      const { fetchMock } = await renderLive(liveRun(), { logPost: () => jsonResponse({ error: 'Not found' }, false, 404) });
      await pickAndLog();
      expect(screen.getByRole('alert')).toHaveTextContent('Not found');
      const ledgerReads = fetchMock.mock.calls.filter(
        (call) => String(call[0]).includes('/intervention-executions') && (call[1] as RequestInit | undefined)?.method !== 'POST',
      );
      // The before picture only.
      expect(ledgerReads).toHaveLength(1);
    });

    it('a server failure (5xx) is checked: it may have written before failing', async () => {
      let committed = false;
      await renderLive(liveRun(), {
        logPost: () => {
          committed = true;
          return jsonResponse({ error: 'Internal server error' }, false, 500);
        },
        logGet: () => jsonResponse({ items: committed ? [execution('exec-new')] : [] }),
      });
      await pickAndLog();
      expect(await screen.findByRole('alert')).toHaveTextContent('the server shows the intervention was logged.');
    });

    it('when the check fails, the screen says it does not know and where to look', async () => {
      let posted = false;
      await renderLive(liveRun(), {
        logPost: () => {
          posted = true;
          return dropped();
        },
        logGet: () => (posted ? jsonResponse({}, false, 500) : jsonResponse({ items: [] })),
      });
      await pickAndLog();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'No clear answer came back and the server could not be checked. Check The Work before logging it again.',
      );
    });

    it('a failed before picture never stops the log, and a record it cannot place is not called saved', async () => {
      let posted = false;
      const { fetchMock } = await renderLive(liveRun(), {
        logPost: () => {
          posted = true;
          return dropped();
        },
        logGet: () => (posted ? jsonResponse({ items: [execution('exec-unplaced')] }) : jsonResponse({}, false, 500)),
      });
      await pickAndLog();
      expect(logPostCalls(fetchMock)).toHaveLength(1);
      expect(await screen.findByRole('alert')).toHaveTextContent('Check The Work before logging it again.');
      expect(screen.queryByText('logged')).toBeNull();
    });
  });
});

describe('the check after a lost answer keeps the once-only locks and covers every branch (audit 2026-10-17 item 1)', () => {
  const dropped = () => Promise.reject(new TypeError('Failed to fetch'));

  it('a run action stays locked while the server is being checked: a second tap sends nothing', async () => {
    let release: ((response: Response) => void) | undefined;
    const { fetchMock } = await renderLive(liveRun(), {
      patch: dropped,
      runsGet: () => new Promise<Response>((resolve) => { release = resolve; }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause session' }));
    });
    expect(release).toBeDefined();
    expect(screen.getByRole('button', { name: 'Pause session' })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause session' }));
    });
    expect(patchCalls(fetchMock)).toHaveLength(1);

    await act(async () => {
      release?.(jsonResponse({ run: liveRun({ is_paused: true, paused_at: 'x' }) }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('the server shows it was saved: the session is paused.');
    expect(patchCalls(fetchMock)).toHaveLength(1);
  });

  it('logging stays locked while the server is being checked: a second tap sends nothing', async () => {
    let release: ((response: Response) => void) | undefined;
    let ledgerReads = 0;
    const { fetchMock } = await renderLive(liveRun(), {
      logPost: dropped,
      logGet: () => {
        ledgerReads += 1;
        if (ledgerReads === 1) return jsonResponse({ items: [] });
        return new Promise<Response>((resolve) => { release = resolve; });
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    fireEvent.change(await screen.findByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'proto-1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Log intervention' }));
    });
    expect(release).toBeDefined();
    expect(screen.getByRole('button', { name: 'Logging...' })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Logging...' }));
    });
    expect(logPostCalls(fetchMock)).toHaveLength(1);

    await act(async () => {
      release?.(jsonResponse({ items: [] }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('the server shows the intervention was not logged. Try again.');
    expect(logPostCalls(fetchMock)).toHaveLength(1);
  });

  it('a run action whose session is no longer live hands control back', async () => {
    const { onRunGone } = await renderLive(liveRun(), { patch: dropped, runsGet: () => jsonResponse({ run: null }) });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show on TV' }));
    });
    expect(onRunGone).toHaveBeenCalledWith(expect.stringContaining('no longer live'));
  });

  it('a run action whose session was replaced shows the live one and says the screen was out of date', async () => {
    const other = liveRun({ run_id: 'ssrun_2', elapsed_seconds: 500 });
    const { onRunGone } = await renderLive(liveRun(), { patch: dropped, runsGet: () => jsonResponse({ run: other }) });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause session' }));
    });
    expect(onRunGone).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('out of date');
    expect(screen.getByLabelText('Elapsed delivery time')).toHaveTextContent('8:20');
  });

  it('a finish whose live-session check fails says it could not be checked', async () => {
    const { onSettled } = await renderLive(liveRun(), { patch: dropped, runsGet: () => jsonResponse({}, false, 503) });
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record as completed' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No clear answer came back and the server could not be checked. Reload the page before trying again.',
    );
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('a finish not live and not among the finished sessions says the server does not show how it ended', async () => {
    const { onSettled } = await renderLive(liveRun(), {
      patch: dropped,
      runsGet: () => jsonResponse({ run: null }),
      finishedGet: () => jsonResponse({ runs: [{ run_id: 'ssrun_other', script_id: null, run_state: 'completed' }] }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Record as completed' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No clear answer came back, and the server does not show how this session ended. Reload the page before trying again.',
    );
    expect(onSettled).not.toHaveBeenCalled();
  });
});

// AUDIT 2026-10-17 ITEM 1. A plan made from a template carries a step's name,
// minutes, scale and note, not the drill's instructions. The coach opens the
// drill the current block links, from the drill library's own read, and comes
// back to the block with the session still running.
describe("the current block's drill instructions", () => {
  const LINKED = scriptDetail({
    blocks: [
      block('blk-1', 1, 'Arrival and wraps'),
      block('blk-2', 2, 'Jab drill', { drill_id: 'ref-jab-v1', scale_level: 'C' }),
      block('blk-3', 3, 'Conditioning finish'),
    ],
  });

  function referenceDrill() {
    return {
      drill_id: 'ref-jab-v1',
      name: 'Jab drill',
      discipline: 'boxing',
      category: 'technical',
      difficulty: 'beginner',
      version: 1,
      active: true,
      superseded_at: null,
      purpose: 'A straight jab from guard.',
      standard_setup: 'Partners at jab distance, one with pads.',
      execution: 'Step and jab on the call, then return to guard.',
      what_good_looks_like: 'The hand comes straight back to the chin.',
      what_bad_looks_like: '',
      common_errors: '',
      corrections: 'Elbow in before the next one.',
      contact_level: 'none',
      requires_coach_authorization: false,
      cues: [{ cue_text: 'Snap it back', cue_family: 'guard' }],
      scale_levels: [
        { scale_level: 'A', is_starting_point: false, demand_description: 'Shadow only.' },
        { scale_level: 'B', is_starting_point: true, demand_description: 'On pads at half speed.' },
        { scale_level: 'C', is_starting_point: false, demand_description: 'On pads at full speed.' },
      ],
      stop_rules: [],
      universal_stop_rules: [],
      secondary_skills: [],
      grounding_claim_ids: [],
    };
  }

  it('opens the linked drill in place: setup, how it runs, cues, corrections and the scale the block chose, with nothing sent', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      detail: () => jsonResponse({ script: LINKED }),
      drill: () => jsonResponse({ drill: referenceDrill() }),
    });

    const sentBefore = fetchMock.mock.calls.length;
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'View instructions: Jab drill' }));
    });

    // Every request opening the drill sent is a read, to any route.
    expect(fetchMock.mock.calls.slice(sentBefore).map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET'))
      .toEqual(['GET']);
    // The version the block links, by the drill library's own read.
    expect(fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('drill-library')))
      .toEqual(['/api/pilot/drill-library?drill_id=ref-jab-v1']);
    const drill = await screen.findByRole('article', { name: 'Jab drill' });
    expect(within(drill).getByText('Partners at jab distance, one with pads.')).toBeInTheDocument();
    expect(within(drill).getByText('Step and jab on the call, then return to guard.')).toBeInTheDocument();
    expect(within(drill).getByText('Snap it back')).toBeInTheDocument();
    expect(within(drill).getByText('Elbow in before the next one.')).toBeInTheDocument();
    // The block's scale is open and named; the drill's usual starting level is not opened instead.
    const chosen = within(drill).getByText(/chosen for this block/).closest('details');
    expect(chosen).toHaveAttribute('open');
    expect(within(chosen as HTMLElement).getByText('On pads at full speed.')).toBeInTheDocument();
    expect(within(drill).getByText(/where to start/).closest('details')).not.toHaveAttribute('open');
    // Reading is not a write: the session is where it was.
    expect(patchCalls(fetchMock)).toEqual([]);
    expect(screen.getByRole('button', { name: 'Hide instructions: Jab drill' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Next block' })).toBeInTheDocument();
  });

  it('closes back to the block, and the running session is untouched', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      detail: () => jsonResponse({ script: LINKED }),
      drill: () => jsonResponse({ drill: referenceDrill() }),
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'View instructions: Jab drill' }));
    });
    await screen.findByRole('article', { name: 'Jab drill' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide instructions: Jab drill' }));
    });

    expect(screen.queryByRole('article', { name: 'Jab drill' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View instructions: Jab drill' })).toHaveAttribute('aria-expanded', 'false');
    expect(patchCalls(fetchMock)).toEqual([]);
  });

  it('a block with no linked drill offers no instructions', async () => {
    await renderLive(liveRun({ current_block_id: 'blk-1' }), { detail: () => jsonResponse({ script: LINKED }) });

    expect(await screen.findByText('Current block')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View instructions/ })).not.toBeInTheDocument();
  });

  it('when the session moves on, the drill opened from the last block is no longer shown', async () => {
    await renderLive(liveRun(), {
      detail: () => jsonResponse({ script: LINKED }),
      drill: () => jsonResponse({ drill: referenceDrill() }),
      patch: () => jsonResponse({ run: liveRun({ current_block_id: 'blk-3' }) }),
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'View instructions: Jab drill' }));
    });
    await screen.findByRole('article', { name: 'Jab drill' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next block' }));
    });

    expect(screen.queryByRole('article', { name: 'Jab drill' })).not.toBeInTheDocument();
  });

  it('back on that block, the drill is closed until the coach opens it again', async () => {
    const moves = [liveRun({ current_block_id: 'blk-3' }), liveRun({ current_block_id: 'blk-2' })];
    await renderLive(liveRun(), {
      detail: () => jsonResponse({ script: LINKED }),
      drill: () => jsonResponse({ drill: referenceDrill() }),
      patch: () => jsonResponse({ run: moves.shift() }),
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'View instructions: Jab drill' }));
    });
    await screen.findByRole('article', { name: 'Jab drill' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next block' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Previous block' }));
    });

    expect(screen.queryByRole('article', { name: 'Jab drill' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View instructions: Jab drill' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('a block whose chosen scale the drill has no level for opens the starting level as usual', async () => {
    await renderLive(liveRun(), {
      detail: () => jsonResponse({ script: scriptDetail({ blocks: [block('blk-2', 2, 'Jab drill', { drill_id: 'ref-jab-v1', scale_level: 'C' })] }) }),
      drill: () => jsonResponse({ drill: { ...referenceDrill(), scale_levels: referenceDrill().scale_levels.slice(0, 2) } }),
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'View instructions: Jab drill' }));
    });

    const drill = await screen.findByRole('article', { name: 'Jab drill' });
    expect(within(drill).getByText(/where to start/).closest('details')).toHaveAttribute('open');
    expect(within(drill).queryByText(/chosen for this block/)).not.toBeInTheDocument();
  });

  it('a drill the library cannot open says so, not that it is missing', async () => {
    await renderLive(liveRun(), {
      detail: () => jsonResponse({ script: LINKED }),
      drill: () => jsonResponse({ error: 'boom' }, false, 500),
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'View instructions: Jab drill' }));
    });

    expect(await screen.findByText(/This is a failure to load, not a missing drill/)).toBeInTheDocument();
  });
});
