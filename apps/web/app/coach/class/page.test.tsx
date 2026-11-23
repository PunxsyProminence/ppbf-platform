/**
 * @jest-environment jsdom
 */

// The class screen (lane U2-6a; Overwatch GO 6a, Q4 = A, Q5 = A, Q6 = A, Q8 = A, Q10 = A).
// The live console and Gym TVs have their own suites; here they run for real except Gym TVs,
// which is a marker that records what the page hands it.

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import CoachClassPage from './page';
import { COACH_TILES_REFRESH_MS } from '@/components/CoachLiveTiles';

const gate: { roles: readonly string[] | null } = { roles: null };
jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children, allowedRoles }: { readonly children: ReactNode; readonly allowedRoles: readonly string[] }) => {
    gate.roles = allowedRoles;
    return children;
  },
}));

let search = new URLSearchParams();
jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  useSearchParams: () => search,
}));

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

const tvPanel: { props: Record<string, unknown> | null } = { props: null };
jest.mock('@/components/GymTvPanel', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    tvPanel.props = props;
    return <section aria-label="Gym TVs (marker)" />;
  },
}));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body } as Response;
}

const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const YOUTH = { class_id: 'class-youth', title: 'Youth boxing', start_at: soon(-10), end_at: soon(50), held_by_other_session: false };
const ADULT = { class_id: 'class-adult', title: 'Adult boxing', start_at: soon(120), end_at: soon(180), held_by_other_session: false };

function plainRun(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    run_id: 'ssrun_1',
    script_id: null,
    script_version: null,
    class_id: null,
    activity_id: null,
    delivered_by_account_id: 'acct_coach_1',
    delivered_on: '2026-11-19',
    athletes_present: null,
    blocks_completed: null,
    reset_protocol_used: false,
    deviation_note: '',
    what_worked: '',
    what_did_not: '',
    created_at: '2026-11-19T22:00:00.000Z',
    run_state: 'in_progress',
    started_at: '2026-11-19T22:00:00.000Z',
    ended_at: null,
    current_block_id: null,
    paused_at: null,
    paused_seconds: 0,
    elapsed_seconds: 60,
    is_paused: false,
    show_on_wall: false,
    ...overrides,
  };
}

const PAIN_EMPTY = { ok: true, windowDays: 7, truncated: false, painReports: [] };
function painRow(id: string, name: string) {
  return {
    nearMissId: id, athleteId: `ath_${id}`, athleteName: name, severity: 'moderate', painScore: 5,
    location: null, painType: null, observedAt: null, recordedAt: null, reporter: 'athlete', note: null, reviewed: null,
  };
}
const painReads = (fetchMock: jest.Mock) => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/pilot/coach/pain-reports'));

/** The page's own reads and the start; everything the console reads answers empty. */
function serve(handlers: {
  live?: () => Response;
  classes?: unknown[] | 'fail';
  start?: (body: Record<string, unknown>) => Response;
  patch?: (body: Record<string, unknown>) => Response;
  tvs?: () => Response;
  pain?: () => Response | Promise<Response>;
} = {}) {
  const posts: Array<Record<string, unknown>> = [];
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/pilot/session-scripts/runs/') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (handlers.patch) return handlers.patch(body);
      throw new Error(`Unexpected PATCH: ${url}`);
    }
    if (url.includes('classes=today')) {
      if (handlers.classes === 'fail') return jsonResponse({}, false, 500);
      return jsonResponse({ classes: handlers.classes ?? [] });
    }
    if (url === '/api/pilot/session-scripts/runs' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      posts.push(body);
      if (handlers.start) return handlers.start(body);
      throw new Error('Unexpected start');
    }
    if (url === '/api/pilot/session-scripts/runs') return handlers.live ? handlers.live() : jsonResponse({ run: null });
    if (url.includes('/api/pilot/gym-tvs')) return handlers.tvs ? handlers.tvs() : jsonResponse({ tvs: [] });
    if (url.endsWith('/timer')) return jsonResponse({ timer: null });
    if (url.endsWith('/athletes')) return jsonResponse({ present: [], gym: [] });
    if (url.includes('/api/pilot/coach/pain-reports')) return handlers.pain ? handlers.pain() : jsonResponse(PAIN_EMPTY);
    return jsonResponse({ items: [] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, posts };
}

const tvReads = (fetchMock: jest.Mock) => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/pilot/gym-tvs'));

async function open() {
  await act(async () => {
    render(<CoachClassPage />);
  });
}

beforeEach(() => {
  search = new URLSearchParams();
  gate.roles = null;
  tvPanel.props = null;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('the page is gated to coach and admin, the gate Session Plans has (Q8 = A)', async () => {
  serve();
  await open();
  expect(gate.roles).toEqual(['coach', 'admin']);
  expect(screen.getByRole('heading', { name: 'Class screen' })).toBeInTheDocument();
});

test('no live session: today\'s classes and one Start, which starts the chosen class and opens the console here', async () => {
  const { posts } = serve({ classes: [YOUTH], start: () => jsonResponse({ run: plainRun({ class_id: 'class-youth' }) }) });
  await open();

  expect(await screen.findByRole('radio', { name: /Youth boxing/ })).toBeChecked();
  const start = screen.getByRole('button', { name: 'Start' });
  await waitFor(() => expect(start).not.toBeDisabled());
  await act(async () => {
    fireEvent.click(start);
  });

  expect(posts).toEqual([{ class_id: 'class-youth' }]);
  expect(await screen.findByRole('heading', { name: 'Plain session' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  // Gym TVs sits on the same screen, told this run and that the coach is the one delivering it.
  expect(screen.getByLabelText('Gym TVs (marker)')).toBeInTheDocument();
  expect(tvPanel.props).toEqual(expect.objectContaining({
    liveRun: { run_id: 'ssrun_1', show_on_wall: false },
    liveRunKnown: true,
    coachAccountId: 'acct_coach_1',
  }));
});

test('a double tap on Start starts one session', async () => {
  let finish: ((value: Response) => void) | null = null;
  const { posts } = serve({ classes: [], start: () => jsonResponse({ run: plainRun() }) });
  const base = global.fetch;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/pilot/session-scripts/runs' && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    return base(input, init);
  }) as unknown as typeof fetch;
  await open();

  const start = await screen.findByRole('button', { name: 'Start' });
  await waitFor(() => expect(start).not.toBeDisabled());
  await act(async () => {
    fireEvent.click(start);
    fireEvent.click(start);
  });
  await act(async () => {
    finish?.(jsonResponse({ run: plainRun() }));
  });
  expect(await screen.findByRole('heading', { name: 'Plain session' })).toBeInTheDocument();
  expect(posts).toEqual([{}]);
});

test('?class=<id> chooses that class when it is one of today\'s free classes, over the clock default', async () => {
  search = new URLSearchParams('class=class-adult');
  const { posts } = serve({ classes: [YOUTH, ADULT], start: () => jsonResponse({ run: plainRun({ class_id: 'class-adult' }) }) });
  await open();

  expect(await screen.findByRole('radio', { name: /Adult boxing/ })).toBeChecked();
  expect(screen.getByRole('radio', { name: /Youth boxing/ })).not.toBeChecked();
  expect(screen.queryByText("That class is not one of today's free classes.")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  });
  expect(posts).toEqual([{ class_id: 'class-adult' }]);
});

test.each([
  ['not on today\'s list', 'class-gone', [YOUTH]],
  ['held by another live session', 'class-adult', [YOUTH, { ...ADULT, held_by_other_session: true }]],
])('?class=<id> that is %s is not chosen, and the page says so', async (_label, wanted, classes) => {
  search = new URLSearchParams(`class=${wanted}`);
  serve({ classes });
  await open();

  expect(await screen.findByText("That class is not one of today's free classes.")).toBeInTheDocument();
  // The picker's own default stands: the one class under way.
  expect(screen.getByRole('radio', { name: /Youth boxing/ })).toBeChecked();
});

test('a live session on arrival: the console and Gym TVs, no Start, and nothing is started', async () => {
  const { fetchMock, posts } = serve({ live: () => jsonResponse({ run: plainRun() }) });
  await open();

  expect(await screen.findByRole('heading', { name: 'Plain session' })).toBeInTheDocument();
  expect(screen.getByLabelText('Gym TVs (marker)')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  expect(posts).toEqual([]);
  // The one POST the console makes on load is the SHADOW queue's count (CoachLiveTiles), a read.
  const otherPosts = fetchMock.mock.calls.filter(([url, init]) => (init as RequestInit | undefined)?.method === 'POST'
    && String(url) !== '/api/pilot/shadow/review-projection');
  expect(otherPosts).toEqual([]);
});

test('a failed live-session check says a session may exist, and Start stays off, as it says', async () => {
  const { posts } = serve({ live: () => jsonResponse({}, false, 500), classes: [YOUTH] });
  await open();

  expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent('Whether you have a session in progress could not be checked.');
  expect(await screen.findByRole('radio', { name: /Youth boxing/ })).toBeChecked();
  const start = screen.getByRole('button', { name: 'Start' });
  expect(start).toBeDisabled();
  fireEvent.click(start);
  expect(posts).toEqual([]);
});

test('?restored=1 (a start elsewhere found this session running): the screen says it was restored, not restarted', async () => {
  search = new URLSearchParams('restored=1');
  serve({ live: () => jsonResponse({ run: plainRun() }) });
  await open();
  expect(await screen.findByText('You already had a session in progress. It has been restored, not restarted.')).toBeInTheDocument();
});

test('without ?restored=1 a session found on arrival carries no restored notice', async () => {
  serve({ live: () => jsonResponse({ run: plainRun() }) });
  await open();
  expect(await screen.findByRole('heading', { name: 'Plain session' })).toBeInTheDocument();
  expect(screen.queryByText(/restored, not restarted/)).toBeNull();
});

// Both reviewers of 4da00ae: Gym TVs held the switch value the page loaded with, so it told the
// coach to switch on a control that was already on, or showed "your session" after it was off.
test('Gym TVs follows the console: the switch it is told is the server\'s latest, and it names this screen\'s switch', async () => {
  serve({
    live: () => jsonResponse({ run: plainRun() }),
    patch: (body) => jsonResponse({ run: plainRun({ show_on_wall: body.show === true }) }),
  });
  await open();
  await screen.findByRole('heading', { name: 'Plain session' });
  expect(tvPanel.props).toEqual(expect.objectContaining({
    liveRun: { run_id: 'ssrun_1', show_on_wall: false },
    tvSwitch: { name: 'Allow on a TV', place: 'above' },
  }));

  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'Allow on a TV' }));
  });
  expect(tvPanel.props?.liveRun).toEqual({ run_id: 'ssrun_1', show_on_wall: true });

  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'Allow on a TV' }));
  });
  expect(tvPanel.props?.liveRun).toEqual({ run_id: 'ssrun_1', show_on_wall: false });
});

test('when Gym TVs finds the session ended elsewhere, the console goes and the screen says why; ?class is not chosen again', async () => {
  search = new URLSearchParams('class=class-adult');
  let live = true;
  serve({
    live: () => jsonResponse({ run: live ? plainRun() : null }),
    classes: [YOUTH, ADULT],
  });
  await open();
  await screen.findByRole('heading', { name: 'Plain session' });

  live = false;
  await act(async () => {
    await (tvPanel.props?.onRunStale as () => Promise<void>)();
  });

  expect(screen.getByText('This session is no longer live on the server. Nothing further can be recorded through this screen.')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Plain session' })).toBeNull();
  expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
  // The clock default stands; the link's class was for the session that has gone.
  expect(await screen.findByRole('radio', { name: /Youth boxing/ })).toBeChecked();
});

test('when Gym TVs finds another session live, the screen shows that one', async () => {
  let other = false;
  serve({ live: () => jsonResponse({ run: other ? plainRun({ run_id: 'ssrun_2', show_on_wall: true }) : plainRun() }) });
  await open();
  await screen.findByRole('heading', { name: 'Plain session' });

  other = true;
  await act(async () => {
    await (tvPanel.props?.onRunStale as () => Promise<void>)();
  });
  expect(tvPanel.props?.liveRun).toEqual({ run_id: 'ssrun_2', show_on_wall: true });
});

test('a start refused as already live shows the running session, restored, never a second start', async () => {
  let liveReads = 0;
  const { posts } = serve({
    classes: [],
    live: () => {
      liveReads += 1;
      return jsonResponse({ run: liveReads === 1 ? null : plainRun({ elapsed_seconds: 240 }) });
    },
    start: () => jsonResponse({ error: 'SESSION_RUN_ALREADY_LIVE' }, false, 409),
  });
  await open();
  const start = await screen.findByRole('button', { name: 'Start' });
  await waitFor(() => expect(start).not.toBeDisabled());
  await act(async () => {
    fireEvent.click(start);
  });

  expect(await screen.findByRole('heading', { name: 'Plain session' })).toBeInTheDocument();
  expect(screen.getByText('You already had a session in progress. It has been restored, not restarted.')).toHaveAttribute('role', 'status');
  expect(posts).toHaveLength(1);
});

test('a refused start shows the route\'s words beside Start, and nothing goes live', async () => {
  serve({
    classes: [YOUTH],
    start: () => jsonResponse({ error: 'SESSION_CLASS_ALREADY_LIVE', message: 'Another live session is already running this class.' }, false, 409),
  });
  await open();
  const start = await screen.findByRole('button', { name: 'Start' });
  await waitFor(() => expect(start).not.toBeDisabled());
  await act(async () => {
    fireEvent.click(start);
  });

  expect(await screen.findByRole('alert')).toHaveTextContent('Another live session is already running this class.');
  expect(screen.queryByRole('heading', { name: 'Plain session' })).toBeNull();
});

test('a settled session leaves the console, says so, and offers Start again', async () => {
  serve({
    live: () => jsonResponse({ run: plainRun() }),
    patch: (body) => jsonResponse({ run: plainRun({ run_state: body.run_state, ended_at: '2026-11-19T23:00:00.000Z' }) }),
  });
  await open();
  fireEvent.click(await screen.findByText('End session...'));
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Record as completed' }));
  });

  expect(await screen.findByText(/recorded as completed/i)).toBeInTheDocument();
  expect(screen.getByText(/can no longer be changed/)).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Plain session' })).toBeNull();
  expect(screen.queryByLabelText('Gym TVs (marker)')).toBeNull();
});

test('when Gym TVs acts, the console reads the TVs again (Q10 = A: no timer)', async () => {
  const { fetchMock } = serve({
    live: () => jsonResponse({ run: plainRun() }),
    tvs: () => jsonResponse({ tvs: [{ tv_id: 'tv-1', tv_name: 'Ring TV', status: 'paired', current_run_id: null }] }),
  });
  await open();
  expect(await screen.findByText('Not on a TV')).toBeInTheDocument();
  const before = tvReads(fetchMock).length;

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/pilot/gym-tvs')) {
      return jsonResponse({ tvs: [{ tv_id: 'tv-1', tv_name: 'Ring TV', status: 'paired', current_run_id: 'ssrun_1' }] });
    }
    return fetchMock(input, init);
  }) as unknown as typeof fetch;
  await act(async () => {
    (tvPanel.props?.onTvsChanged as () => void)();
  });

  expect(await screen.findByText('ON Ring TV')).toBeInTheDocument();
  expect(before).toBe(1);
});

describe('the pain list on the class screen (lane U2-6b-2)', () => {
  const live = () => jsonResponse({ run: plainRun() });
  const tile = () => within(screen.getByRole('region', { name: 'Athlete pain reports' }));

  test('while a session is live: the list under the console, and it and the tile count one read', async () => {
    const { fetchMock } = serve({
      live,
      pain: () => jsonResponse({ ...PAIN_EMPTY, painReports: [painRow('n1', 'Casey R.'), painRow('n2', 'Jordan P.')] }),
    });
    await open();

    expect(await screen.findByRole('heading', { name: 'Athlete Pain Reports' })).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(tile().getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^2$/);
    // One read, with limit=50, for both.
    expect(painReads(fetchMock).map(([url]) => String(url))).toEqual(['/api/pilot/coach/pain-reports?limit=50']);
    // No floor board here: the link to record what was done is the panel's.
    expect(screen.getByRole('link', { name: 'Record What You Did' })).toHaveAttribute('href', '/coach/decision-loop');
  });

  // DR-25 (PR 3 reviewers A and B): the floor tablet draws no athlete's note and no review control,
  // even when the read carries an admin's copy of a held note.
  test('the floor tablet shows no note and no Mark reviewed, even for an admin\'s held note', async () => {
    serve({
      live,
      pain: () => jsonResponse({
        ...PAIN_EMPTY,
        painReports: [
          { ...painRow('n1', 'Casey R.'), note: 'My coach hits me', noteAdminOnly: true },
          { ...painRow('n2', 'Jordan P.'), note: 'sore after sparring', noteAdminOnly: false },
        ],
      }),
    });
    await open();

    expect(await screen.findAllByRole('article')).toHaveLength(2);
    expect(screen.queryByText('My coach hits me')).toBeNull();
    expect(screen.queryByText('sore after sparring')).toBeNull();
    expect(screen.queryByText("Athlete's note")).toBeNull();
    expect(screen.queryByText("Only admins see this note. A coach's review does not cover it.")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
  });

  test.each([
    ['a server error', 500],
    ['a refusal', 403],
  ])('%s: the tile says "?" and the list says it could not load, never "no athlete reported pain"', async (_label, status) => {
    serve({ live, pain: () => jsonResponse({ error: 'no' }, false, status) });
    await open();

    expect(await screen.findByText(/Pain reports may exist that are not shown here\./)).toBeInTheDocument();
    expect(screen.queryByText(/No athlete on your roster has reported pain/)).toBeNull();
    expect(tile().getByText('Pain reports: not checked').previousSibling).toHaveTextContent(/^\?$/);
  });

  test('Refresh reads the one feed again, and the tile and the list move together', async () => {
    let rows = [painRow('n1', 'Casey R.')];
    const { fetchMock } = serve({ live, pain: () => jsonResponse({ ...PAIN_EMPTY, painReports: rows }) });
    await open();
    expect(await screen.findAllByRole('article')).toHaveLength(1);
    expect(tile().getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^1$/);

    rows = [painRow('n1', 'Casey R.'), painRow('n2', 'Jordan P.'), painRow('n3', 'Fixture Athlete')];
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh athlete pain reports' }));
    });
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(3));
    expect(tile().getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^3$/);
    expect(painReads(fetchMock)).toHaveLength(2);
  });

  test('the one read refreshes every two minutes, keeping the list on screen; the tile makes no read of its own', async () => {
    jest.useFakeTimers();
    try {
      const answers: Array<() => Response | Promise<Response>> = [
        () => jsonResponse({ ...PAIN_EMPTY, painReports: [painRow('n1', 'Casey R.'), painRow('n2', 'Jordan P.')] }),
      ];
      let held: (response: Response) => void = () => undefined;
      const { fetchMock } = serve({ live, pain: () => (answers.shift() ?? (() => new Promise<Response>((resolve) => {
        held = resolve;
      })))() });
      const flush = async () => {
        await act(async () => {
          for (let i = 0; i < 5; i += 1) await Promise.resolve();
        });
      };
      await open();
      await flush();
      expect(painReads(fetchMock)).toHaveLength(1);
      expect(screen.getAllByRole('article')).toHaveLength(2);
      await act(async () => {
        jest.advanceTimersByTime(120_000);
      });
      await flush();
      expect(painReads(fetchMock)).toHaveLength(2);
      // While the timed read is out, the list stays as last read and does not say it is checking;
      // the tile shows the same answer.
      expect(screen.getAllByRole('article')).toHaveLength(2);
      expect(screen.queryByText('Checking for athlete pain reports...')).toBeNull();
      expect(tile().getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^2$/);
      await act(async () => {
        held(jsonResponse({ ...PAIN_EMPTY, painReports: [painRow('n1', 'Casey R.')] }));
      });
      await flush();
      expect(screen.getAllByRole('article')).toHaveLength(1);
      expect(tile().getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^1$/);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the order is the console, Gym TVs, then the pain list (QH = B); its line says two minutes (QJ = B)', async () => {
    serve({ live });
    await open();
    const list = await screen.findByRole('heading', { name: 'Athlete Pain Reports' });
    const tvs = screen.getByLabelText('Gym TVs (marker)');
    // Gym TVs comes before the list in the page.
    expect(tvs.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByText(/A report appears here within two minutes of an athlete sending it\./)).toBeInTheDocument();
    // The two minutes are the read's real pace.
    expect(COACH_TILES_REFRESH_MS).toBe(120_000);
  });

  test('a row the list cannot draw is skipped: the console stays, and the tile counts the feed\'s rows', async () => {
    serve({ live, pain: () => jsonResponse({ ...PAIN_EMPTY, painReports: [painRow('n1', 'Casey R.'), null] }) });
    await open();
    expect(await screen.findAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Plain session' })).toBeInTheDocument();
    expect(tile().getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^2$/);
    expect(screen.getByText(/Pain reports may exist that are not shown here\./)).toBeInTheDocument();
  });

  test('when no row can be drawn, the tile counts it and the list says reports may not be shown, never "none"', async () => {
    serve({ live, pain: () => jsonResponse({ ...PAIN_EMPTY, painReports: [null] }) });
    await open();
    expect(await screen.findByText(/Pain reports may exist that are not shown here\./)).toBeInTheDocument();
    expect(screen.queryByText(/No athlete on your roster has reported pain/)).toBeNull();
    expect(tile().getByText('Pain reports, last 7 days').previousSibling).toHaveTextContent(/^1$/);
  });

  test('with no live session the pain feed is not read and no list shows', async () => {
    const { fetchMock } = serve({ classes: [YOUTH] });
    await open();
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(painReads(fetchMock)).toEqual([]);
    expect(screen.queryByRole('heading', { name: 'Athlete Pain Reports' })).toBeNull();
  });
});
