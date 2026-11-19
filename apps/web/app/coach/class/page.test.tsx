/**
 * @jest-environment jsdom
 */

// The class screen (lane U2-6a; Overwatch GO 6a, Q4 = A, Q5 = A, Q6 = A, Q8 = A, Q10 = A).
// The live console and Gym TVs have their own suites; here they run for real except Gym TVs,
// which is a marker that records what the page hands it.

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import CoachClassPage from './page';

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

/** The page's own reads and the start; everything the console reads answers empty. */
function serve(handlers: {
  live?: () => Response;
  classes?: unknown[] | 'fail';
  start?: (body: Record<string, unknown>) => Response;
  patch?: (body: Record<string, unknown>) => Response;
  tvs?: () => Response;
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

test('a failed live-session check says a session may exist, and offers no Start', async () => {
  serve({ live: () => jsonResponse({}, false, 500) });
  await open();

  expect(await screen.findByRole('alert')).toHaveTextContent('Whether you have a session in progress could not be checked.');
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
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
