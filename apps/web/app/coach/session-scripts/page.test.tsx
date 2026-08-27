/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

    expect(await screen.findByText(/No session scripts yet/i)).toBeInTheDocument();
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
