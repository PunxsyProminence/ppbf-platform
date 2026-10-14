/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import CoachSessionScriptsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const FRIDAY = {
  script_id: 'scr-friday',
  name: 'Friday sparring',
  discipline: 'boxing',
  theme: 'Perception -> Decision -> Composure',
  phase: 'sharpening',
  day_of_week: 'friday',
  total_minutes: 60,
  contact_structure: 'split_non_contact_then_contact',
  authoring_state: 'in_use',
};

const TUESDAY = { ...FRIDAY, script_id: 'scr-tuesday', name: 'Tuesday technical', day_of_week: 'tuesday' };

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...FRIDAY,
    reset_protocol: 'Hands down, feet still, one breath.',
    coach_priorities: 'Safety, control of the room, then the lesson.',
    blocks: [
      {
        block_id: 'blk-1',
        block_order: 1,
        start_offset_min: 0,
        end_offset_min: 10,
        block_label: 'Arrival and wraps',
        what_to_say: null,
        what_to_explain: null,
        what_to_watch: null,
        what_to_fix: null,
        block_kind: 'arrival',
        drill_id: null,
        scale_level: null,
        contact_level: 'none',
      },
      {
        block_id: 'blk-2',
        block_order: 2,
        start_offset_min: 10,
        end_offset_min: 25,
        block_label: 'Add slip and visual response',
        what_to_say: 'Eyes on the chest, not the glove.',
        what_to_explain: 'Slipping is a decision, not a flinch.',
        what_to_watch: 'Chin lifting on the second slip.',
        what_to_fix: null,
        block_kind: 'drill_round',
        drill_id: 'drl-1',
        scale_level: 'B',
        contact_level: 'light_technical',
      },
    ],
    renderings: [{ rendering_id: 'ren-1', format: 'cheat_sheet' }],
    ...overrides,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** A live row of pilot.session_script_runs as the runs GET returns it. */
function liveRunRow(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    run_id: 'ssrun_1',
    script_id: 'scr-friday',
    script_version: 1,
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
    current_block_id: 'blk-1',
    paused_at: null,
    paused_seconds: 0,
    elapsed_seconds: 60,
    is_paused: false,
    ...overrides,
  };
}

/**
 * Routes the three surfaces the page can call. Order matters: the runs URLs
 * contain '/api/pilot/session-scripts' too, so they are matched first.
 */
function routedFetch(handlers: {
  runsGet?: () => Response;
  runsHistory?: (url: string) => Response;
  runsPost?: (body: Record<string, unknown>) => Response;
  runPatch?: (body: Record<string, unknown>) => Response;
  scripts?: (url: string) => Response;
}) {
  return mockFetch((url, init) => {
    if (url.includes('/api/pilot/session-scripts/runs/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (handlers.runPatch) return handlers.runPatch(body);
      throw new Error(`Unexpected PATCH: ${url}`);
    }
    if (url.includes('/api/pilot/session-scripts/runs')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (handlers.runsPost) return handlers.runsPost(body);
        throw new Error(`Unexpected runs POST: ${url}`);
      }
      if (url.includes('script_id=')) {
        return handlers.runsHistory ? handlers.runsHistory(url) : jsonResponse({ runs: [] });
      }
      return handlers.runsGet ? handlers.runsGet() : jsonResponse({ run: null });
    }
    if (handlers.scripts) return handlers.scripts(url);
    return url.includes('script_id') ? jsonResponse({ script: detail() }) : jsonResponse({ scripts: [FRIDAY] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('coach session scripts page', () => {
  it('lists the scripts returned by the route', async () => {
    mockFetch(() => jsonResponse({ scripts: [FRIDAY, TUESDAY] }));

    render(<CoachSessionScriptsPage />);

    expect(await screen.findByText('Friday sparring')).toBeInTheDocument();
    expect(screen.getByText('Tuesday technical')).toBeInTheDocument();
  });

  it('reads the list from `scripts`, the key the route actually sends', async () => {
    // The drill library shipped broken for exactly this reason: the page read a
    // key the route never sent, so it rendered empty while every test passed.
    mockFetch(() => jsonResponse({ items: [FRIDAY] }));

    render(<CoachSessionScriptsPage />);

    expect(await screen.findByText(/No session scripts in the list/i)).toBeInTheDocument();
  });

  it('distinguishes a failed load from an empty set of scripts', async () => {
    mockFetch(() => jsonResponse({}, false));

    render(<CoachSessionScriptsPage />);

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/not an empty set of scripts/i)).toBeInTheDocument();
  });

  it('shows block windows as minutes, never as clock times', async () => {
    mockFetch((url) => (url.includes('script_id')
      ? jsonResponse({ script: detail() })
      : jsonResponse({ scripts: [FRIDAY] })));

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));

    expect(await screen.findByText('10-25 min')).toBeInTheDocument();
    expect(screen.getByText('0-10 min')).toBeInTheDocument();
    // A script is the same script at 4:00 and at 6:30, so no wall-clock time
    // may appear anywhere in the rendered plan.
    expect(screen.queryByText(/\d:\d\d\s*(am|pm)/i)).not.toBeInTheDocument();
  });

  it('renders blocks in block_order, not in start-offset order', async () => {
    // Two blocks legitimately share a start offset (conditioning running under a
    // teaching minute). block_order is the sequence the coach runs.
    const shared = detail({
      blocks: [
        { ...detail().blocks[1], block_id: 'b-first', block_order: 1, start_offset_min: 30, end_offset_min: 45, block_label: 'Runs first' },
        { ...detail().blocks[1], block_id: 'b-second', block_order: 2, start_offset_min: 30, end_offset_min: 40, block_label: 'Runs second' },
      ],
    });
    mockFetch((url) => (url.includes('script_id') ? jsonResponse({ script: shared }) : jsonResponse({ scripts: [FRIDAY] })));

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));

    /* Scoped to the block list by name. This reached for EVERY listitem on the
       page, which held only one list when it was written -- so the first
       unrelated list to arrive anywhere on the page (the work-axis foot) took
       positions 0 and 1 and the assertion read the tagline instead of the
       plan. The claim is about the order of BLOCKS, so the query says so. */
    const blocks = await screen.findByRole('list', { name: /blocks/i });
    const labels = within(blocks).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(labels[0]).toContain('Runs first');
    expect(labels[1]).toContain('Runs second');
  });

  it('omits coaching fields that are null rather than printing empty labels', async () => {
    mockFetch((url) => (url.includes('script_id') ? jsonResponse({ script: detail() }) : jsonResponse({ scripts: [FRIDAY] })));

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));

    expect(await screen.findByText(/Eyes on the chest/)).toBeInTheDocument();
    // blk-2 has what_to_fix null and blk-1 has all four null.
    expect(screen.queryByText('Fix:')).not.toBeInTheDocument();
  });

  it('surfaces the reset protocol, which a new coach needs before any drill', async () => {
    mockFetch((url) => (url.includes('script_id') ? jsonResponse({ script: detail() }) : jsonResponse({ scripts: [FRIDAY] })));

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));

    expect(await screen.findByText(/Hands down, feet still/)).toBeInTheDocument();
  });

  it('clears the previous plan when a different script is opened', async () => {
    mockFetch((url) => {
      if (url.includes('scr-tuesday')) return jsonResponse({ script: detail({ script_id: 'scr-tuesday', name: 'Tuesday technical', blocks: [], renderings: [] }) });
      if (url.includes('script_id')) return jsonResponse({ script: detail() });
      return jsonResponse({ scripts: [FRIDAY, TUESDAY] });
    });

    render(<CoachSessionScriptsPage />);
    const buttons = await screen.findAllByRole('button', { name: /open plan/i });
    fireEvent.click(buttons[0]);
    expect(await screen.findByText(/Eyes on the chest/)).toBeInTheDocument();

    fireEvent.click((await screen.findAllByRole('button', { name: /open plan/i }))[0]);

    // The first script's blocks must not linger under the second script's name.
    // Waiting on the second script's own settled content, not just on the first
    // one's absence -- absence alone passes during the loading frame and would
    // still pass if the new plan never arrived.
    expect(await screen.findByText(/This script has no blocks yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Eyes on the chest/)).not.toBeInTheDocument();
  });

  it('clears a stale detail error when another script is opened', async () => {
    let firstCall = true;
    mockFetch((url) => {
      if (url.includes('script_id')) {
        if (firstCall) { firstCall = false; return jsonResponse({}, false); }
        return jsonResponse({ script: detail() });
      }
      return jsonResponse({ scripts: [FRIDAY, TUESDAY] });
    });

    render(<CoachSessionScriptsPage />);
    const buttons = await screen.findAllByRole('button', { name: /open plan/i });
    fireEvent.click(buttons[0]);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    fireEvent.click((await screen.findAllByRole('button', { name: /open plan/i }))[0]);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('an existing live run is restored on load, without starting anything', async () => {
    const fetchMock = routedFetch({ runsGet: () => jsonResponse({ run: liveRunRow() }) });

    render(<CoachSessionScriptsPage />);

    expect(await screen.findByText('Delivering now')).toBeInTheDocument();
    expect(screen.getByText(/already in progress was restored/)).toBeInTheDocument();
    // The browse-and-start flow is out of the way while a session is live.
    expect(screen.queryByRole('button', { name: /open plan/i })).not.toBeInTheDocument();
    // Restoration is a read. Reloading must never create a second run.
    const posts = fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('a failed live-run check says a session may exist, and disables starting', async () => {
    routedFetch({ runsGet: () => jsonResponse({}, false) });

    render(<CoachSessionScriptsPage />);

    expect(await screen.findByText(/could not be checked/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));
    expect(await screen.findByRole('button', { name: /start live delivery/i })).toBeDisabled();
  });

  it('starting a delivery posts the narrow contract and swaps to the live surface', async () => {
    const posted: Record<string, unknown>[] = [];
    routedFetch({
      runsGet: () => jsonResponse({ run: null }),
      runsPost: (body) => {
        posted.push(body);
        return jsonResponse({ run: liveRunRow() });
      },
    });

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));
    fireEvent.click(await screen.findByRole('button', { name: /start live delivery/i }));

    expect(await screen.findByText('Delivering now')).toBeInTheDocument();
    // script_id only: no run_state, no started_at, no elapsed time -- the
    // server owns all three.
    expect(posted).toEqual([{ script_id: 'scr-friday' }]);
  });

  it('a script with no blocks offers no start button and says why', async () => {
    routedFetch({
      runsGet: () => jsonResponse({ run: null }),
      scripts: (url) => (url.includes('script_id')
        ? jsonResponse({ script: detail({ blocks: [] }) })
        : jsonResponse({ scripts: [FRIDAY] })),
    });

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));

    expect(await screen.findByText(/cannot be delivered live until it has blocks/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start live delivery/i })).not.toBeInTheDocument();
  });

  it('a start refused as already-live restores the actual live run instead of retrying', async () => {
    let postCount = 0;
    routedFetch({
      // First GET (mount): nothing live. Second GET (recovery): the real run.
      runsGet: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return jsonResponse({ run: calls === 1 ? null : liveRunRow({ elapsed_seconds: 240 }) });
        };
      })(),
      runsPost: () => {
        postCount += 1;
        return jsonResponse({ error: 'SESSION_RUN_ALREADY_LIVE' }, false);
      },
    });

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));
    fireEvent.click(await screen.findByRole('button', { name: /start live delivery/i }));

    expect(await screen.findByText('Delivering now')).toBeInTheDocument();
    expect(screen.getByText(/restored, not restarted/)).toBeInTheDocument();
    expect(postCount).toBe(1);
  });

  it('a start refused as superseded shows the route\'s plain message, not the code', async () => {
    const message = 'This plan has been replaced by a newer version, so no session was started. Reload the list and start the current version.';
    routedFetch({
      runsGet: () => jsonResponse({ run: null }),
      runsPost: () => jsonResponse({ error: 'SESSION_SCRIPT_SUPERSEDED', message }, false),
    });

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));
    fireEvent.click(await screen.findByRole('button', { name: /start live delivery/i }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/SESSION_SCRIPT_SUPERSEDED/)).not.toBeInTheDocument();
    expect(screen.queryByText('Delivering now')).not.toBeInTheDocument();
  });

  it('a settled run leaves the live surface and says so, returning to browse', async () => {
    routedFetch({
      runsGet: () => jsonResponse({ run: liveRunRow() }),
      runPatch: (body) => jsonResponse({
        run: liveRunRow({ run_state: body.run_state, ended_at: '2026-08-14T23:00:00.000Z' }),
      }),
    });

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByText('End session...'));
    fireEvent.click(await screen.findByRole('button', { name: 'Record as completed' }));

    expect(await screen.findByText(/recorded as completed/i)).toBeInTheDocument();
    expect(screen.getByText(/can no longer be changed/)).toBeInTheDocument();
    // Back to browse; the settled run has no live controls anywhere.
    expect(await screen.findByRole('button', { name: /open plan/i })).toBeInTheDocument();
    expect(screen.queryByText('Delivering now')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause session' })).not.toBeInTheDocument();
  });

  it('refreshes the open plan history when its live delivery settles', async () => {
    let historyReads = 0;
    routedFetch({
      runsGet: () => jsonResponse({ run: null }),
      runsPost: () => jsonResponse({ run: liveRunRow() }),
      runsHistory: () => {
        historyReads += 1;
        return jsonResponse({
          runs: historyReads === 1
            ? []
            : [liveRunRow({ run_state: 'completed', ended_at: '2026-08-14T23:00:00.000Z' })],
        });
      },
      runPatch: (body) => jsonResponse({
        run: liveRunRow({ run_state: body.run_state, ended_at: '2026-08-14T23:00:00.000Z' }),
      }),
    });

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));
    expect(await screen.findByText(/No deliveries recorded for this plan yet/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /start live delivery/i }));
    fireEvent.click(await screen.findByText('End session...'));
    fireEvent.click(await screen.findByRole('button', { name: 'Record as completed' }));

    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText(/No deliveries recorded for this plan yet/)).not.toBeInTheDocument();
    expect(historyReads).toBe(2);
  });

  it('opening a plan shows its past deliveries with only the recorded fields', async () => {
    routedFetch({
      runsGet: () => jsonResponse({ run: null }),
      runsHistory: () => jsonResponse({
        runs: [
          liveRunRow({
            run_id: 'ssrun_done',
            run_state: 'completed',
            delivered_on: '2026-08-12',
            blocks_completed: 6,
            athletes_present: 9,
            reset_protocol_used: true,
            what_worked: 'Slip line clicked.',
            what_did_not: '',
          }),
          liveRunRow({
            run_id: 'ssrun_cut',
            run_state: 'abandoned',
            delivered_on: '2026-08-13',
            deviation_note: 'Storm cleared the room.',
          }),
          // A row from before live tracking: run_state is honestly null.
          liveRunRow({ run_id: 'ssrun_old', run_state: null, delivered_on: '2026-07-01', athletes_present: null }),
        ],
      }),
    });

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));

    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Abandoned')).toBeInTheDocument();
    expect(screen.getByText('Recorded before live delivery tracking')).toBeInTheDocument();
    expect(screen.getByText('2026-08-12')).toBeInTheDocument();
    expect(screen.getByText(/6 blocks completed\. 9 athletes present\. Reset protocol used\./)).toBeInTheDocument();
    expect(screen.getByText('Slip line clicked.')).toBeInTheDocument();
    expect(screen.getByText('Storm cleared the room.')).toBeInTheDocument();
    // Empty notes and null counts are omitted, never rendered as blanks or zeroes.
    expect(screen.queryByText(/Did not:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 athletes present/)).not.toBeInTheDocument();
  });

  it('an undelivered plan says so, distinctly from a failed history read', async () => {
    routedFetch({
      runsGet: () => jsonResponse({ run: null }),
      runsHistory: () => jsonResponse({ runs: [] }),
    });

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));

    expect(await screen.findByText(/No deliveries recorded for this plan yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Deliveries may exist that are not shown/)).not.toBeInTheDocument();
  });

  it('a failed history read admits it, and never renders as "never delivered"', async () => {
    routedFetch({
      runsGet: () => jsonResponse({ run: null }),
      runsHistory: () => jsonResponse({}, false),
    });

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));

    expect(await screen.findByText(/Deliveries may exist that are not shown/)).toBeInTheDocument();
    expect(screen.queryByText(/No deliveries recorded for this plan yet/)).not.toBeInTheDocument();
    // The plan itself still rendered -- the two reads fail independently.
    expect(screen.getByText('10-25 min')).toBeInTheDocument();
  });

  it('requests the script detail with the script id encoded', async () => {
    const fetchMock = mockFetch((url) => (url.includes('script_id')
      ? jsonResponse({ script: detail() })
      : jsonResponse({ scripts: [{ ...FRIDAY, script_id: 'scr/with space' }] })));

    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /open plan/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`script_id=${encodeURIComponent('scr/with space')}`),
        expect.anything(),
      );
    });
  });
});

// Issue #1523 (Jason 2026-10-12, "A: Yes, allow a plain session"): a session needs no plan.
describe('a plain session', () => {
  const plainRow = () => liveRunRow({ script_id: null, script_version: null, current_block_id: null });

  it('a gym with no scripts can start one, and it goes live straight away', async () => {
    const posts: Array<Record<string, unknown>> = [];
    routedFetch({
      scripts: (url) => (url.includes('script_id') ? jsonResponse({ script: detail() }) : jsonResponse({ scripts: [] })),
      runsPost: (body) => {
        posts.push(body);
        return jsonResponse({ run: plainRow() });
      },
    });
    render(<CoachSessionScriptsPage />);

    expect(await screen.findByText('No session scripts in the list.')).toBeInTheDocument();
    const start = await screen.findByRole('button', { name: 'Start a plain session' });
    await waitFor(() => expect(start).not.toBeDisabled());
    fireEvent.click(start);

    expect(await screen.findByRole('heading', { name: 'Plain session' })).toBeInTheDocument();
    expect(posts).toEqual([{}]);
  });

  it('is offered beside the scripts when the gym has some', async () => {
    routedFetch({});
    render(<CoachSessionScriptsPage />);

    expect(await screen.findByText('Friday sparring')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a plain session' })).toBeInTheDocument();
  });
});

it('a double tap on Start a plain session starts one session', async () => {
  const posts: Array<Record<string, unknown>> = [];
  let finish: ((value: Response) => void) | null = null;
  routedFetch({});
  const base = global.fetch;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/session-scripts/runs') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    return base(input, init);
  }) as unknown as typeof fetch;
  render(<CoachSessionScriptsPage />);

  const start = await screen.findByRole('button', { name: 'Start a plain session' });
  await waitFor(() => expect(start).not.toBeDisabled());
  // Both taps land before React re-renders, as a real double tap can.
  await act(async () => {
    fireEvent.click(start);
    fireEvent.click(start);
  });
  await act(async () => {
    finish?.(jsonResponse({ run: liveRunRow({ script_id: null, script_version: null, current_block_id: null }) }));
  });

  expect(await screen.findByRole('heading', { name: 'Plain session' })).toBeInTheDocument();
  expect(posts).toEqual([{}]);
});

it('a failed plain start says so beside its button', async () => {
  routedFetch({
    scripts: (url) => (url.includes('script_id') ? jsonResponse({ script: detail() }) : jsonResponse({ scripts: [] })),
    runsPost: () => jsonResponse({ error: 'boom' }, false),
  });
  render(<CoachSessionScriptsPage />);

  const start = await screen.findByRole('button', { name: 'Start a plain session' });
  await waitFor(() => expect(start).not.toBeDisabled());
  fireEvent.click(start);

  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Plain session' })).toBeNull();
});

// ---------------------------------------------------------------------------
// MAKING AND EDITING A PLAN (lane L1). The form's own behaviour is in
// SessionScriptEditor.test.tsx; these pin what the PAGE does around it.
// ---------------------------------------------------------------------------
describe('a coach-made plan', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  /** The page's reads, plus the plan PATCH (which routedFetch has no slot for). */
  function editingFetch(patch: (body: Record<string, unknown>) => Response) {
    const patches: Array<Record<string, unknown>> = [];
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/pilot/session-scripts/runs')) {
        if (init?.method === 'POST') return jsonResponse({ run: liveRunRow(JSON.parse(String(init.body))) });
        return url.includes('script_id=') ? jsonResponse({ runs: [] }) : jsonResponse({ run: null });
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push(body);
        return patch(body);
      }
      return url.includes('script_id') ? jsonResponse({ script: detail({ version: 1 }) }) : jsonResponse({ scripts: [FRIDAY] });
    });
    const urls = () => fetchMock.mock.calls.map((call) => String(call[0]));
    const listReads = () => urls().filter((url) => url === '/api/pilot/session-scripts').length - patches.length;
    return { patches, urls, listReads };
  }

  async function openAndEdit() {
    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open plan' }));
    await screen.findByText('Arrival and wraps');
    fireEvent.click(screen.getByRole('button', { name: 'Edit minutes and titles' }));
    return screen.findByRole('form', { name: 'Edit plan' });
  }

  it('a gym with no scripts is pointed at workout templates, where one is made', async () => {
    routedFetch({ scripts: () => jsonResponse({ scripts: [] }) });
    render(<CoachSessionScriptsPage />);

    expect(await screen.findByText('No session scripts in the list.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workout templates' })).toHaveAttribute('href', '/coach/workout-templates');
  });

  it('a link that names a script opens that plan on arrival', async () => {
    window.history.replaceState(null, '', '/coach/session-scripts?script=scr-friday');
    const fetchMock = routedFetch({});
    render(<CoachSessionScriptsPage />);

    expect(await screen.findByText('Arrival and wraps')).toBeInTheDocument();
    expect(fetchMock.mock.calls.map((call) => String(call[0])))
      .toContain('/api/pilot/session-scripts?script_id=scr-friday');
    // Used once and taken out of the address: an edit can replace that script
    // with a newer version, and a reload must not reopen the old one.
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/coach/session-scripts');
  });

  it('editing puts the start button away, and Cancel brings the stored plan back unsent', async () => {
    const { patches } = editingFetch(() => jsonResponse({}));
    await openAndEdit();

    // What Start would start is the stored plan, not the one being typed.
    expect(screen.queryByRole('button', { name: 'Start live delivery' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Session blocks, in the order they run' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('form', { name: 'Edit plan' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start live delivery' })).toBeInTheDocument();
    expect(screen.getByText('Arrival and wraps')).toBeInTheDocument();
    expect(patches).toEqual([]);
  });

  it('a plan nobody has delivered is saved where it is: "Saved.", the saved plan on screen, the list re-read', async () => {
    const saved = detail({ version: 1, name: 'Friday sparring, longer' });
    saved.blocks[0] = { ...saved.blocks[0], block_label: 'Arrival, wraps and rope', end_offset_min: 12 };
    const { patches, listReads } = editingFetch(() => jsonResponse({ outcome: 'updated', script: saved }));
    const form = await openAndEdit();
    expect(listReads()).toBe(1);

    fireEvent.click(within(form).getByRole('button', { name: 'Save plan' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    expect(screen.getByRole('heading', { name: 'Friday sparring, longer' })).toBeInTheDocument();
    expect(screen.getByText('Arrival, wraps and rope')).toBeInTheDocument();
    expect(screen.getByText('0-12 min')).toBeInTheDocument();
    expect(patches).toHaveLength(1);
    expect(patches[0].script_id).toBe('scr-friday');
    await waitFor(() => expect(listReads()).toBe(2));
  });

  it('a delivered plan is saved as a new version: the page says so, opens that version and starts it', async () => {
    const saved = detail({ script_id: 'scr-friday-v2', version: 2 });
    const { urls } = editingFetch(() => jsonResponse({ outcome: 'new_version', script: saved }));
    const form = await openAndEdit();

    fireEvent.click(within(form).getByRole('button', { name: 'Save plan' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('This plan has been delivered before, so your changes were saved as version 2.');
    expect(notice).toHaveTextContent('The sessions already delivered keep the version they ran.');
    // Its history is read under the new version's id (the read follows the lineage).
    await waitFor(() => expect(urls()).toContain('/api/pilot/session-scripts/runs?script_id=scr-friday-v2'));

    // The plan on screen is the new version, so that is the one Start starts.
    const start = screen.getByRole('button', { name: 'Start live delivery' });
    await waitFor(() => expect(start).not.toBeDisabled());
    const before = (global.fetch as jest.Mock).mock.calls.length;
    fireEvent.click(start);
    await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(before));
    const startCall = (global.fetch as jest.Mock).mock.calls
      .find((call) => String(call[0]).endsWith('/session-scripts/runs') && call[1]?.method === 'POST');
    expect(JSON.parse(String(startCall[1].body))).toEqual({ script_id: 'scr-friday-v2' });
  });

  it('a save that changed nothing says so and does not re-read the list', async () => {
    const { listReads } = editingFetch(() => jsonResponse({ outcome: 'unchanged', script: detail({ version: 1 }) }));
    const form = await openAndEdit();

    fireEvent.click(within(form).getByRole('button', { name: 'Save plan' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Nothing was changed, so nothing was saved.');
    expect(listReads()).toBe(1);
  });

  it('opening another plan drops the notice of the last save', async () => {
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/pilot/session-scripts/runs')) {
        return url.includes('script_id=') ? jsonResponse({ runs: [] }) : jsonResponse({ run: null });
      }
      if (init?.method === 'PATCH') return jsonResponse({ outcome: 'updated', script: detail({ version: 1 }) });
      if (url.includes('script_id=scr-tuesday')) return jsonResponse({ script: detail({ ...TUESDAY, version: 1 }) });
      return url.includes('script_id') ? jsonResponse({ script: detail({ version: 1 }) }) : jsonResponse({ scripts: [FRIDAY, TUESDAY] });
    });
    render(<CoachSessionScriptsPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open plan' }))[0]);
    await screen.findByText('Arrival and wraps');
    fireEvent.click(screen.getByRole('button', { name: 'Edit minutes and titles' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save plan' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');

    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));

    await screen.findByRole('heading', { name: 'Tuesday technical' });
    expect(screen.queryByRole('status')).toBeNull();
    const patches = fetchMock.mock.calls.filter((call) => call[1]?.method === 'PATCH');
    expect(patches).toHaveLength(1);
  });

  it('while a save is running no other plan can be opened and no session started: the answer lands on the plan it was for', async () => {
    let finish: ((value: Response) => void) | null = null;
    mockFetch((url, init) => {
      if (url.includes('/api/pilot/session-scripts/runs')) {
        return url.includes('script_id=') ? jsonResponse({ runs: [] }) : jsonResponse({ run: null });
      }
      if (init?.method === 'PATCH') return new Promise<Response>((resolve) => { finish = resolve; }) as unknown as Response;
      return url.includes('script_id') ? jsonResponse({ script: detail({ version: 1 }) }) : jsonResponse({ scripts: [FRIDAY, TUESDAY] });
    });
    render(<CoachSessionScriptsPage />);
    const plain = await screen.findByRole('button', { name: 'Start a plain session' });
    await waitFor(() => expect(plain).not.toBeDisabled());
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open plan' }))[0]);
    await screen.findByText('Arrival and wraps');
    fireEvent.click(screen.getByRole('button', { name: 'Edit minutes and titles' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Save plan' }));

    await screen.findByRole('button', { name: 'Saving...' });
    expect(screen.getByRole('button', { name: 'Open plan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Showing plan' })).toBeDisabled();
    expect(plain).toBeDisabled();

    await act(async () => {
      finish?.(jsonResponse({ outcome: 'updated', script: detail({ version: 1, name: 'Friday sparring, saved' }) }));
    });
    expect(await screen.findByRole('heading', { name: 'Friday sparring, saved' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open plan' })).not.toBeDisabled());
    expect(plain).not.toBeDisabled();
  });

  it('a save whose answer cannot be read says it was saved and closes the plan, which is now out of date', async () => {
    const { listReads } = editingFetch(() => ({ ok: true, json: async () => { throw new Error('unreadable'); } }) as unknown as Response);
    const form = await openAndEdit();

    fireEvent.click(within(form).getByRole('button', { name: 'Save plan' }));

    expect(await screen.findByText('The plan was saved, but the answer could not be read here. Open it from the list to see it.')).toBeInTheDocument();
    expect(screen.queryByText('Arrival and wraps')).toBeNull();
    expect(screen.queryByRole('form', { name: 'Edit plan' })).toBeNull();
    await waitFor(() => expect(listReads()).toBe(2));
  });

  it('a plain session started while a plan is being edited: when it ends, the plan is back as stored, not in edit mode', async () => {
    const plainRun = liveRunRow({ script_id: null, script_version: null, current_block_id: null });
    mockFetch((url, init) => {
      if (url.includes('/api/pilot/session-scripts/runs/')) {
        return jsonResponse({ run: { ...plainRun, run_state: 'completed', ended_at: '2026-08-14T23:00:00.000Z' } });
      }
      if (url.includes('/api/pilot/session-scripts/runs')) {
        if (init?.method === 'POST') return jsonResponse({ run: plainRun });
        return url.includes('script_id=') ? jsonResponse({ runs: [] }) : jsonResponse({ run: null });
      }
      return url.includes('script_id') ? jsonResponse({ script: detail({ version: 1 }) }) : jsonResponse({ scripts: [FRIDAY] });
    });
    await openAndEdit();

    const plain = screen.getByRole('button', { name: 'Start a plain session' });
    await waitFor(() => expect(plain).not.toBeDisabled());
    fireEvent.click(plain);
    await screen.findByRole('heading', { name: 'Plain session' });
    fireEvent.click(await screen.findByText('End session...'));
    fireEvent.click(await screen.findByRole('button', { name: 'Record as completed' }));

    expect(await screen.findByText(/recorded as completed/i)).toBeInTheDocument();
    // The plan that was open is shown as stored; the form the session took away does not come back.
    expect(await screen.findByText('Arrival and wraps')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Edit plan' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit minutes and titles' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// RETIRING A PLAN, AND BRINGING ONE BACK (lane L1, item H). A retired plan is
// kept and left out of the list; nothing is deleted.
// ---------------------------------------------------------------------------
describe('retiring a plan', () => {
  const READ_AT = '2026-10-13T15:00:00.000Z';
  const stored = (overrides: Record<string, unknown> = {}) => detail({ version: 1, updated_at: READ_AT, ...overrides });

  /** The page's reads plus the PATCH; `opened` is what the detail read returns. */
  function retireFetch(patch: (body: Record<string, unknown>) => Response | Promise<Response>, opened = stored()) {
    const patches: Array<Record<string, unknown>> = [];
    const fetchMock = mockFetch((url, init) => {
      if (url.includes('/api/pilot/session-scripts/runs')) {
        return url.includes('script_id=') ? jsonResponse({ runs: [] }) : jsonResponse({ run: null });
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push(body);
        return patch(body) as Response;
      }
      return url.includes('script_id=') ? jsonResponse({ script: opened }) : jsonResponse({ scripts: [FRIDAY] });
    });
    const listUrls = () => fetchMock.mock.calls
      .filter((call) => (call[1]?.method ?? 'GET') === 'GET')
      .map((call) => String(call[0]))
      .filter((url) => url === '/api/pilot/session-scripts' || url.startsWith('/api/pilot/session-scripts?include_retired'));
    return { patches, listUrls };
  }

  async function openPlan() {
    render(<CoachSessionScriptsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open plan' }));
    await screen.findByText('Arrival and wraps');
  }

  const refusal = (status: number, body: unknown) => ({ ok: false, status, json: async () => body }) as Response;

  it('Retire this plan sends the plan and the state it was read in, closes it, and says it is kept', async () => {
    const { patches, listUrls } = retireFetch(() => jsonResponse({ outcome: 'retired', script: stored({ authoring_state: 'retired' }) }));
    await openPlan();
    expect(listUrls()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retire this plan' }));

    // Announced, and true whether or not retired plans are being shown.
    expect(await screen.findByRole('status')).toHaveTextContent('Friday sparring is retired. It is kept, and is left out of the list unless retired plans are shown.');
    expect(patches).toEqual([{ script_id: 'scr-friday', expected_updated_at: READ_AT, retired: true }]);
    // The plan on screen was the one from before, so it is closed; the list is read again.
    expect(screen.queryByText('Arrival and wraps')).toBeNull();
    await waitFor(() => expect(listUrls()).toHaveLength(2));
  });

  it('Show retired plans reads the list again with retired ones, and Hide reads it without', async () => {
    const { listUrls } = retireFetch(() => jsonResponse({}));
    render(<CoachSessionScriptsPage />);
    await screen.findByText('Friday sparring');
    // The label says what pressing it does; there is no pressed state on top of a label that flips.
    const toggle = screen.getByRole('button', { name: 'Show retired plans' });
    expect(toggle).not.toHaveAttribute('aria-pressed');

    fireEvent.click(toggle);

    await waitFor(() => expect(listUrls()).toEqual([
      '/api/pilot/session-scripts',
      '/api/pilot/session-scripts?include_retired=true',
    ]));
    const hide = screen.getByRole('button', { name: 'Hide retired plans' });

    fireEvent.click(hide);

    await waitFor(() => expect(listUrls()).toHaveLength(3));
    expect(listUrls()[2]).toBe('/api/pilot/session-scripts');
  });

  it('a retired plan can be read and offers one thing, bringing it back; Start and Edit return with it', async () => {
    const { patches } = retireFetch(
      () => jsonResponse({ outcome: 'brought_back', script: stored({ authoring_state: 'coach_reviewed', updated_at: '2026-10-13T16:00:00.000Z' }) }),
      stored({ authoring_state: 'retired' }),
    );
    await openPlan();

    expect(screen.getByText('This plan is retired. It is kept, and is left out of the list unless retired plans are shown.')).toBeInTheDocument();
    // No control whose answer could only be "not while retired".
    expect(screen.queryByRole('button', { name: 'Start live delivery' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit minutes and titles' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retire this plan' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Bring this plan back' }));

    expect(await screen.findByRole('status')).toHaveTextContent('This plan is back in the list.');
    expect(patches).toEqual([{ script_id: 'scr-friday', expected_updated_at: READ_AT, retired: false }]);
    expect(screen.getByRole('button', { name: 'Start live delivery' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit minutes and titles' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bring this plan back' })).toBeNull();
    // The plan stays open on what the server answered.
    expect(screen.getByText('Arrival and wraps')).toBeInTheDocument();
  });

  it.each([
    [409, { error: 'SESSION_SCRIPT_CHANGED' }, /This plan was saved after you opened it, so it was not changed/],
    [409, { error: 'SESSION_SCRIPT_SUPERSEDED' }, /replaced by a newer version, so it was not changed/],
    [403, { error: 'Forbidden: role not allowed' }, /Your account may not retire session scripts, so the plan was not changed/],
    [400, { error: 'retired' }, /The server refused, so the plan was not changed/],
  ])('a refusal (%i %j) says the plan was not changed, in a plain sentence, and leaves it open', async (status, body, sentence) => {
    retireFetch(() => refusal(status, body));
    await openPlan();

    fireEvent.click(screen.getByRole('button', { name: 'Retire this plan' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(sentence);
    // An ordinary message: --locked is the medical stop and nothing else.
    expect(alert.className).not.toMatch(/locked/);
    expect(screen.getByText('Arrival and wraps')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retire this plan' })).not.toBeDisabled());
  });

  it('no answer, a server fault or a rate limit is "not known": never "was not changed"', async () => {
    const handlers = [
      () => { throw new Error('offline'); },
      () => refusal(500, { error: 'boom' }),
      () => refusal(429, { error: 'Too many requests' }),
    ];
    for (const handler of handlers) {
      retireFetch(handler);
      const view = render(<CoachSessionScriptsPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Open plan' }));
      await screen.findByText('Arrival and wraps');

      fireEvent.click(screen.getByRole('button', { name: 'Retire this plan' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/it is not known whether the plan was changed/);
      expect(alert).not.toHaveTextContent(/was not changed/);
      view.unmount();
    }
  });

  it('a double tap retires once, and no other plan can be opened or session started until it answers', async () => {
    let finish: ((value: Response) => void) | null = null;
    const { patches } = retireFetch(() => new Promise<Response>((resolve) => { finish = resolve; }));
    await openPlan();
    const plain = screen.getByRole('button', { name: 'Start a plain session' });
    await waitFor(() => expect(plain).not.toBeDisabled());
    const retire = screen.getByRole('button', { name: 'Retire this plan' });

    await act(async () => {
      fireEvent.click(retire);
      fireEvent.click(retire);
    });

    expect(patches).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Showing plan' })).toBeDisabled();
    expect(plain).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show retired plans' })).toBeDisabled();
    // Nor on this plan: a session must not go live on a plan while it is being retired,
    // and an editor opened now would be taken away with whatever was typed.
    expect(screen.getByRole('button', { name: 'Start live delivery' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit minutes and titles' })).toBeDisabled();

    await act(async () => {
      finish?.(jsonResponse({ outcome: 'retired', script: stored({ authoring_state: 'retired' }) }));
    });
    expect(await screen.findByText(/Friday sparring is retired\. It is kept,/)).toBeInTheDocument();
    await waitFor(() => expect(plain).not.toBeDisabled());
  });

  it('an empty list says "none yet" only when retired plans are being shown too', async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      if (url.includes('/api/pilot/session-scripts/runs')) return jsonResponse({ run: null });
      return jsonResponse({ scripts: [] });
    });
    render(<CoachSessionScriptsPage />);

    // Every plan may be retired: the list is empty, which is not the same as there being none.
    expect(await screen.findByText('No session scripts in the list.')).toBeInTheDocument();
    expect(screen.getByText('Retired plans are kept and are not shown here. Show retired plans lists them.')).toBeInTheDocument();
    expect(screen.queryByText('No session scripts yet.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show retired plans' }));

    expect(await screen.findByText('No session scripts yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Retired plans are kept and are not shown here/)).toBeNull();
    expect(urls).toContain('/api/pilot/session-scripts?include_retired=true');
  });

  it('retired, then shown, opened and brought back: the "is retired" notice does not outlive the plan coming back', async () => {
    let state = 'coach_reviewed';
    mockFetch((url, init) => {
      if (url.includes('/api/pilot/session-scripts/runs')) {
        return url.includes('script_id=') ? jsonResponse({ runs: [] }) : jsonResponse({ run: null });
      }
      if (init?.method === 'PATCH') {
        state = (JSON.parse(String(init.body)) as { retired: boolean }).retired ? 'retired' : 'coach_reviewed';
        return jsonResponse({ outcome: state === 'retired' ? 'retired' : 'brought_back', script: stored({ authoring_state: state }) });
      }
      if (url.includes('script_id=')) return jsonResponse({ script: stored({ authoring_state: state }) });
      // Retired plans are listed only when asked for.
      const shown = state !== 'retired' || url.includes('include_retired=true');
      return jsonResponse({ scripts: shown ? [{ ...FRIDAY, authoring_state: state }] : [] });
    });
    await openPlan();

    fireEvent.click(screen.getByRole('button', { name: 'Retire this plan' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Friday sparring is retired. It is kept, and is left out of the list unless retired plans are shown.');
    expect(await screen.findByText('No session scripts in the list.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show retired plans' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open plan' }));
    await screen.findByRole('button', { name: 'Bring this plan back' });
    // Opening the plan takes the notice about it down: the plan now says its own state.
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Bring this plan back' }));

    const notices = await screen.findAllByRole('status');
    expect(notices.map((notice) => notice.textContent)).toEqual(['This plan is back in the list.']);
    expect(screen.queryByText(/is retired/)).toBeNull();
  });

  it('opening a plan drops the refusal of the last one', async () => {
    retireFetch(() => refusal(409, { error: 'SESSION_SCRIPT_CHANGED' }));
    await openPlan();
    fireEvent.click(screen.getByRole('button', { name: 'Retire this plan' }));
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Showing plan' })).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: 'Showing plan' }));

    await screen.findByText('Arrival and wraps');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// The medical-stop colour (--locked) means a medical stop and nothing else
// (AGENT_KERNEL.md, OD-2026-09-29-001). Nothing on this page is one.
describe('ordinary errors on this page', () => {
  it('a failed load, a failed live-run check and a failed start are plain boxed alerts, not the medical-stop colour', async () => {
    mockFetch((url, init) => {
      if (url.includes('/api/pilot/session-scripts/runs')) {
        if (init?.method === 'POST') return jsonResponse({ error: 'boom' }, false);
        return jsonResponse({ run: null });
      }
      return jsonResponse({ error: 'boom' }, false);
    });
    render(<CoachSessionScriptsPage />);

    const loadError = await screen.findByText('The session scripts could not be loaded.');
    expect(loadError.className).not.toMatch(/locked/);
    expect(loadError.parentElement?.className).toMatch(/border-\[color:var\(--brass-300\)\]/);

    const start = screen.getByRole('button', { name: 'Start a plain session' });
    await waitFor(() => expect(start).not.toBeDisabled());
    fireEvent.click(start);
    const startError = await screen.findByRole('alert');
    expect(startError.className).toMatch(/border-\[color:var\(--brass-300\)\]/);
    expect(startError.className).not.toMatch(/locked/);
  });

  it('no part of the page or its editor names the medical-stop token', () => {
    // A source check on purpose: it covers the alerts no case here renders.
    const fs = jest.requireActual('node:fs') as typeof import('node:fs');
    const path = jest.requireActual('node:path') as typeof import('node:path');
    for (const file of ['page.tsx', 'SessionScriptEditor.tsx']) {
      expect(fs.readFileSync(path.join(__dirname, file), 'utf8')).not.toMatch(/var\(--locked/);
    }
  });
});
