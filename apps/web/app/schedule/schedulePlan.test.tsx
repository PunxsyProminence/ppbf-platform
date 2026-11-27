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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

/** GET /api/pilot/admin/staff, one active coach (fake), for the admin's coach picker. */
const STAFF = { members: [{ account_id: 'acct-coach-test-1', role: 'coach', staff_display_name: 'Coach Test' }] };

function installFetchMock(
  options: { role?: string; plan?: (init?: RequestInit) => PlanAnswer; posts?: PlanAnswer[] } = {},
): jest.Mock {
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
    if (url.endsWith('/api/pilot/admin/staff')) return respond({ ok: true, body: STAFF });
    if (url.includes('/api/pilot/session-scripts')) return respond(await (options.plan ?? (() => PLAN_FOUND))(init));
    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
      return respond(await (posts.shift() ?? { ok: true, body: { ok: true, class_ids: ['c-1'] } }));
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

// Reviewers L and M on #2240.
describe('the plan line after review', () => {
  /** The 8-second give-ups the page sets, held instead of run (other timers run as usual). */
  function holdGiveUps(): Array<() => void> {
    const held: Array<() => void> = [];
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 8000) {
        held.push(handler);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, ms, ...rest);
    }) as typeof setTimeout);
    return held;
  }

  /** A read that answers only when it is aborted, as a browser's fetch does. */
  const neverAnswers = (init?: RequestInit) => new Promise<Answer>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => { resolve = settle; });
    return { promise, resolve };
  }

  test('a plan read that never answers gives up after 8 seconds: said not read, Schedule Class works, no plan sent', async () => {
    const giveUps = holdGiveUps();
    const fetchMock = installFetchMock({ plan: neverAnswers });
    arriveWithPlan();
    await renderPage();
    expect(screen.getByText('Reading the session plan…')).toBeInTheDocument();
    fillClass();
    expect(screen.getByRole('button', { name: 'Schedule Class' })).toBeDisabled();
    expect(giveUps).toHaveLength(1);

    await act(async () => {
      giveUps.forEach((giveUp) => giveUp());
    });

    expect(await screen.findByText(READ_FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule Class' })).toBeEnabled();
    await pressSchedule();
    expect(creates(fetchMock)[0]).not.toHaveProperty('script_id');
  });

  test('the read\'s end is said in the same status line, so it is announced', async () => {
    const answer = deferred<Answer>();
    installFetchMock({ plan: () => answer.promise });
    arriveWithPlan();
    await renderPage();
    const line = screen.getByText('Reading the session plan…');
    expect(line).toHaveAttribute('role', 'status');

    await act(async () => {
      answer.resolve(PLAN_FOUND);
    });

    await screen.findByText(`Session plan: ${PLAN_NAME}`);
    expect(line).toHaveTextContent(`Session plan: ${PLAN_NAME}`);
    expect(line).toHaveAttribute('role', 'status');
  });

  test('arriving with a plan brings the form into view: focus on its heading, scrolled to the middle', async () => {
    const scrolled = jest.fn();
    Element.prototype.scrollIntoView = scrolled;
    installFetchMock();
    arriveWithPlan();
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);

    const heading = screen.getByRole('heading', { name: 'Schedule New Class' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(scrolled).toHaveBeenCalledWith({ block: 'center' });
    expect(scrolled.mock.contexts).toContain(heading);
  });

  test('"Schedule without a plan" leaves focus on the form\'s heading, not the page body', async () => {
    Element.prototype.scrollIntoView = jest.fn();
    installFetchMock();
    arriveWithPlan();
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);
    const drop = screen.getByRole('button', { name: 'Schedule without a plan' });
    drop.focus();

    fireEvent.click(drop);

    expect(screen.getByRole('heading', { name: 'Schedule New Class' })).toHaveFocus();
  });

  test('dropping the plan rewrites the address with no history state of Next\'s, so its router sees it', async () => {
    installFetchMock();
    // The history entry Next leaves (its marker skips the router when passed back: app-router.js).
    window.history.pushState({ __NA: true }, '', `/schedule?plan=${encodeURIComponent(PLAN_ID)}`);
    const replace = jest.spyOn(window.history, 'replaceState');
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);

    fireEvent.click(screen.getByRole('button', { name: 'Schedule without a plan' }));

    expect(replace).toHaveBeenCalledWith(null, '', '/schedule');
  });

  test('the id sent is the one the read answered with, beside its name', async () => {
    const fetchMock = installFetchMock({
      plan: () => ({ ok: true, body: { script: { script_id: 'scr-answered-1', name: PLAN_NAME } } }),
    });
    arriveWithPlan();
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);
    fillClass();
    await pressSchedule();
    expect(creates(fetchMock)[0]).toMatchObject({ script_id: 'scr-answered-1' });
  });

  test('a plan answered with a blank name is a plan not read: said so, none sent', async () => {
    const fetchMock = installFetchMock({
      plan: () => ({ ok: true, body: { script: { script_id: PLAN_ID, name: '   ' } } }),
    });
    arriveWithPlan();
    await renderPage();
    expect(await screen.findByText(READ_FAILED)).toBeInTheDocument();
    fillClass();
    await pressSchedule();
    expect(creates(fetchMock)[0]).not.toHaveProperty('script_id');
  });

  test.each([['an admin', 'admin'], ['an organization admin', 'organization_admin']])(
    '%s reads the plan and sends it with the coach chosen',
    async (_who, role) => {
      const fetchMock = installFetchMock({ role });
      arriveWithPlan();
      await renderPage();
      await screen.findByText(`Session plan: ${PLAN_NAME}`);
      fillClass();
      await screen.findByRole('option', { name: 'Coach Test' });
      fireEvent.change(screen.getByLabelText('Class coach'), { target: { value: 'acct-coach-test-1' } });
      await pressSchedule();
      expect(planReads(fetchMock)).toEqual([expect.stringContaining(PLAN_READ_URL)]);
      expect(creates(fetchMock)[0]).toMatchObject({ script_id: PLAN_ID, coach_account_id: 'acct-coach-test-1' });
    },
  );

  test('an answer lost on the way back keeps the plan and the key: the press again is the same request', async () => {
    const fetchMock = installFetchMock({ posts: ['lost'] });
    arriveWithPlan();
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);
    fillClass();
    await pressSchedule();
    expect(screen.getByText(`Session plan: ${PLAN_NAME}`)).toBeInTheDocument();

    await pressSchedule();

    const [first, again] = creates(fetchMock);
    expect(first).toMatchObject({ script_id: PLAN_ID });
    expect(again).toMatchObject({ script_id: PLAN_ID, request_key: first.request_key });
  });

  test('a reload after a lost answer, back on ?plan=, sends the stored key with the plan', async () => {
    window.sessionStorage.setItem('ppbf.schedule.pendingCreateClassKey', 'stored-key-0001');
    const fetchMock = installFetchMock();
    arriveWithPlan();
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);
    fillClass();
    await pressSchedule();
    expect(creates(fetchMock)[0]).toMatchObject({ request_key: 'stored-key-0001', script_id: PLAN_ID });
  });

  test('"Schedule without a plan" is held while Schedule Class is on its way', async () => {
    const answer = deferred<Answer>();
    installFetchMock({ posts: [answer.promise] });
    arriveWithPlan();
    await renderPage();
    await screen.findByText(`Session plan: ${PLAN_NAME}`);
    fillClass();
    await pressSchedule();

    expect(screen.getByRole('button', { name: 'Schedule without a plan' })).toBeDisabled();

    await act(async () => {
      answer.resolve({ ok: true, body: { ok: true, class_ids: ['c-1'] } });
    });
  });
});
