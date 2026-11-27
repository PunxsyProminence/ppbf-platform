/**
 * @jest-environment jsdom
 */

// The session plan a new class keeps (lane W4-5, SP-4b; OW27-29 A, "Class keeps the plan; Start
// runs it", docs/current/OWNER_DECISIONS.md:1514-1523). Session Plans' "Schedule a class" opens
// /schedule?plan=<script_id>. A coach's or admin's form reads that plan once, names it, and sends
// its id with Schedule Class; a plan that cannot be read is said so and never sent. The form is not
// filled from the plan (option B, not chosen). Harness modelled on repeatWeekly.test.tsx.

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

// An id that needs encoding (a space, a slash and an ampersand); fake, as every id here is.
const PLAN_ID = 'scr friday/2&x';
const PLAN_READ_URL = `/api/pilot/session-scripts?script_id=${encodeURIComponent(PLAN_ID)}`;
const PLAN_NAME = 'Friday sparring';
const READ_FAILED = 'The session plan could not be read, so this class will be scheduled without one.';

type Answer = { ok: boolean; status?: number; body: unknown } | 'lost';
type PlanAnswer = Answer | Promise<Answer>;

/** GET /api/pilot/session-scripts?script_id= as it answers a coach: { script } (route.ts:62-67). */
const PLAN_FOUND: Answer = {
  ok: true,
  body: { script: { script_id: PLAN_ID, name: PLAN_NAME, authoring_state: 'in_use', blocks: [], renderings: [] } },
};

function installFetchMock(options: { role?: string; plan?: () => PlanAnswer; posts?: Answer[] } = {}): jest.Mock {
  const role = options.role ?? 'coach';
  const posts = options.posts ?? [];
  const respond = (answer: Answer) => (answer === 'lost'
    ? Promise.reject(new TypeError('Failed to fetch'))
    : Promise.resolve({ ok: answer.ok, status: answer.status ?? (answer.ok ? 200 : 400), json: () => Promise.resolve(answer.body) } as Response));
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/pilot/auth/session')) {
      return respond({ ok: true, body: { authenticated: true, role, athlete_id: role === 'athlete' ? 'ath-test-1' : null } });
    }
    if (url.endsWith('/api/pilot/athletes/list')) return respond({ ok: true, body: { items: [] } });
    if (url.endsWith('/api/pilot/athletes/get')) return respond({ ok: true, body: { found: false } });
    if (url.includes('/api/pilot/session-scripts')) return respond(await (options.plan ?? (() => PLAN_FOUND))());
    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
      return respond(posts.shift() ?? { ok: true, body: { ok: true, class_ids: ['c-1'] } });
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      return respond({ ok: true, body: { ok: true, role, classes: [], registrations: [], coaching_requests: [], attendance: [] } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function planReads(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/api/pilot/session-scripts'));
}

function creates(fetchMock: jest.Mock): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/api/pilot/scheduler') && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
    .filter((body) => body.action === 'create_class');
}

function arriveWithPlan() {
  window.history.pushState(null, '', `/schedule?plan=${encodeURIComponent(PLAN_ID)}`);
}

async function renderPage() {
  render(<SchedulerPage />);
  await screen.findByText('Class Schedule');
}

function fillClass() {
  fireEvent.change(screen.getByPlaceholderText('Class title'), { target: { value: 'Evening boxing' } });
  fireEvent.change(screen.getByLabelText('Class starts'), { target: { value: '2026-12-01T18:00' } });
  fireEvent.change(screen.getByLabelText('Class ends'), { target: { value: '2026-12-01T19:30' } });
  fireEvent.change(screen.getByPlaceholderText('Location'), { target: { value: 'Main Floor' } });
}

async function pressSchedule() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Schedule Class' }));
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('a class that keeps its session plan', () => {
  test('a coach arriving with ?plan= reads the plan once and names it; the form is not filled from it', async () => {
    let answer: (value: Answer) => void = () => {};
    const fetchMock = installFetchMock({ plan: () => new Promise<Answer>((resolve) => { answer = resolve; }) });
    arriveWithPlan();
    await renderPage();

    expect(await screen.findByText('Reading the session plan…')).toBeInTheDocument();
    // While the plan is read, Schedule Class is held: a press would schedule without it.
    expect(screen.getByRole('button', { name: 'Schedule Class' })).toBeDisabled();
    await act(async () => answer(PLAN_FOUND));

    expect(await screen.findByText(`Session plan: ${PLAN_NAME}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule Class' })).toBeEnabled();
    expect(screen.queryByText('Reading the session plan…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Schedule without a plan' })).toBeInTheDocument();
    expect(planReads(fetchMock)).toEqual([PLAN_READ_URL]);
    // Not filled from the plan: the title and times are the coach's to type.
    expect(screen.getByPlaceholderText('Class title')).toHaveValue('');
    expect(screen.getByLabelText('Class starts')).toHaveValue('');
    expect(screen.getByLabelText('Class ends')).toHaveValue('');
  });

  test('Schedule Class sends the plan read; once scheduled the plan is dropped from the form and the address', async () => {
    const fetchMock = installFetchMock();
    arriveWithPlan();
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);
    fillClass();

    await pressSchedule();

    const [sent] = creates(fetchMock);
    expect(sent).toMatchObject({ action: 'create_class', title: 'Evening boxing', script_id: PLAN_ID });
    expect(await screen.findByText('Class scheduled successfully.')).toBeInTheDocument();
    expect(screen.queryByText(`Session plan: ${PLAN_NAME}`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Schedule without a plan' })).toBeNull();
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/schedule');

    // The next class is scheduled without it, and the plan is not read again.
    fillClass();
    await pressSchedule();
    expect(creates(fetchMock)[1]).not.toHaveProperty('script_id');
    expect(planReads(fetchMock)).toHaveLength(1);
  });

  test('a weekly repeat sends one request carrying the plan once', async () => {
    const fetchMock = installFetchMock({ posts: [{ ok: true, body: { ok: true, class_ids: ['c-1', 'c-2', 'c-3', 'c-4'] } }] });
    arriveWithPlan();
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);
    fillClass();
    fireEvent.click(screen.getByLabelText('Repeat weekly'));

    await pressSchedule();

    const sent = creates(fetchMock);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ script_id: PLAN_ID, repeat_weeks: 4 });
    expect(await screen.findByText('4 weekly classes scheduled.')).toBeInTheDocument();
  });

  test('"Schedule without a plan" drops it from the form and the address, and Schedule Class sends none', async () => {
    const fetchMock = installFetchMock();
    arriveWithPlan();
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);

    fireEvent.click(screen.getByRole('button', { name: 'Schedule without a plan' }));

    expect(screen.queryByText(`Session plan: ${PLAN_NAME}`)).toBeNull();
    expect(screen.queryByText(READ_FAILED)).toBeNull();
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/schedule');
    fillClass();
    await pressSchedule();
    expect(creates(fetchMock)[0]).not.toHaveProperty('script_id');
    expect(planReads(fetchMock)).toHaveLength(1);
  });

  test.each<[string, () => PlanAnswer]>([
    ['not found', () => ({ ok: false, status: 404, body: { error: 'SESSION_SCRIPT_NOT_FOUND' } })],
    ['refused', () => ({ ok: false, status: 403, body: { error: 'Forbidden: role not allowed' } })],
    ['lost', () => 'lost'],
    ['answered with no plan', () => ({ ok: true, body: { script: null } })],
  ])('a read that is %s says so, and the class is scheduled without a plan', async (_case, plan) => {
    const fetchMock = installFetchMock({ plan });
    arriveWithPlan();
    await renderPage();

    expect(await screen.findByText(READ_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(/^Session plan:/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Schedule without a plan' })).toBeNull();
    fillClass();
    await pressSchedule();
    expect(creates(fetchMock)[0]).not.toHaveProperty('script_id');
  });

  test.each([['a parent', 'parent'], ['an athlete', 'athlete']])('%s arriving with ?plan= makes no plan read', async (_who, role) => {
    const fetchMock = installFetchMock({ role });
    arriveWithPlan();
    await renderPage();
    await act(async () => {});

    expect(planReads(fetchMock)).toEqual([]);
    expect(screen.queryByText('Schedule New Class')).toBeNull();
    expect(screen.queryByText('Reading the session plan…')).toBeNull();
    expect(screen.queryByText(READ_FAILED)).toBeNull();
  });

  test('CLASS_PLAN_NOT_FOUND is said in plain words, not the server\'s field message', async () => {
    installFetchMock({
      posts: [{ ok: false, body: { error: 'script_id must name a session plan of this gym', code: 'CLASS_PLAN_NOT_FOUND' } }],
    });
    arriveWithPlan();
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);
    fillClass();

    await pressSchedule();

    expect(await screen.findByText(
      'That session plan was not found in this gym, so nothing was scheduled. Choose it again on Session Plans, or schedule without a plan.',
    )).toBeInTheDocument();
    expect(screen.queryByText('script_id must name a session plan of this gym')).toBeNull();
  });

  test('CLASS_PLAN_RETIRED shows the server\'s own words', async () => {
    // The words App Overwatch approved (src/server/pilot/schedulerDb.ts:177-179).
    const retired = 'This plan is retired. Bring it back on Session Plans to schedule a class with it.';
    installFetchMock({ posts: [{ ok: false, body: { error: retired, code: 'CLASS_PLAN_RETIRED' } }] });
    arriveWithPlan();
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);
    fillClass();

    await pressSchedule();

    expect(await screen.findByText(retired)).toBeInTheDocument();
  });

  test('without ?plan= nothing changes: no plan read, no plan line, no script_id', async () => {
    const fetchMock = installFetchMock();
    await renderPage();
    await act(async () => {});

    expect(screen.getByText('Schedule New Class')).toBeInTheDocument();
    expect(screen.queryByText('Reading the session plan…')).toBeNull();
    expect(screen.queryByText(/^Session plan:/)).toBeNull();
    expect(screen.queryByText(READ_FAILED)).toBeNull();
    fillClass();
    await pressSchedule();
    expect(creates(fetchMock)[0]).not.toHaveProperty('script_id');
    expect(planReads(fetchMock)).toEqual([]);
  });
});
