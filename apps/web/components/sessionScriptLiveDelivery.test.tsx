/**
 * @jest-environment jsdom
 */

import type { ReactElement } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import SessionScriptLiveDelivery, { RUN_GONE } from './SessionScriptLiveDelivery';
import SaveQueueNotice, { FAILED_WORDS, UNKNOWN_WORDS, WAITING_WORDS } from './SaveQueueNotice';
import { unknownOffPage } from './SessionRunClass';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';
import { RESEND_MS, resetSaveQueueForTests } from '@/src/lib/saveQueue';
import type { LiveSessionScriptRun } from '@/src/server/pilot/sessionScriptRuns';
import { REQUIRES_FLOOR_VALIDATION_PROVENANCE } from '@/src/lib/drillFloorValidation';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  const response = { ok, status, json: async () => body, clone: () => response };
  return response as unknown as Response;
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
    class_id: null,
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
  /** GET /api/pilot/gym-tvs: the TVs the status line reads (lane U2-6a). */
  tvs?: () => Response | Promise<Response>;
  /** POST /api/pilot/auth/session: who is signed in, for the kept-save queue (W4 item 7). Unset, it fails, so saves go today's way. */
  session?: () => Response | Promise<Response>;
}

const DEFAULT_LOG_ATHLETES = [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }];
const DEFAULT_LOG_PROTOCOLS = [
  { protocol_id: 'proto-1', title: 'Round-3 endurance block', version: 1, athlete_id: null, status: 'active' },
];

function mockFetch(handlers: Handlers = {}) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/pilot/auth/session')) {
      if (handlers.session) return handlers.session();
      throw new Error('No session check in this test: the queue does not keep saves');
    }
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
    // The TV status line (lane U2-6a) reads the gym's TVs; by default the gym has none paired.
    if (url.includes('/api/pilot/gym-tvs')) {
      return handlers.tvs ? handlers.tvs() : jsonResponse({ tvs: [] });
    }
    if (url.includes('script_id=')) {
      return handlers.detail ? handlers.detail() : jsonResponse({ script: scriptDetail() });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// The plan's blocks, in running order: every list item on the console except the top row's tiles.
// Under this suite's fetch mock the tiles' reads fail, and since lane U2-6b a failed pain read is
// a "?" tile (a list item), not a note, so a screen-wide list-item query would include it.
function blockItems(): HTMLElement[] {
  const tiles = screen.queryByRole('group', { name: 'The gym at a glance' });
  return screen.queryAllByRole('listitem').filter((item) => !tiles?.contains(item));
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
    // Null authored fields say "Not written yet", never a hidden line or an empty label:
    // the current block has Say filled, and Explain, Watch and Fix empty.
    expect(screen.getByText('Fix:')).toBeInTheDocument();
    expect(screen.getAllByText('Not written yet')).toHaveLength(3);

    // Position labels: before the cursor is Earlier, after it is Upcoming.
    const items = blockItems();
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
    expect(blockItems()).toEqual([]);
  });
});

// Look B on the coach's console (lane L39 PR 3): the tiles are mounted as its top row, and the
// console sits INSIDE the wall-board kit's scope -- the kit's rules are `.ge-wallboard .ge-frame`,
// so a scope on the board itself would draw no frame at all (the review that caught it).
describe("the coach's console in look B", () => {
  it('mounts the top row of tiles, and a tile read this test does not serve says so in words', async () => {
    await renderLive(liveRun());
    expect(screen.getByRole('region', { name: 'Attendance today' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Need attention · your athletes' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'SHADOW queue' })).toBeInTheDocument();
    expect(await screen.findAllByText('Could not read')).toHaveLength(3);
    // The pain tile's unread feed says so in its own tile (lane U2-6b), never as a number.
    const pain = within(screen.getByRole('region', { name: 'Athlete pain reports' }));
    expect(pain.getByText('Pain reports: not checked').previousSibling).toHaveTextContent(/^\?$/);
  });

  it('sits in the frame with the kit scope on an ancestor, where the kit rules reach it', async () => {
    await renderLive(liveRun());
    const console_ = screen.getByRole('region', { name: 'Live session delivery' });
    expect(console_).toHaveClass('ge-frame');
    expect(console_).not.toHaveClass('ge-wallboard');
    expect(console_.parentElement?.closest('.ge-wallboard')).not.toBeNull();
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
    // The send now follows the queue's account check (W4 item 7), so it is counted once that settles.
    await act(async () => {});
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

// Lane U2-6a (Overwatch's 6a ruling; Q2 = A, Q3 = A, Q10 = A; Q1 corrected the "admin" premise).
describe('the Allow on a TV switch', () => {
  const allow = () => screen.getByRole('switch', { name: 'Allow on a TV' });

  it('a new run is not allowed on a TV; the switch sends show: true and adopts the server answer, in words', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: liveRun({ show_on_wall: true }) }),
    });
    expect(allow()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Off')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(allow());
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'show_on_wall', show: true }]);
    expect(allow()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('switching it off sends show: false -- an explicit value, never a toggle', async () => {
    const { fetchMock } = await renderLive(liveRun({ show_on_wall: true }), {
      patch: () => jsonResponse({ run: liveRun({ show_on_wall: false }) }),
    });

    await act(async () => {
      fireEvent.click(allow());
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'show_on_wall', show: false }]);
    expect(allow()).toHaveAttribute('aria-checked', 'false');
  });

  it('the switch shows the server answer even on success: asked for true, told false, stays Off', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      patch: () => jsonResponse({ run: liveRun({ show_on_wall: false }) }),
    });

    await act(async () => {
      fireEvent.click(allow());
    });

    expect(patchCalls(fetchMock)).toEqual([{ action: 'show_on_wall', show: true }]);
    expect(allow()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('a refused switch leaves the shown state as it was and says why', async () => {
    await renderLive(liveRun(), {
      patch: () => jsonResponse({ error: 'SOMETHING_ELSE' }, false, 422),
    });

    await act(async () => {
      fireEvent.click(allow());
    });

    expect(allow()).toHaveAttribute('aria-checked', 'false');
    // Words, never the stored code (UXB-09).
    expect(screen.getByRole('alert')).toHaveTextContent('That did not go through. Nothing was changed. Try again.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('SOMETHING_ELSE');
  });

  // F-060: the TV has shown sessions since Release 21. The switch alone puts nothing on it; the
  // coach sends the run from Gym TVs, below the console on the class screen (Q3 = A).
  it('says how the session reaches a TV, not that TVs cannot show it', async () => {
    await renderLive(liveRun());
    expect(screen.getByText('With this on, send the session to a gym TV from Gym TVs below.')).toBeInTheDocument();
    expect(screen.queryByText(/does not show sessions yet/)).toBeNull();
  });
});

describe('the TV status line', () => {
  const tv = (overrides: Record<string, unknown> = {}) => ({
    tv_id: 'tv-1', tv_name: 'Ring TV', status: 'paired', current_run_id: null, ...overrides,
  });
  const tvReads = (fetchMock: jest.Mock) => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/pilot/gym-tvs'));

  it.each([
    ['no TV is paired', [], 'No TV paired'],
    ['only an expired or disconnected TV, even one still naming this run', [tv({ status: 'expired', current_run_id: 'ssrun_1' }), tv({ tv_id: 'tv-2', status: 'disconnected' })], 'No TV paired'],
    ['a paired TV shows nothing', [tv()], 'Not on a TV'],
    ["a paired TV shows another session", [tv({ current_run_id: 'ssrun_other' })], 'Not on a TV'],
    ['a paired TV shows this session', [tv({ current_run_id: 'ssrun_1' })], 'ON Ring TV'],
    ['two paired TVs show it', [tv({ current_run_id: 'ssrun_1' }), tv({ tv_id: 'tv-2', tv_name: 'Lobby TV', current_run_id: 'ssrun_1' })], 'ON Ring TV, Lobby TV'],
  ])('when %s, it reads "%s"', async (_label, tvs, words) => {
    await renderLive(liveRun({ run_id: 'ssrun_1', show_on_wall: true }), { tvs: () => jsonResponse({ tvs }) });
    const badge = await screen.findByText(words);
    expect(badge.className).toBe(words.startsWith('ON ') ? 'badge badge--cleared' : 'badge badge--filed');
    expect(badge.textContent).toBe(`${words.startsWith('ON ') ? '✓' : '—'}${words}`);
    // When it was read is said, since nothing re-reads it on a timer.
    expect(screen.getByText(/^as of /)).toBeInTheDocument();
  });

  it('"ON" comes only from the TVs, never from the switch: allowed but not sent reads "Not on a TV"', async () => {
    await renderLive(liveRun({ show_on_wall: true }), { tvs: () => jsonResponse({ tvs: [tv()] }) });
    expect(await screen.findByText('Not on a TV')).toBeInTheDocument();
    expect(screen.queryByText(/^ON /)).toBeNull();
  });

  it.each([
    ['refused (403), for any role', () => jsonResponse({ error: 'Forbidden' }, false, 403)],
    ['a server fault', () => jsonResponse({}, false, 500)],
    ['an answer with no TV list', () => jsonResponse({})],
  ])('when the read is %s, it says "TV status not checked" and gives no read time', async (_label, answer) => {
    await renderLive(liveRun(), { tvs: answer });
    expect(await screen.findByText('TV status not checked')).toBeInTheDocument();
    // Unknown is not drawn like a known "not on a TV": its own glyph.
    expect(screen.getByText('TV status not checked').textContent).toBe('?TV status not checked');
    expect(screen.queryByText(/^as of /)).toBeNull();
    expect(screen.queryByText('No TV paired')).toBeNull();
  });

  it('reads the TVs when it opens and again after the switch changes, with no timer', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      tvs: () => jsonResponse({ tvs: [] }),
      patch: () => jsonResponse({ run: liveRun({ show_on_wall: true }) }),
    });
    expect(tvReads(fetchMock)).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Allow on a TV' }));
    });
    expect(tvReads(fetchMock)).toHaveLength(2);
    expect(tvReads(fetchMock).every(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('reads the TVs again when the screen says Gym TVs acted', async () => {
    const fetchMock = mockFetch({ tvs: () => jsonResponse({ tvs: [tv()] }) });
    let rerender: (ui: ReactElement) => void = () => {};
    await act(async () => {
      ({ rerender } = render(<SessionScriptLiveDelivery initialRun={liveRun()} onSettled={jest.fn()} onRunGone={jest.fn()} tvStatusRefresh={0} />));
    });
    expect(tvReads(fetchMock)).toHaveLength(1);
    fetchMock.mockClear();
    mockFetch({ tvs: () => jsonResponse({ tvs: [tv({ current_run_id: 'ssrun_1' })] }) });
    await act(async () => {
      rerender(<SessionScriptLiveDelivery initialRun={liveRun()} onSettled={jest.fn()} onRunGone={jest.fn()} tvStatusRefresh={1} />);
    });
    expect(await screen.findByText('ON Ring TV')).toBeInTheDocument();
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
    const items = blockItems();
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
    expect(blockItems()[1].textContent).toContain('Current');
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
      { athlete_id: 'ath-1', protocol_id: 'proto-1', session_run_id: 'ssrun_1', request_key: expect.any(String) },
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
      fireEvent.click(screen.getByRole('switch', { name: 'Allow on a TV' }));
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
    // Lane U2-6a: the switch allows a TV; the words say that, not that the session is on one.
    { action: 'show_on_wall', start: liveRun(), button: 'Allow on a TV', saved: liveRun({ show_on_wall: true }), words: 'the session is allowed on a TV', badge: 'On' },
  ] as const;

  async function press(name: string) {
    await act(async () => {
      // The TV control is a switch (lane U2-6a); the others are buttons.
      fireEvent.click(screen.queryByRole('button', { name }) ?? screen.getByRole('switch', { name }));
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
        'No clear answer came back, and the server does not show the intervention yet. Try again -- it will not be logged twice.',
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
      expect(await screen.findByRole('alert')).toHaveTextContent('the server does not show the intervention yet. Try again -- it will not be logged twice.');
      expect(screen.queryByText('logged')).toBeNull();
    });

    it('two tabs of one coach: another tab\'s new log of the pair is not taken for this tap, which sent its own key (OVERWATCH 7158257725)', async () => {
      let committed = false;
      await renderLive(liveRun(), {
        logPost: () => {
          committed = true;
          return dropped();
        },
        // Only the other tab's log, under its own key, is new.
        logGet: () => jsonResponse({ items: committed ? [{ ...execution('exec-other-tab'), request_key: 'other-tab-key' }] : [] }),
      });
      await pickAndLog();
      expect(await screen.findByRole('alert')).toHaveTextContent('the server does not show the intervention yet. Try again -- it will not be logged twice.');
      expect(screen.queryByText('logged')).toBeNull();
    });

    it('this tap\'s own log, named by the key it sent, is the one found after a lost answer', async () => {
      let committed = false;
      let key: unknown;
      await renderLive(liveRun(), {
        logPost: (body) => {
          committed = true;
          key = body.request_key;
          return dropped();
        },
        logGet: () => jsonResponse({
          items: committed ? [{ ...execution('exec-other-tab'), request_key: 'other-tab-key' }, { ...execution('exec-mine'), request_key: key }] : [],
        }),
      });
      await pickAndLog();
      expect(typeof key).toBe('string');
      expect(await screen.findByRole('alert')).toHaveTextContent('the server shows the intervention was logged.');
      expect(screen.getAllByText('logged')).toHaveLength(1);
    });

    it('a retry of a tap whose first write landed late, into the retry\'s before picture, is found by its key: logged, never "not shown yet"', async () => {
      let reads = 0;
      let key: unknown;
      await renderLive(liveRun(), {
        logPost: (body) => {
          key = body.request_key;
          return dropped();
        },
        // Read 1: the first try's before picture; 2: its recovery read (its write has not committed
        // yet); 3 and 4: the retry's before picture and recovery read, both holding the first write.
        logGet: () => {
          reads += 1;
          return jsonResponse({ items: reads <= 2 ? [] : [{ ...execution('exec-late'), request_key: key }] });
        },
      });
      await pickAndLog();
      expect(await screen.findByRole('alert')).toHaveTextContent('the server does not show the intervention yet. Try again -- it will not be logged twice.');
      await press('Log intervention');
      expect(await screen.findByText(/the server shows the intervention was logged\./)).toBeInTheDocument();
      expect(reads).toBe(4);
      expect(screen.getAllByText('logged')).toHaveLength(1);
    });

    it('a log found under this tap\'s own key needs no before picture: logged, not "could not be checked"', async () => {
      let reads = 0;
      let key: unknown;
      await renderLive(liveRun(), {
        logPost: (body) => {
          key = body.request_key;
          return dropped();
        },
        logGet: () => {
          reads += 1;
          // The before picture cannot be read; the recovery read shows this tap's own log.
          return reads === 1 ? jsonResponse({}, false, 500) : jsonResponse({ items: [{ ...execution('exec-mine'), request_key: key }] });
        },
      });
      await pickAndLog();
      expect(await screen.findByRole('alert')).toHaveTextContent('the server shows the intervention was logged.');
      expect(screen.getAllByText('logged')).toHaveLength(1);
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
    expect(await screen.findByRole('alert')).toHaveTextContent('the server does not show the intervention yet. Try again -- it will not be logged twice.');
    expect(logPostCalls(fetchMock)).toHaveLength(1);
  });

  it('a run action whose session is no longer live hands control back', async () => {
    const { onRunGone } = await renderLive(liveRun(), { patch: dropped, runsGet: () => jsonResponse({ run: null }) });
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Allow on a TV' }));
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

// F-135 (lane L55). A check that finds nothing does not prove a write still in flight will not
// commit after it, so the retry the screen invites must not log the intervention a second time.
// Each tap of an athlete and protocol has one request key, sent again on its retry; the server
// answers a repeated key with the execution the first send started. The server here keeps
// executions by key the way the real one does (interventionExecutionReplay.pg.test.ts proves the
// real one).
describe('one tap, one intervention: a retry sends the same request key (F-135)', () => {
  const dropped = () => Promise.reject(new TypeError('Failed to fetch'));
  const NOT_YET = 'No clear answer came back, and the server does not show the intervention yet. Try again -- it will not be logged twice.';
  const PROTOCOLS = [
    ...DEFAULT_LOG_PROTOCOLS,
    { protocol_id: 'proto-2', title: 'Jab under fatigue', version: 1, athlete_id: null, status: 'active' },
  ];

  /** Executions kept by request key: a repeated key is answered with the execution it started. */
  function keyedServer() {
    const rows = new Map<string, { execution_id: string; created_at: string; session_run_id: string; protocol_id: string; athlete_id: string }>();
    const write = (body: Record<string, unknown>) => {
      const key = String(body.request_key);
      const existing = rows.get(key);
      if (existing) return jsonResponse({ item: existing, replayed: true });
      const row = {
        execution_id: `exec-${rows.size + 1}`,
        created_at: '2026-08-17T00:00:00.000Z',
        session_run_id: String(body.session_run_id),
        protocol_id: String(body.protocol_id),
        athlete_id: String(body.athlete_id),
      };
      rows.set(key, row);
      return jsonResponse({ item: row });
    };
    return { rows, write };
  }

  async function openLog() {
    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    fireEvent.change(await screen.findByLabelText('Athlete'), { target: { value: 'ath-1' } });
  }

  async function logWith(protocolId: string) {
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: protocolId } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Log intervention' }));
    });
  }

  it('a write that commits after the check, then the retry: same key, shown as logged, one record', async () => {
    const server = keyedServer();
    let lost: Record<string, unknown> | null = null;
    const { fetchMock } = await renderLive(liveRun(), {
      logPost: (body) => {
        if (!lost) {
          // The first send's answer is lost, and its write has not committed yet.
          lost = body;
          return dropped();
        }
        return server.write(body);
      },
      logGet: () => jsonResponse({ items: [...server.rows.values()] }),
    });
    await openLog();
    await logWith('proto-1');
    expect(await screen.findByRole('alert')).toHaveTextContent(NOT_YET);
    expect(screen.queryByText('logged')).toBeNull();

    // The first write commits now, after the check found nothing.
    if (lost) server.write(lost);

    await logWith('proto-1');
    expect(await screen.findAllByText('logged')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
    const sent = logPostCalls(fetchMock);
    expect(sent).toHaveLength(2);
    expect(typeof sent[0].request_key).toBe('string');
    expect(sent[1].request_key).toBe(sent[0].request_key);
    expect(server.rows.size).toBe(1);
  });

  it('once a tap is logged, the next tap of the same pair is a new intervention with a new key', async () => {
    const server = keyedServer();
    const { fetchMock } = await renderLive(liveRun(), { logPost: (body) => server.write(body) });
    await openLog();
    await logWith('proto-1');
    await logWith('proto-1');
    const sent = logPostCalls(fetchMock);
    expect(sent).toHaveLength(2);
    expect(sent[1].request_key).not.toBe(sent[0].request_key);
    expect(server.rows.size).toBe(2);
    expect(screen.getAllByText('logged')).toHaveLength(2);
  });

  it('once the check finds the tap logged, the next tap is a new key', async () => {
    const server = keyedServer();
    let first = true;
    const { fetchMock } = await renderLive(liveRun(), {
      logPost: (body) => {
        const answer = server.write(body);
        if (!first) return answer;
        first = false;
        return dropped();
      },
      logGet: () => jsonResponse({ items: [...server.rows.values()] }),
    });
    await openLog();
    await logWith('proto-1');
    expect(await screen.findByRole('alert')).toHaveTextContent('the server shows the intervention was logged.');
    await logWith('proto-1');
    const sent = logPostCalls(fetchMock);
    expect(sent[1].request_key).not.toBe(sent[0].request_key);
    expect(server.rows.size).toBe(2);
  });

  it('a refused retry keeps the key: the send before it may still commit', async () => {
    let posts = 0;
    const { fetchMock } = await renderLive(liveRun(), {
      logPost: () => {
        posts += 1;
        if (posts === 1) return dropped();
        if (posts === 2) return jsonResponse({ error: 'Not found' }, false, 404);
        return jsonResponse({ item: { execution_id: 'exec-1', created_at: '2026-08-17T00:00:00.000Z' } });
      },
      logGet: () => jsonResponse({ items: [] }),
    });
    await openLog();
    await logWith('proto-1');
    await logWith('proto-1');
    expect(screen.getByRole('alert')).toHaveTextContent('Not found');
    await logWith('proto-1');
    const sent = logPostCalls(fetchMock);
    expect(sent).toHaveLength(3);
    expect(sent[1].request_key).toBe(sent[0].request_key);
    expect(sent[2].request_key).toBe(sent[0].request_key);
  });

  it('a server failure keeps the key', async () => {
    let posts = 0;
    const { fetchMock } = await renderLive(liveRun(), {
      logPost: () => {
        posts += 1;
        return jsonResponse({ error: 'Internal server error' }, false, 500);
      },
      logGet: () => jsonResponse({ items: [] }),
    });
    await openLog();
    await logWith('proto-1');
    await logWith('proto-1');
    const sent = logPostCalls(fetchMock);
    expect(posts).toBe(2);
    expect(sent[1].request_key).toBe(sent[0].request_key);
  });

  it('a key refused as belonging to another intervention is dropped: the next tap is a new key', async () => {
    let refused = false;
    const { fetchMock } = await renderLive(liveRun(), {
      logPost: () => {
        if (refused) return jsonResponse({ item: { execution_id: 'exec-1', created_at: '2026-08-17T00:00:00.000Z' } });
        refused = true;
        return jsonResponse(
          { error: 'This request was already used to log a different intervention.', code: 'INTERVENTION_EXECUTION_REQUEST_KEY_REUSED' },
          false,
          409,
        );
      },
    });
    await openLog();
    await logWith('proto-1');
    expect(screen.getByRole('alert')).toHaveTextContent('This request was already used to log a different intervention.');
    await logWith('proto-1');
    const sent = logPostCalls(fetchMock);
    expect(sent).toHaveLength(2);
    expect(sent[1].request_key).not.toBe(sent[0].request_key);
  });

  it('another protocol is another tap with its own key; coming back to the unsettled one reuses its key', async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      protocols: () => jsonResponse({ items: PROTOCOLS }),
      logPost: dropped,
      logGet: () => jsonResponse({ items: [] }),
    });
    await openLog();
    await logWith('proto-1');
    await logWith('proto-2');
    await logWith('proto-1');
    const sent = logPostCalls(fetchMock);
    expect(sent.map((body) => body.protocol_id)).toEqual(['proto-1', 'proto-2', 'proto-1']);
    expect(sent[1].request_key).not.toBe(sent[0].request_key);
    expect(sent[2].request_key).toBe(sent[0].request_key);
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

    // Every request opening the drill sent is a read, to any route: the version the block links,
    // by the drill library's own read.
    const opening = fetchMock.mock.calls.slice(sentBefore);
    expect(opening.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET')).toEqual(['GET']);
    expect(opening.map((call) => String(call[0]))).toEqual(['/api/pilot/drill-library?drill_id=ref-jab-v1']);
    // Lane U2-6e: before the click, the block's empty plan lines had already read that same version,
    // and no other drill, to show the drill's text.
    expect(new Set(fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('drill-library'))))
      .toEqual(new Set(['/api/pilot/drill-library?drill_id=ref-jab-v1']));
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

  // Lane U2-6e (Overwatch option A, Q1 = A, Q2 = A, Q4 = A, 2026-11-19).
  it("the current block's empty lines show its drill's text, labelled \"From the drill\", before anything is opened", async () => {
    const { fetchMock } = await renderLive(liveRun(), {
      detail: () => jsonResponse({ script: LINKED }),
      drill: () => jsonResponse({
        drill: { ...referenceDrill(), field_drafts: { cues: true, what_good_looks_like: null, what_bad_looks_like: false, corrections: false } },
      }),
    });

    const card = (await screen.findByText('Current block')).parentElement as HTMLElement;
    expect(await within(card).findByText('Snap it back')).toBeInTheDocument();
    expect(Array.from(card.querySelectorAll('p.t-body')).map((line) => line.textContent)).toEqual([
      'Say (From the drill): Snap it back ◉DRAFT, FOR COACH REVIEW',
      'Explain: Not written yet',
      'Watch (From the drill): The hand comes straight back to the chin. (draft status not checked)',
      'Fix (From the drill): Elbow in before the next one.',
    ]);
    // Only the current block's drill was read, by GET, and nothing was written.
    const reads = fetchMock.mock.calls.filter(([url]) => String(url).includes('drill-library'));
    expect(reads.map(([url, init]) => [String(url), (init as RequestInit | undefined)?.method ?? 'GET']))
      .toEqual([['/api/pilot/drill-library?drill_id=ref-jab-v1', 'GET']]);
    expect(patchCalls(fetchMock)).toEqual([]);
    // The drill's own panel is still closed until the coach opens it.
    expect(screen.queryByRole('article', { name: 'Jab drill' })).not.toBeInTheDocument();
  });

  // The 6e follow-up (Overwatch QA = B on #1991, Q9 = A on #2001): the console's lines follow the
  // drill's own provenance where no label settles a field, as the plan page's do.
  it('a drill whose own provenance says DRAFT shows the mark where no label settles it; a non-draft label keeps none', async () => {
    await renderLive(liveRun(), {
      detail: () => jsonResponse({ script: LINKED }),
      drill: () => jsonResponse({
        drill: {
          ...referenceDrill(),
          field_provenance: REQUIRES_FLOOR_VALIDATION_PROVENANCE[1],
          field_drafts: { cues: true, what_good_looks_like: null, what_bad_looks_like: false, corrections: false },
        },
      }),
    });
    const card = (await screen.findByText('Current block')).parentElement as HTMLElement;
    expect(await within(card).findByText('Snap it back')).toBeInTheDocument();
    expect(Array.from(card.querySelectorAll('p.t-body')).map((line) => line.textContent)).toEqual([
      'Say (From the drill): Snap it back ◉DRAFT, FOR COACH REVIEW',
      'Explain: Not written yet',
      'Watch (From the drill): The hand comes straight back to the chin. ◉DRAFT, FOR COACH REVIEW',
      'Fix (From the drill): Elbow in before the next one.',
    ]);
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

// Both reviewers of 4da00ae (lane U2-6a): a panel beside the console must never work from an older
// copy of the run, and an old "ON" must not stand while the TVs are being read again.
describe('the console tells the screen the run it holds', () => {
  it('reports each run the server answers with, and the one it adopts when another is live', async () => {
    const onRunChange = jest.fn();
    mockFetch({
      patch: () => jsonResponse({ run: liveRun({ show_on_wall: true }) }),
    });
    await act(async () => {
      render(<SessionScriptLiveDelivery initialRun={liveRun()} onSettled={jest.fn()} onRunGone={jest.fn()} onRunChange={onRunChange} />);
    });
    expect(onRunChange).toHaveBeenLastCalledWith(expect.objectContaining({ run_id: 'ssrun_1', show_on_wall: false }));
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Allow on a TV' }));
    });
    expect(onRunChange).toHaveBeenLastCalledWith(expect.objectContaining({ run_id: 'ssrun_1', show_on_wall: true }));
  });

  it('while the TVs are read again after the switch changes, the old status is not shown as current', async () => {
    let answer: (response: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      tvs: () => {
        reads += 1;
        if (reads === 1) return jsonResponse({ tvs: [{ tv_id: 'tv-1', tv_name: 'Ring TV', status: 'paired', current_run_id: 'ssrun_1' }] });
        return new Promise<Response>((resolve) => { answer = resolve; });
      },
      patch: () => jsonResponse({ run: liveRun({ show_on_wall: false }) }),
    });
    await act(async () => {
      render(<SessionScriptLiveDelivery initialRun={liveRun({ show_on_wall: true })} onSettled={jest.fn()} onRunGone={jest.fn()} />);
    });
    expect(await screen.findByText('ON Ring TV')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Allow on a TV' }));
    });
    expect(screen.queryByText('ON Ring TV')).toBeNull();
    expect(screen.getByText('TV status not checked')).toBeInTheDocument();

    await act(async () => {
      answer(jsonResponse({ tvs: [{ tv_id: 'tv-1', tv_name: 'Ring TV', status: 'paired', current_run_id: null }] }));
    });
    expect(await screen.findByText('Not on a TV')).toBeInTheDocument();
  });
});

describe('kept saves (W4 item 7, OQ-3): run actions and the intervention log on a flaky connection', () => {
  const signedIn = () => jsonResponse({ authenticated: true, account_id: 'acct-a' });

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    // Signed in first, then the queue reset: the sign-in makes the queue ask again who is signed in,
    // through the last test's fetch, and that ask must not outlive the reset.
    createPersistentRoleSession('coach');
    resetSaveQueueForTests();
  });

  afterEach(() => {
    act(() => {
      resetSaveQueueForTests();
    });
  });

  // The console with the page's notice beside it, as /coach/class mounts them.
  async function renderKept(run: LiveSessionScriptRun, handlers: Handlers, callbacks: { onSettled?: jest.Mock; onRunGone?: jest.Mock } = {}) {
    const fetchMock = mockFetch({ session: signedIn, ...handlers });
    const onSettled = callbacks.onSettled ?? jest.fn();
    const onRunGone = callbacks.onRunGone ?? jest.fn();
    await act(async () => {
      render(
        <>
          <SessionScriptLiveDelivery initialRun={run} onSettled={onSettled} onRunGone={onRunGone} />
          <SaveQueueNotice />
        </>,
      );
      await jest.advanceTimersByTimeAsync(0);
    });
    return { fetchMock, onSettled, onRunGone };
  }

  function waitingLine(): HTMLElement | null {
    return (screen.queryByText(WAITING_WORDS)?.closest('[role="status"]') as HTMLElement | null | undefined) ?? null;
  }

  function signalsTo(fetchMock: jest.Mock, test: (url: string, init?: RequestInit) => boolean): unknown[] {
    return fetchMock.mock.calls
      .filter((call) => test(String(call[0]), call[1] as RequestInit | undefined))
      .map((call) => (call[1] as RequestInit).signal);
  }

  const isRunPatch = (url: string) => url.endsWith('/api/pilot/session-scripts/runs/ssrun_1');

  async function tap(name: string, role: 'button' | 'switch' = 'button') {
    await act(async () => {
      fireEvent.click(screen.getByRole(role, { name }));
      await jest.advanceTimersByTimeAsync(0);
    });
  }

  async function wait(ms: number) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  it('the console asks who is signed in when it opens', async () => {
    jest.useFakeTimers();
    const { fetchMock } = await renderKept(liveRun(), {});
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/api/pilot/auth/session'))).toBe(true);
  });

  it('a pause whose send is lost is kept, named while it waits, resent with the queue\'s signal, and lands once', async () => {
    jest.useFakeTimers();
    let sends = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      patch: () => {
        sends += 1;
        if (sends === 1) throw new TypeError('Failed to fetch');
        return jsonResponse({ run: liveRun({ is_paused: true, paused_at: 'x' }) });
      },
    });
    await tap('Pause session');
    expect(within(waitingLine() as HTMLElement).getByText('Pause session')).toBeInTheDocument();
    expect(screen.queryByText('PAUSED')).not.toBeInTheDocument();
    // The controls are free again, and the next tap works from what was asked: Resume, described by
    // the line that says the pause is not saved yet.
    expect(screen.getByRole('button', { name: 'Next block' })).not.toBeDisabled();
    const line = screen.getByText(/^Not saved yet: Pause session\./);
    expect(screen.getByRole('button', { name: 'Resume session' })).toHaveAttribute('aria-describedby', line.id);

    await wait(RESEND_MS);
    expect(patchCalls(fetchMock)).toEqual([{ action: 'pause' }, { action: 'pause' }]);
    for (const signal of signalsTo(fetchMock, isRunPatch)) expect(signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
    expect(waitingLine()).toBeNull();
  });

  it('a correction while a save waits works from what was asked: Allow on a TV on, then off', async () => {
    jest.useFakeTimers();
    const { fetchMock } = await renderKept(liveRun(), {
      patch: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await tap('Allow on a TV', 'switch');
    await tap('Allow on a TV', 'switch');
    expect(patchCalls(fetchMock)).toEqual([{ action: 'show_on_wall', show: true }]);
    expect(within(waitingLine() as HTMLElement).getByText('Allow on a TV: on')).toBeInTheDocument();
    expect(within(waitingLine() as HTMLElement).getByText('Allow on a TV: off')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Allow on a TV' })).toHaveAttribute('aria-checked', 'false');
  });

  it('a yes that does not carry the run proves nothing: the pause stays kept and is sent again', async () => {
    jest.useFakeTimers();
    let sends = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      patch: () => {
        sends += 1;
        return sends === 1 ? jsonResponse({}) : jsonResponse({ run: liveRun({ is_paused: true, paused_at: 'x' }) });
      },
    });
    await tap('Pause session');
    expect(within(waitingLine() as HTMLElement).getByText('Pause session')).toBeInTheDocument();
    await wait(RESEND_MS);
    expect(patchCalls(fetchMock)).toHaveLength(2);
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
  });

  it('a 429 is "not now", not "no": the pause is kept and sent again', async () => {
    jest.useFakeTimers();
    let sends = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      patch: () => {
        sends += 1;
        return sends === 1 ? jsonResponse({ error: 'RATE_LIMITED' }, false, 429) : jsonResponse({ run: liveRun({ is_paused: true, paused_at: 'x' }) });
      },
    });
    await tap('Pause session');
    expect(screen.queryByRole('alert')).toBeNull();
    await wait(RESEND_MS);
    expect(patchCalls(fetchMock)).toHaveLength(2);
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
  });

  it('a refused first send is not resent, and its words are on the console, not in the page\'s list', async () => {
    jest.useFakeTimers();
    const { fetchMock } = await renderKept(liveRun(), {
      patch: () => jsonResponse({ error: 'SESSION_SCRIPT_RUN_BLOCK_NOT_IN_SCRIPT' }, false, 422),
    });
    await tap('Next block');
    expect(screen.getByRole('alert').textContent).not.toBe('');
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
    await wait(RESEND_MS * 3);
    expect(patchCalls(fetchMock)).toHaveLength(1);
  });

  it('a refused RESEND that the server shows had landed reads as saved, never as failed (condition 2)', async () => {
    jest.useFakeTimers();
    let sends = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      patch: () => {
        sends += 1;
        if (sends === 1) throw new TypeError('Failed to fetch');
        return jsonResponse({ error: 'SESSION_SCRIPT_RUN_ALREADY_PAUSED' }, false, 409);
      },
      runsGet: () => jsonResponse({ run: liveRun({ is_paused: true, paused_at: 'x' }) }),
    });
    await tap('Pause session');
    await wait(RESEND_MS);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
    const reads = signalsTo(fetchMock, (url) => url.endsWith('/api/pilot/session-scripts/runs'));
    expect(reads.length).toBeGreaterThan(0);
    for (const signal of reads) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('a refused RESEND the server could not be checked for says the outcome is not known, on the console', async () => {
    jest.useFakeTimers();
    let sends = 0;
    await renderKept(liveRun(), {
      patch: () => {
        sends += 1;
        if (sends === 1) throw new TypeError('Failed to fetch');
        return jsonResponse({ error: 'SESSION_SCRIPT_RUN_ALREADY_PAUSED' }, false, 409);
      },
      runsGet: () => jsonResponse({}, false, 500),
    });
    await tap('Pause session');
    await wait(RESEND_MS);
    expect(screen.getByRole('alert').textContent).toContain('Pause session: the server refused it when it was sent again and could not be checked');
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
  });

  it('a run action refused because the session is no longer live reads the server again, as today', async () => {
    jest.useFakeTimers();
    const { onRunGone } = await renderKept(liveRun(), {
      patch: () => jsonResponse({ error: 'SESSION_RUN_NOT_LIVE' }, false, 409),
      runsGet: () => jsonResponse({ run: null }),
    });
    await tap('Pause session');
    await wait(0);
    expect(onRunGone).toHaveBeenCalledWith(RUN_GONE);
  });

  it('a kept finish locks the controls while it waits, says so, and hands the page the settled run once it lands', async () => {
    jest.useFakeTimers();
    let sends = 0;
    const { fetchMock, onSettled, onRunGone } = await renderKept(liveRun(), {
      patch: (body) => {
        sends += 1;
        if (sends === 1) throw new TypeError('Failed to fetch');
        return jsonResponse({ run: { ...liveRun(), run_state: body.run_state, ended_at: 'x' } });
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await tap('Record as completed');
    expect(screen.getByText('Ending this session is not saved yet. This page keeps sending it, and it cannot be taken back.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record as completed' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause session' })).toBeDisabled();
    await wait(RESEND_MS);
    expect(patchCalls(fetchMock).filter((body) => body.action === 'finish')).toHaveLength(2);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ run_state: 'completed' }));
    expect(onRunGone).not.toHaveBeenCalled();
  });

  it('the intervention log is kept with its pair key and the account that made it, named without the athlete, resent with the same key, and logged once', async () => {
    jest.useFakeTimers();
    let posts = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        if (posts === 1) throw new TypeError('Failed to fetch');
        return jsonResponse({ item: { execution_id: 'exec-1', created_at: '2026-08-17T00:00:00.000Z' } });
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    await wait(0);
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'proto-1' } });
    await tap('Log intervention');
    const line = waitingLine() as HTMLElement;
    expect(within(line).getByText('Intervention log: Round-3 endurance block')).toBeInTheDocument();
    expect(line).not.toHaveTextContent('Jordan');
    expect(screen.getByText('One intervention is not saved yet. This page keeps sending it while it stays open.')).toBeInTheDocument();
    // Cleared once kept: a second tap is a new choice.
    expect((screen.getByLabelText('Protocol') as HTMLSelectElement).value).toBe('');
    await wait(RESEND_MS);
    const posted = logPostCalls(fetchMock);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual({
      athlete_id: 'ath-1',
      protocol_id: 'proto-1',
      session_run_id: 'ssrun_1',
      request_key: expect.any(String),
      made_by_account_id: 'acct-a',
    });
    expect(posted[1]).toEqual(posted[0]);
    const posts2 = signalsTo(fetchMock, (url, init) => url.includes('/api/pilot/coach/intervention-executions') && init?.method === 'POST');
    for (const signal of posts2) expect(signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText('logged')).toBeInTheDocument();
    expect(waitingLine()).toBeNull();
  });

  it('the same pair logged twice while the first waits carries the same key: one log, never two (F-135)', async () => {
    jest.useFakeTimers();
    let posts = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        if (posts === 1) throw new TypeError('Failed to fetch');
        // The server answers every send of one key with the record that key wrote.
        return jsonResponse({ item: { execution_id: 'exec-1', created_at: '2026-08-17T00:00:00.000Z' } });
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    await wait(0);
    for (let round = 0; round < 2; round += 1) {
      fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
      fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'proto-1' } });
      await tap('Log intervention');
    }
    // One log will be written, so one is said to wait.
    expect(screen.getByText('One intervention is not saved yet. This page keeps sending it while it stays open.')).toBeInTheDocument();
    await wait(RESEND_MS);
    const keys = new Set(logPostCalls(fetchMock).map((body) => body.request_key));
    // Both saves were sent (the first, resent, then the second), under one key.
    expect(logPostCalls(fetchMock)).toHaveLength(3);
    expect(keys.size).toBe(1);
    expect(screen.getAllByText('logged')).toHaveLength(1);
  });

  it('once this console has settled the run, a kept save refused as no longer live says nothing: the page\'s words stand', async () => {
    jest.useFakeTimers();
    let settled = false;
    let finishes = 0;
    const tied = liveRun({ class_id: 'class-youth' });
    const { onSettled, onRunGone } = await renderKept(tied, {
      patch: (body) => {
        if (body.action === 'finish') {
          finishes += 1;
          if (finishes === 1) throw new TypeError('Failed to fetch');
          settled = true;
          return jsonResponse({ run: { ...tied, run_state: 'completed', ended_at: 'x' } });
        }
        // The no-shows tap, sent after the finish landed.
        return jsonResponse({ error: 'SESSION_RUN_NOT_LIVE' }, false, 409);
      },
      runsGet: () => (settled
        ? jsonResponse({ run: null })
        : jsonResponse({ run: tied, class: { class_id: 'class-youth', title: 'Youth boxing', start_at: 's', end_at: 'e', status: 'open', no_shows: 2, no_show_ids: ['ath-1', 'ath-2'] } })),
    });
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await tap('Record as completed');
    await wait(0);
    await tap('Mark all 2 Absent');
    await wait(RESEND_MS);
    await wait(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onRunGone).not.toHaveBeenCalled();
  });

  it('a refused log RESEND that the ledger shows had landed reads as logged (condition 2), read with the queue\'s signal', async () => {
    jest.useFakeTimers();
    let posts = 0;
    let key: unknown = null;
    const { fetchMock } = await renderKept(liveRun(), {
      logPost: (body) => {
        posts += 1;
        key = body.request_key;
        if (posts === 1) throw new TypeError('Failed to fetch');
        return jsonResponse({ error: 'INTERVENTION_EXECUTION_PROTOCOL_INACTIVE' }, false, 409);
      },
      logGet: () => {
        // Before the refused resend nothing is listed; the landed check finds the log this tap's own key started.
        return jsonResponse({ items: posts < 2 ? [] : [{ execution_id: 'exec-9', created_at: '2026-08-17T00:00:00.000Z', session_run_id: 'ssrun_1', protocol_id: 'proto-1', version: 1, recorded_by_account_id: 'acct-a', request_key: key }] });
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    await wait(0);
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'proto-1' } });
    await tap('Log intervention');
    await wait(RESEND_MS);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('logged')).toBeInTheDocument();
    const ledgerReads = signalsTo(fetchMock, (url, init) => url.includes('/api/pilot/coach/intervention-executions') && init?.method !== 'POST');
    expect(ledgerReads[ledgerReads.length - 1]).toBeInstanceOf(AbortSignal);
  });

  it('two tabs of one account: another tab\'s log of the same pair is never taken for this tap\'s refused RESEND (matched by request key)', async () => {
    jest.useFakeTimers();
    let posts = 0;
    let key: unknown = null;
    await renderKept(liveRun(), {
      logPost: (body) => {
        posts += 1;
        key = body.request_key;
        if (posts === 1) throw new TypeError('Failed to fetch');
        // Not written: the protocol was revised after this tap.
        return jsonResponse({ error: 'This protocol changed since it was loaded.', code: 'RECORD_CHANGED' }, false, 409);
      },
      logGet: () => {
        // By the landed check, the same coach has logged the same pair in another tab: a log of this
        // run, pair and account, under the other tab's own key.
        return jsonResponse({ items: posts < 2 ? [] : [{ execution_id: 'exec-other-tab', created_at: '2026-08-17T00:00:00.000Z', session_run_id: 'ssrun_1', protocol_id: 'proto-1', version: 1, recorded_by_account_id: 'acct-a', request_key: 'other-tab-key' }] });
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    await wait(0);
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'proto-1' } });
    await tap('Log intervention');
    await wait(RESEND_MS);
    expect(posts).toBe(2);
    expect(key).not.toBe('other-tab-key');
    // Said as not logged, with the server's reason, and never listed as this tap's log.
    expect(screen.getByRole('alert')).toHaveTextContent('This protocol changed since it was loaded.');
    expect(screen.queryByText('logged')).toBeNull();
  });

  it('a log under this tap\'s own key that another account wrote (a pair key first sent on today\'s path) is not taken for this tap\'s refused RESEND', async () => {
    jest.useFakeTimers();
    let posts = 0;
    let key: unknown = null;
    await renderKept(liveRun(), {
      logPost: (body) => {
        posts += 1;
        key = body.request_key;
        if (posts === 1) throw new TypeError('Failed to fetch');
        return jsonResponse({ error: 'This account cannot log for that athlete.' }, false, 403);
      },
      logGet: () => jsonResponse({ items: posts < 2 ? [] : [{ execution_id: 'exec-b', created_at: '2026-08-17T00:00:00.000Z', session_run_id: 'ssrun_1', protocol_id: 'proto-1', version: 1, recorded_by_account_id: 'acct-b', request_key: key }] }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    await wait(0);
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'proto-1' } });
    await tap('Log intervention');
    await wait(RESEND_MS);
    expect(posts).toBe(2);
    expect(screen.getByRole('alert')).toHaveTextContent('This account cannot log for that athlete.');
    expect(screen.queryByText('logged')).toBeNull();
  });

  it('signing out drops a kept run action and a kept log: their words leave the page, and neither is resent', async () => {
    jest.useFakeTimers();
    const { fetchMock } = await renderKept(liveRun(), {
      patch: () => {
        throw new TypeError('Failed to fetch');
      },
      logPost: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await tap('Pause session');
    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    await wait(0);
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'proto-1' } });
    await tap('Log intervention');
    expect(waitingLine()).not.toBeNull();
    await act(async () => {
      clearRoleSession();
    });
    expect(screen.queryByText(WAITING_WORDS)).toBeNull();
    expect(screen.queryByText('Intervention log: Round-3 endurance block')).toBeNull();
    expect(screen.queryByText(/not saved yet/)).toBeNull();
    // With nothing waiting, the next tap works from the run as the server holds it again.
    expect(screen.getByRole('button', { name: 'Pause session' })).toBeInTheDocument();
    await wait(RESEND_MS * 4);
    expect(patchCalls(fetchMock)).toHaveLength(1);
    // The log waited behind the pause (one save at a time) and was dropped unsent.
    expect(logPostCalls(fetchMock)).toHaveLength(0);
  });
  async function logPair() {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'proto-1' } });
    await tap('Log intervention');
  }

  async function openLog() {
    fireEvent.click(screen.getByRole('button', { name: 'Log an intervention...' }));
    await wait(0);
  }

  const lost = (): never => {
    throw new TypeError('Failed to fetch');
  };

  it('while a save waits, the console says beside its controls what is asked and not saved; the switch is described by it', async () => {
    jest.useFakeTimers();
    let sends = 0;
    await renderKept(liveRun(), {
      patch: () => {
        sends += 1;
        return sends === 1 ? lost() : jsonResponse({ run: liveRun({ show_on_wall: true }) });
      },
    });
    // The line's status region is there before anything is asked, empty, so its first words are announced.
    expect(document.getElementById('asked-not-saved-ssrun_1')).toBeEmptyDOMElement();
    await tap('Allow on a TV', 'switch');
    const line = screen.getByText(/^Not saved yet: Allow on a TV: on\. The buttons follow what you asked/);
    expect(line.id).not.toBe('');
    expect(screen.getByRole('switch', { name: 'Allow on a TV' })).toHaveAttribute('aria-describedby', line.id);
    await wait(RESEND_MS);
    expect(screen.queryByText(/^Not saved yet:/)).toBeNull();
    expect(screen.getByRole('switch', { name: 'Allow on a TV' })).not.toHaveAttribute('aria-describedby');
  });

  it('a refused save gives back only what it asked while another save still waits', async () => {
    jest.useFakeTimers();
    let refusePause: ((response: Response) => void) | undefined;
    await renderKept(liveRun(), {
      patch: (body) => (body.action === 'pause'
        ? new Promise<Response>((resolve) => {
          refusePause = resolve;
        })
        : lost()),
    });
    await tap('Pause session');
    await tap('Allow on a TV', 'switch');
    expect(screen.getByRole('button', { name: 'Resume session' })).toBeInTheDocument();
    await act(async () => {
      refusePause?.(jsonResponse({ error: 'SESSION_SCRIPT_RUN_ALREADY_PAUSED' }, false, 409));
      await jest.advanceTimersByTimeAsync(0);
    });
    // The TV switch still waits; the pause is back to what the server holds.
    expect(within(waitingLine() as HTMLElement).getByText('Allow on a TV: on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause session' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Allow on a TV' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/^Not saved yet: Allow on a TV: on\./)).toBeInTheDocument();
  });

  it('a refused finish frees the controls at once, even while another save still waits', async () => {
    jest.useFakeTimers();
    let refuseFinish: ((response: Response) => void) | undefined;
    await renderKept(liveRun(), {
      patch: () => new Promise<Response>((resolve) => {
        refuseFinish = resolve;
      }),
      logPost: lost,
    });
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await tap('Record as completed');
    await openLog();
    await logPair();
    expect(screen.getByRole('button', { name: 'Pause session' })).toBeDisabled();
    await act(async () => {
      refuseFinish?.(jsonResponse({ error: 'SESSION_SCRIPT_RUN_NOT_IN_PROGRESS' }, false, 409));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(within(waitingLine() as HTMLElement).getByText('Intervention log: Round-3 endurance block')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause session' })).not.toBeDisabled();
    expect(screen.queryByText(/^Ending this session is not saved yet/)).toBeNull();
    // The finish's own refusal is said on the console, which stays; not in the page's list.
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent !== '')).toBe(true);
  });

  it('signing out while a finish waits frees the controls and takes its words away', async () => {
    jest.useFakeTimers();
    await renderKept(liveRun(), { patch: lost });
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await tap('Record as completed');
    expect(screen.getByRole('button', { name: 'Pause session' })).toBeDisabled();
    await act(async () => {
      clearRoleSession();
    });
    expect(screen.getByRole('button', { name: 'Pause session' })).not.toBeDisabled();
    expect(screen.queryByText(/^Ending this session is not saved yet/)).toBeNull();
  });

  it('after a sign-out drops kept saves, the next kept save starts clean: nothing they asked, no count of them', async () => {
    jest.useFakeTimers();
    await renderKept(liveRun(), { patch: lost, logPost: lost });
    await tap('Pause session');
    await openLog();
    await logPair();
    await act(async () => {
      clearRoleSession();
    });
    await act(async () => {
      createPersistentRoleSession('coach');
    });
    await logPair();
    expect(within(waitingLine() as HTMLElement).getByText('Intervention log: Round-3 endurance block')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause session' })).toBeInTheDocument();
    expect(screen.getByText('One intervention is not saved yet. This page keeps sending it while it stays open.')).toBeInTheDocument();
  });

  it('a refusal that comes after the console has gone is said in the page\'s list, its name once', async () => {
    jest.useFakeTimers();
    let sends = 0;
    const fetchMock = mockFetch({
      session: signedIn,
      patch: () => {
        sends += 1;
        return sends === 1 ? lost() : jsonResponse({ error: 'SESSION_SCRIPT_RUN_ALREADY_PAUSED' }, false, 409);
      },
      runsGet: () => jsonResponse({}, false, 500),
    });
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(
        <>
          <SessionScriptLiveDelivery initialRun={liveRun()} onSettled={jest.fn()} onRunGone={jest.fn()} />
          <SaveQueueNotice />
        </>,
      );
      await jest.advanceTimersByTimeAsync(0);
    });
    await tap('Pause session');
    await act(async () => {
      view?.rerender(<SaveQueueNotice />);
    });
    await wait(RESEND_MS);
    expect(patchCalls(fetchMock)).toHaveLength(2);
    // Not known, so never under "Not saved:" (condition 2).
    expect(within(screen.getByRole('alert')).getByText(UNKNOWN_WORDS)).toBeInTheDocument();
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
    expect(screen.getByText(`Pause session: ${unknownOffPage('Check the session on the class screen before doing it again.')}`)).toBeInTheDocument();
  });

  it('a log refused after the console has gone is said in the page\'s list, without the athlete', async () => {
    jest.useFakeTimers();
    let posts = 0;
    mockFetch({
      session: signedIn,
      logPost: () => {
        posts += 1;
        return posts === 1 ? lost() : jsonResponse({ error: 'INTERVENTION_EXECUTION_PROTOCOL_INACTIVE' }, false, 409);
      },
      // The landed check finds no new log of the pair: refused, not landed.
      logGet: () => jsonResponse({ items: [] }),
    });
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(
        <>
          <SessionScriptLiveDelivery initialRun={liveRun()} onSettled={jest.fn()} onRunGone={jest.fn()} />
          <SaveQueueNotice />
        </>,
      );
      await jest.advanceTimersByTimeAsync(0);
    });
    await openLog();
    await logPair();
    await act(async () => {
      view?.rerender(<SaveQueueNotice />);
    });
    await wait(RESEND_MS);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/^Intervention log: Round-3 endurance block: /)).toBeInTheDocument();
    expect(alert).not.toHaveTextContent('Jordan');
  });

  it('a log refused because its key was another log\'s forgets that key: the next tap of the pair is a new log', async () => {
    jest.useFakeTimers();
    let posts = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        return posts === 1
          ? jsonResponse({ error: 'INTERVENTION_EXECUTION_REQUEST_KEY_REUSED', code: 'INTERVENTION_EXECUTION_REQUEST_KEY_REUSED' }, false, 409)
          : jsonResponse({ item: { execution_id: 'exec-2', created_at: '2026-08-17T00:00:00.000Z' } });
      },
    });
    await openLog();
    await logPair();
    await logPair();
    const keys = logPostCalls(fetchMock).map((body) => body.request_key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a log answered 429 is "not now", not "no": kept and sent again with the same key', async () => {
    jest.useFakeTimers();
    let posts = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        return posts === 1
          ? jsonResponse({ error: 'RATE_LIMITED' }, false, 429)
          : jsonResponse({ item: { execution_id: 'exec-1', created_at: '2026-08-17T00:00:00.000Z' } });
      },
    });
    await openLog();
    await logPair();
    expect(screen.queryByRole('alert')).toBeNull();
    await wait(RESEND_MS);
    const posted = logPostCalls(fetchMock);
    expect(posted).toHaveLength(2);
    expect(posted[1].request_key).toBe(posted[0].request_key);
    expect(screen.getByText('logged')).toBeInTheDocument();
  });

  it('a refused log RESEND the ledger could not be checked for says the outcome is not known, in the log panel', async () => {
    jest.useFakeTimers();
    let posts = 0;
    await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        return posts === 1 ? lost() : jsonResponse({ error: 'INTERVENTION_EXECUTION_PROTOCOL_INACTIVE' }, false, 409);
      },
      logGet: () => {
        return posts < 2 ? jsonResponse({ items: [] }) : jsonResponse({}, false, 500);
      },
    });
    await openLog();
    await logPair();
    await wait(RESEND_MS);
    expect(screen.getByRole('alert').textContent).toContain('Intervention log: Round-3 endurance block: the server refused it when it was sent again and could not be checked');
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
  });
  // The page opened before it could confirm who is signed in: the account check answers after the tap,
  // when the test says so.
  function lateSession() {
    const asked: Array<() => void> = [];
    return {
      session: () => new Promise<Response>((resolve) => {
        asked.push(() => resolve(signedIn()));
      }),
      answer: async () => {
        expect(asked.length).toBeGreaterThan(0);
        await act(async () => {
          for (const answerNow of asked.splice(0)) answerNow();
          await jest.advanceTimersByTimeAsync(0);
        });
      },
    };
  }

  it('a tap made before the page has confirmed who is signed in still shows what it asked once kept', async () => {
    jest.useFakeTimers();
    const check = lateSession();
    await renderKept(liveRun(), { session: check.session, patch: lost });
    await tap('Pause session');
    await check.answer();
    expect(within(waitingLine() as HTMLElement).getByText('Pause session')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume session' })).toBeInTheDocument();
    expect(screen.getByText(/^Not saved yet: Pause session\./)).toBeInTheDocument();
  });

  it('a log made before the page has confirmed who is signed in is still said to wait, in the log panel, once kept', async () => {
    jest.useFakeTimers();
    const check = lateSession();
    await renderKept(liveRun(), { session: check.session, logPost: lost });
    await openLog();
    await logPair();
    await check.answer();
    expect(within(waitingLine() as HTMLElement).getByText('Intervention log: Round-3 endurance block')).toBeInTheDocument();
    expect(screen.getByText('One intervention is not saved yet. This page keeps sending it while it stays open.')).toBeInTheDocument();
  });

  it('a finish made before the page has confirmed who is signed in still locks the controls once kept', async () => {
    jest.useFakeTimers();
    const check = lateSession();
    await renderKept(liveRun(), { session: check.session, patch: lost });
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await tap('Record as completed');
    await check.answer();
    expect(within(waitingLine() as HTMLElement).getByText('Record as completed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause session' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Record as abandoned' })).toBeDisabled();
    expect(screen.getByText('Ending this session is not saved yet. This page keeps sending it, and it cannot be taken back.')).toBeInTheDocument();
  });

  it('what each save asked goes with its own answer: pause, resume, pause, and the last pause still waits after the first two land', async () => {
    jest.useFakeTimers();
    let sends = 0;
    await renderKept(liveRun(), {
      patch: (body) => {
        sends += 1;
        if (sends === 1) return lost();
        // The last pause is held back.
        if (sends === 4) return new Promise<Response>(() => {});
        return jsonResponse({ run: liveRun(body.action === 'pause' ? { is_paused: true, paused_at: 'x' } : {}) });
      },
    });
    await tap('Pause session');
    await tap('Resume session');
    await tap('Pause session');
    await wait(RESEND_MS);
    expect(sends).toBe(4);
    // The server holds the resume; the pause after it is asked and not saved.
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume session' })).toBeInTheDocument();
    expect(screen.getByText(/^Not saved yet: Pause session\./)).toBeInTheDocument();
  });

  it('once a kept log lands, its line goes even while another save still waits', async () => {
    jest.useFakeTimers();
    let posts = 0;
    await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        return posts === 1 ? lost() : jsonResponse({ item: { execution_id: 'exec-1', created_at: '2026-08-17T00:00:00.000Z' } });
      },
      patch: lost,
    });
    await openLog();
    await logPair();
    await tap('Pause session');
    expect(screen.getByText('One intervention is not saved yet. This page keeps sending it while it stays open.')).toBeInTheDocument();
    await wait(RESEND_MS);
    expect(screen.getByText('logged')).toBeInTheDocument();
    expect(within(waitingLine() as HTMLElement).getByText('Pause session')).toBeInTheDocument();
    expect(screen.queryByText(/intervention is not saved yet/)).toBeNull();
  });

  it('another account\'s tap of the same pair sends its own key: the next person\'s log is never the last person\'s', async () => {
    jest.useFakeTimers();
    let account = 'acct-a';
    const { fetchMock } = await renderKept(liveRun(), {
      session: () => jsonResponse({ authenticated: true, account_id: account }),
      logPost: lost,
    });
    await openLog();
    await logPair();
    // Someone else signed in by a path that writes no device mark; the page checks again on focus.
    account = 'acct-b';
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(waitingLine()).toBeNull();
    await logPair();
    const posted = logPostCalls(fetchMock);
    expect(posted).toHaveLength(2);
    expect(posted[1].made_by_account_id).toBe('acct-b');
    expect(posted[1].request_key).not.toBe(posted[0].request_key);
  });

  it('a tap made while the page checks again who is signed in, answered as another account, still sends that account\'s own key', async () => {
    jest.useFakeTimers();
    let account = 'acct-a';
    const held: Array<() => void> = [];
    let holdChecks = false;
    const { fetchMock } = await renderKept(liveRun(), {
      session: () => (holdChecks
        ? new Promise<Response>((resolve) => {
          held.push(() => resolve(jsonResponse({ authenticated: true, account_id: account })));
        })
        : jsonResponse({ authenticated: true, account_id: account })),
      logPost: lost,
    });
    await openLog();
    await logPair();
    // Someone else signs in by a path that writes no device mark; the focus re-check is still out
    // when they tap the same pair.
    account = 'acct-b';
    holdChecks = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await jest.advanceTimersByTimeAsync(0);
    });
    await logPair();
    await act(async () => {
      for (const answerNow of held.splice(0)) answerNow();
      await jest.advanceTimersByTimeAsync(0);
    });
    const posted = logPostCalls(fetchMock);
    const last = posted[posted.length - 1];
    expect(last.made_by_account_id).toBe('acct-b');
    expect(last.request_key).not.toBe(posted[0].request_key);
  });

  it('a pair key first sent on today\'s path that replays the last person\'s log is theirs: the next account\'s log is sent again under its own key, and written', async () => {
    jest.useFakeTimers();
    let checks = 0;
    let firstKey: unknown;
    const { fetchMock } = await renderKept(liveRun(), {
      // The page cannot tell who is signed in at first, so the first log goes today's way.
      session: () => {
        checks += 1;
        return checks <= 2 ? jsonResponse({}, false, 500) : jsonResponse({ authenticated: true, account_id: 'acct-b' });
      },
      logPost: (body) => {
        if (firstKey === undefined) {
          // Today's path: it reached the server and wrote the last person's log; the answer was lost.
          firstKey = body.request_key;
          return lost();
        }
        if (body.request_key === firstKey) {
          return jsonResponse({ item: { execution_id: 'exec-a', created_at: '2026-08-17T00:00:00.000Z', recorded_by_account_id: 'acct-a', version: 1 }, replayed: true });
        }
        return jsonResponse({ item: { execution_id: 'exec-b', created_at: '2026-08-17T00:00:00.000Z', recorded_by_account_id: 'acct-b' } });
      },
    });
    await openLog();
    await logPair();
    expect(logPostCalls(fetchMock)[0].made_by_account_id).toBeUndefined();
    // Someone else, now known to the page, logs the same pair.
    await logPair();
    await wait(RESEND_MS);
    const posted = logPostCalls(fetchMock);
    expect(posted).toHaveLength(3);
    expect(posted[1]).toEqual(expect.objectContaining({ request_key: firstKey, made_by_account_id: 'acct-b' }));
    expect(posted[2]).toEqual(expect.objectContaining({ made_by_account_id: 'acct-b' }));
    expect(posted[2].request_key).not.toBe(firstKey);
    expect(screen.getAllByText('logged')).toHaveLength(1);
  });

  it('a log sent again under its own key after replaying another account\'s log is found by that key, not the pair\'s', async () => {
    jest.useFakeTimers();
    let checks = 0;
    let firstKey: unknown;
    let ownKey: unknown;
    let ownSends = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      session: () => {
        checks += 1;
        return checks <= 2 ? jsonResponse({}, false, 500) : jsonResponse({ authenticated: true, account_id: 'acct-b' });
      },
      logPost: (body) => {
        if (firstKey === undefined) {
          firstKey = body.request_key;
          return lost();
        }
        if (body.request_key === firstKey) {
          return jsonResponse({ item: { execution_id: 'exec-a', created_at: '2026-08-17T00:00:00.000Z', recorded_by_account_id: 'acct-a', version: 1 }, replayed: true });
        }
        ownKey = body.request_key;
        ownSends += 1;
        // Its own key's first send lands, its answer lost; the next is refused before the server's key lookup.
        return ownSends === 1 ? lost() : jsonResponse({ error: 'This account cannot log for that athlete.' }, false, 403);
      },
      logGet: () => jsonResponse({
        items: ownSends < 2 ? [] : [
          { execution_id: 'exec-a', created_at: '2026-08-17T00:00:00.000Z', session_run_id: 'ssrun_1', protocol_id: 'proto-1', recorded_by_account_id: 'acct-a', version: 1, request_key: firstKey },
          { execution_id: 'exec-b', created_at: '2026-08-17T00:00:00.000Z', session_run_id: 'ssrun_1', protocol_id: 'proto-1', recorded_by_account_id: 'acct-b', version: 1, request_key: ownKey },
        ],
      }),
    });
    await openLog();
    await logPair();
    await logPair();
    await wait(RESEND_MS);
    await wait(RESEND_MS);
    expect(logPostCalls(fetchMock)).toHaveLength(4);
    expect(ownSends).toBe(2);
    expect(screen.getAllByText('logged')).toHaveLength(1);
  });

  it('a ledger that names no request keys (an older server) leaves a refused RESEND not known, never taken as landed or not', async () => {
    jest.useFakeTimers();
    let posts = 0;
    await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        return posts === 1 ? lost() : jsonResponse({ error: 'INTERVENTION_EXECUTION_PROTOCOL_INACTIVE' }, false, 409);
      },
      logGet: () => jsonResponse({ items: posts < 2 ? [] : [{ execution_id: 'exec-x', created_at: '2026-08-17T00:00:00.000Z', session_run_id: 'ssrun_1', protocol_id: 'proto-1', recorded_by_account_id: 'acct-a', version: 1 }] }),
    });
    await openLog();
    await logPair();
    await wait(RESEND_MS);
    expect(screen.getByRole('alert').textContent).toContain('Intervention log: Round-3 endurance block: the server refused it when it was sent again and could not be checked');
    expect(screen.queryByText('logged')).toBeNull();
  });

  it('a ledger that names keys, holding only keyless older logs, reads a refused RESEND as not logged (not as not known)', async () => {
    jest.useFakeTimers();
    let posts = 0;
    await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        return posts === 1 ? lost() : jsonResponse({ error: 'This protocol changed since it was loaded.', code: 'RECORD_CHANGED' }, false, 409);
      },
      logGet: () => jsonResponse({ items: [{ execution_id: 'exec-old', created_at: '2026-08-17T00:00:00.000Z', session_run_id: 'ssrun_1', protocol_id: 'proto-1', recorded_by_account_id: 'acct-a', version: 1, request_key: null }] }),
    });
    await openLog();
    await logPair();
    await wait(RESEND_MS);
    expect(screen.getByRole('alert')).toHaveTextContent('This protocol changed since it was loaded.');
    expect(screen.getByRole('alert').textContent).not.toContain('could not be checked');
    expect(screen.queryByText('logged')).toBeNull();
  });

  it('a kept log reads no ledger before it is sent: the before picture is only today\'s way', async () => {
    jest.useFakeTimers();
    const { fetchMock } = await renderKept(liveRun(), {});
    await openLog();
    await logPair();
    expect(logPostCalls(fetchMock)).toHaveLength(1);
    expect(screen.getAllByText('logged')).toHaveLength(1);
    const ledgerReads = fetchMock.mock.calls.filter(
      (call) => String(call[0]).includes('/intervention-executions') && (call[1] as RequestInit | undefined)?.method !== 'POST',
    );
    expect(ledgerReads).toHaveLength(0);
  });

  it('a replay of this log as corrected by someone else since is still this log: never written twice (F-135)', async () => {
    jest.useFakeTimers();
    let posts = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        // Written; the answer is lost. A head coach corrects it on The Work before the resend.
        if (posts === 1) return lost();
        return jsonResponse({
          item: { execution_id: 'exec-1b', created_at: '2026-08-17T00:00:00.000Z', recorded_by_account_id: 'acct-head', version: 2 },
          replayed: true,
        });
      },
    });
    await openLog();
    await logPair();
    await wait(RESEND_MS * 3);
    expect(logPostCalls(fetchMock)).toHaveLength(2);
    expect(screen.getAllByText('logged')).toHaveLength(1);
    expect(waitingLine()).toBeNull();
  });

  it('a refused RESEND is not read as landed by another account\'s new log of the pair', async () => {
    jest.useFakeTimers();
    let posts = 0;
    await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        return posts === 1 ? lost() : jsonResponse({ error: 'INTERVENTION_EXECUTION_PROTOCOL_INACTIVE' }, false, 409);
      },
      logGet: () => {
        return jsonResponse({
          items: posts < 2 ? [] : [{
            execution_id: 'exec-x', created_at: '2026-08-17T00:00:00.000Z', session_run_id: 'ssrun_1', protocol_id: 'proto-1',
            recorded_by_account_id: 'acct-x', version: 1,
          }],
        });
      },
    });
    await openLog();
    await logPair();
    await wait(RESEND_MS);
    expect(screen.queryByText('logged')).toBeNull();
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent !== '')).toBe(true);
  });

  it('the next account\'s two taps of a pair whose key is not theirs carry one key of their own: one log, never two (F-135)', async () => {
    jest.useFakeTimers();
    let account = 'acct-a';
    let bPosts = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      session: () => jsonResponse({ authenticated: true, account_id: account }),
      logPost: (body) => {
        if (body.made_by_account_id === 'acct-a') return lost();
        bPosts += 1;
        if (bPosts === 1) return lost();
        return jsonResponse({ item: { execution_id: 'exec-b', created_at: '2026-08-17T00:00:00.000Z', recorded_by_account_id: 'acct-b' } });
      },
    });
    await openLog();
    await logPair();
    account = 'acct-b';
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await jest.advanceTimersByTimeAsync(0);
    });
    await logPair();
    await logPair();
    await wait(RESEND_MS);
    const posted = logPostCalls(fetchMock);
    const bKeys = posted.filter((body) => body.made_by_account_id === 'acct-b').map((body) => body.request_key);
    expect(bKeys.length).toBeGreaterThanOrEqual(3);
    expect(new Set(bKeys).size).toBe(1);
    expect(bKeys[0]).not.toBe(posted[0].request_key);
    expect(screen.getAllByText('logged')).toHaveLength(1);
  });

  it('the same coach keeps a pair\'s key across a drop: a log retried after a 401 is the same log, never a second', async () => {
    jest.useFakeTimers();
    let posts = 0;
    const { fetchMock } = await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        // The first send may have landed; its answer was lost. The resend meets a lapsed session.
        if (posts === 1) return lost();
        if (posts === 2) return jsonResponse({ error: 'UNAUTHENTICATED' }, false, 401);
        return jsonResponse({ item: { execution_id: 'exec-1', created_at: '2026-08-17T00:00:00.000Z' } });
      },
    });
    await openLog();
    await logPair();
    await wait(RESEND_MS);
    // Dropped at the 401, words and all.
    expect(waitingLine()).toBeNull();
    await logPair();
    const keys = logPostCalls(fetchMock).map((body) => body.request_key);
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[0]);
  });

  it('a log refused while a kept finish waits behind it is said in the page\'s list: the console goes once the finish lands', async () => {
    jest.useFakeTimers();
    let posts = 0;
    let reads = 0;
    const { onSettled } = await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        return posts === 1 ? lost() : jsonResponse({ error: 'INTERVENTION_EXECUTION_PROTOCOL_INACTIVE' }, false, 409);
      },
      logGet: () => {
        reads += 1;
        return jsonResponse({ items: [] });
      },
      patch: (body) => jsonResponse({ run: { ...liveRun(), run_state: body.run_state, ended_at: 'x' } }),
    });
    await openLog();
    await logPair();
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await tap('Record as completed');
    await wait(RESEND_MS);
    // The landed check read the ledger.
    expect(reads).toBeGreaterThan(0);
    const alert = within(screen.getByRole('alert'));
    expect(alert.getByText(FAILED_WORDS)).toBeInTheDocument();
    expect(alert.getByText(/^Intervention log: Round-3 endurance block: /)).toBeInTheDocument();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('a run action refused while a kept finish waits behind it is said in the page\'s list, not on the console', async () => {
    jest.useFakeTimers();
    let shows = 0;
    await renderKept(liveRun(), {
      patch: (body) => {
        if (body.action === 'finish') return new Promise<Response>(() => {});
        shows += 1;
        return shows === 1 ? lost() : jsonResponse({ error: 'SESSION_SCRIPT_RUN_BLOCK_NOT_IN_SCRIPT' }, false, 422);
      },
      // The landed check finds the TV still not allowed: refused, not landed.
      runsGet: () => jsonResponse({ run: liveRun() }),
    });
    await tap('Allow on a TV', 'switch');
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await tap('Record as completed');
    await wait(RESEND_MS);
    const alert = within(screen.getByRole('alert'));
    expect(alert.getByText(FAILED_WORDS)).toBeInTheDocument();
    expect(alert.getByText(/^Allow on a TV: on: /)).toBeInTheDocument();
  });

  it('a log whose outcome is not known while a kept finish waits is listed apart in the page\'s list, with where to check', async () => {
    jest.useFakeTimers();
    let posts = 0;
    await renderKept(liveRun(), {
      logPost: () => {
        posts += 1;
        return posts === 1 ? lost() : jsonResponse({ error: 'INTERVENTION_EXECUTION_PROTOCOL_INACTIVE' }, false, 409);
      },
      logGet: () => {
        return posts < 2 ? jsonResponse({ items: [] }) : jsonResponse({}, false, 500);
      },
      patch: () => new Promise<Response>(() => {}),
    });
    await openLog();
    await logPair();
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await tap('Record as completed');
    await wait(RESEND_MS);
    expect(screen.getByText(UNKNOWN_WORDS)).toBeInTheDocument();
    expect(screen.getByText(`Intervention log: Round-3 endurance block: ${unknownOffPage('Check The Work before logging it again.')}`)).toBeInTheDocument();
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
  });

  it('a no-shows tap refused while a kept finish waits behind it is said in the page\'s list', async () => {
    jest.useFakeTimers();
    let marks = 0;
    const tied = liveRun({ class_id: 'class-youth' });
    await renderKept(tied, {
      patch: (body) => {
        if (body.action === 'finish') return jsonResponse({ run: { ...tied, run_state: body.run_state, ended_at: 'x' } });
        marks += 1;
        return marks === 1 ? lost() : jsonResponse({ error: 'CLASS_NOT_STARTED', message: 'Not yet.' }, false, 409);
      },
      runsGet: () => jsonResponse({ run: tied, class: { class_id: 'class-youth', title: 'Youth boxing', start_at: 's', end_at: 'e', status: 'open', no_shows: 2, no_show_ids: ['ath-1', 'ath-2'] } }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'End session...' }));
    await wait(0);
    await tap('Mark all 2 Absent');
    await tap('Record as completed');
    await wait(RESEND_MS);
    expect(screen.getByText('Mark the no-shows Absent: Not yet.')).toBeInTheDocument();
  });

  it('a log refused as another\'s key forgets only its own key: a newer tap\'s key stays the pair\'s while that tap waits', async () => {
    jest.useFakeTimers();
    const answers: Array<(response: Response) => void> = [];
    const { fetchMock } = await renderKept(liveRun(), {
      logPost: () => new Promise<Response>((resolve) => {
        answers.push(resolve);
      }),
    });
    const reused = () => jsonResponse({ error: 'INTERVENTION_EXECUTION_REQUEST_KEY_REUSED', code: 'INTERVENTION_EXECUTION_REQUEST_KEY_REUSED' }, false, 409);
    const answer = async (index: number, response: Response) => {
      await act(async () => {
        answers[index](response);
        await jest.advanceTimersByTimeAsync(0);
      });
    };
    await openLog();
    await logPair(); // A: first key, sent
    await logPair(); // B: the same pair while A waits, so the same key, behind A
    await answer(0, reused()); // A refused: its key is forgotten; B is sent
    await logPair(); // C: a new key, behind B
    await answer(1, reused()); // B refused: its key is no longer the pair's, so C's stays
    await logPair(); // D: the same pair while C waits, so C's key
    await answer(2, jsonResponse({ item: { execution_id: 'exec-3', created_at: '2026-08-17T00:00:00.000Z' } }));
    const keys = logPostCalls(fetchMock).map((body) => body.request_key);
    expect(keys).toHaveLength(4);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).toBe(keys[2]);
  });
});
