/**
 * @jest-environment jsdom
 */

// Every intake write on this console (upload, case review-action, document
// review, feedback promotion) is refused for a platform owner by the route
// behind it, so the controls must not offer the action.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import AdminShadowConsolePage from './page';
import { usePilotSession, type PilotSessionState } from '@/components/usePilotSession';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: jest.fn(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockUsePilotSession = usePilotSession as jest.Mock;

const originalFetch = global.fetch;

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

function session(role: PilotSessionState['role']): PilotSessionState {
  return {
    role,
    organizationId: 'org-1',
    authProvider: 'microsoft',
    accountId: 'someone@punxsyprominence.org',
    mustChangePin: false,
    loading: false,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const queueEntry = {
  intake_case_id: 'case-1',
  status: 'pending_review' as const,
  summary: 'Board packet intake',
  primary_athlete_id: null,
  created_at: '2026-07-30T12:00:00.000Z',
  updated_at: '2026-07-30T12:00:00.000Z',
  document_count: 1,
};

const feedbackItem = {
  feedback_id: 42,
  account_id: 'athlete-1',
  role: 'athlete',
  helpful: false,
  rating: 2,
  comment: 'Missed the point',
  outcome_signal: 'negative',
  correlation_type: 'shadow_message',
  correlation_id: 'msg-1',
  verification_state: 'durable_client' as const,
  human_review_required: true,
  created_at: '2026-07-30T12:00:00.000Z',
};

function capabilityOff(implemented: boolean) {
  return {
    dataSufficient: false,
    implemented,
    activated: false,
    measuredPerformance: null,
    unavailableReasons: { measuredPerformance: 'NOT_MEASURED' },
  };
}

// Enough of OrgMetrics for the SHADOW Intelligence panel to render its
// readings; the panel binds to the interface by import, so a shape change is a
// compile error rather than a NaN tile.
const growthMetrics = {
  period: 'Last 30 days',
  effectiveness: {
    unavailableReasons: {},
    avgRecommendationScore: 72,
    libraryUtilization: null,
    topicsWithGoodCoverage: [],
    concernedTopics: [],
  },
  engagement: {
    unavailableReasons: {},
    dailyActiveUsers: 4,
    avgMessagesPerSession: null,
    feedbackRate: null,
    usersByTier: { bronze: 1, silver: 0, gold: 0 },
    newUsersThisPeriod: 0,
  },
  safety: {
    unavailableReasons: {},
    highRiskFlagCount: 0,
    escalationsToHuman: 0,
    flaggedTopicsNeedingReview: [],
  },
  growth: {
    unavailableReasons: {},
    avgComplexityProgression: null,
    profileCompletionRate: null,
    tierAdvancementCount: null,
    totalInteractions: 88,
    reviewedHelpfulRate: null,
    filterRate: 0.125,
    avgSatisfaction: null,
    reviewedOutcomes: 3,
    researchRequirementsCreated: 2,
    researchRequirementsClosed: 1,
    newLibrarySources: 0,
  },
  viewerUnlocks: {
    strongPersonalization: capabilityOff(true),
    autoLibraryUpdates: capabilityOff(true),
    aggressiveResearchGeneration: capabilityOff(false),
    fineTuningPipeline: capabilityOff(false),
  },
};

const feedbackSummary = {
  total_responses: 12,
  helpful_count: 9,
  satisfaction_rate: 0.75,
  avg_rating: null,
};

// `reads` replaces the answer for any route whose URL contains the key, so a
// test can fail exactly one read and leave the rest of the console loading.
type ReadOverrides = Record<string, () => Promise<Response>>;

function consoleFetchMock({ withMetrics = false, reads = {} as ReadOverrides } = {}) {
  return jest.fn(async (url: string) => {
    const target = String(url);
    for (const [fragment, answer] of Object.entries(reads)) {
      if (target.includes(fragment)) return answer();
    }
    if (target.includes('/shadow/review-projection')) {
      return jsonResponse({ ok: true, queue: [queueEntry] });
    }
    if (target.includes('/shadow/metrics')) {
      return jsonResponse({ ok: true, metrics: withMetrics ? growthMetrics : null });
    }
    if (target.includes('/shadow/feedback')) {
      return jsonResponse({
        ok: true,
        summary: withMetrics ? feedbackSummary : null,
        items: [feedbackItem],
      });
    }
    if (target.includes('/shadow/telemetry')) {
      return jsonResponse({ ok: true, telemetry: [] });
    }
    if (target.includes('/shadow/authority')) {
      return jsonResponse({ ok: true, authority_checks: [] });
    }
    if (target.includes('/shadow/library/review-flags')) {
      return jsonResponse({ ok: true, flags: [] });
    }
    if (target.includes('/shadow/unlocks')) {
      return jsonResponse({ ok: true, thresholds: [], state: { features: {} } });
    }
    return jsonResponse({ ok: true, metrics: null });
  });
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderConsole(role: PilotSessionState['role'], options?: { withMetrics: boolean }) {
  const fetchMock = consoleFetchMock(options);
  mockUsePilotSession.mockReturnValue(session(role));
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<AdminShadowConsolePage />);
  await screen.findByText(/Board packet intake/);
  return fetchMock;
}

// The gym-only reads on this console refuse the platform owner
// (OD-2026-10-10-004 ruling 3; OD-2026-10-08-003): their panels are not drawn
// and their requests are not sent. What it may still read stays.
const GYM_ONLY_READS = ['/shadow/authority', '/shadow/review-projection', '/shadow/metrics', '/shadow/unlocks'];
const SHARED_READS = ['/shadow/telemetry', '/shadow/feedback', '/shadow/library/review-flags'];

function callsTo(fetchMock: jest.Mock, fragment: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment));
}

async function renderPlatformOwnerConsole() {
  const fetchMock = consoleFetchMock();
  mockUsePilotSession.mockReturnValue(session('platform_owner'));
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<AdminShadowConsolePage />);
  for (const fragment of SHARED_READS) {
    await waitFor(() => expect(callsTo(fetchMock, fragment).length).toBeGreaterThan(0));
  }
  return fetchMock;
}

it('sends a platform owner none of the gym-only reads and draws none of their panels', async () => {
  const fetchMock = await renderPlatformOwnerConsole();

  for (const fragment of GYM_ONLY_READS) {
    expect(callsTo(fetchMock, fragment)).toHaveLength(0);
  }
  expect(screen.queryByText(/SHADOW Intelligence/)).toBeNull();
  expect(screen.queryByText('Feature Unlock Thresholds')).toBeNull();
  expect(screen.queryByText('PENDING IMPORT QUEUE')).toBeNull();
  expect(screen.queryByText(/Board packet intake/)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /show telemetry stream/i }));
  expect(screen.queryByText('SHADOW authority read model')).toBeNull();
  expect(screen.getByText('SHADOW telemetry read model')).toBeTruthy();
});

it('offers no intake write control to a platform owner', async () => {
  const fetchMock = await renderPlatformOwnerConsole();

  expect(screen.queryByRole('button', { name: /upload pdf/i })).toBeNull();
  expect(screen.getAllByText(/read-only in a platform-owner session/i).length).toBeGreaterThan(0);
  expect((screen.getByRole('button', { name: /approve for learning/i }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: /document security review/i })).toBeNull();
  for (const action of ['APPROVE', 'REJECT', 'IMPORT']) {
    expect(screen.queryByRole('button', { name: action })).toBeNull();
  }

  // No queue is read or drawn for this role, so no row can be selected and
  // the review keys have nothing to act on; nothing reaches the review route.
  expect(callsTo(fetchMock, '/intake/review-action')).toHaveLength(0);
  expect(screen.getByRole('link', { name: 'Platform Desk' }).getAttribute('href')).toBe('/admin/platform');
});

it('asks nothing while the session is still being read', async () => {
  const fetchMock = consoleFetchMock();
  mockUsePilotSession.mockReturnValue({ ...session(null), loading: true });
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<AdminShadowConsolePage />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // Not even the console's shared reads: it starts once, when the role is
  // known. (The library review-flags panel reads on its own; that is shared.)
  for (const fragment of [...GYM_ONLY_READS, '/shadow/telemetry', '/shadow/feedback']) {
    expect(callsTo(fetchMock, fragment)).toHaveLength(0);
  }
});

it.each(['organization_admin', 'admin'] as const)('%s keeps every read and every panel', async (role) => {
  const fetchMock = await renderConsole(role, { withMetrics: true });

  for (const fragment of [...GYM_ONLY_READS, ...SHARED_READS]) {
    await waitFor(() => expect(callsTo(fetchMock, fragment).length).toBeGreaterThan(0));
  }
  await screen.findByText(/SHADOW Intelligence/);
  await screen.findByText('Feature Unlock Thresholds');
  expect(screen.getByText('PENDING IMPORT QUEUE')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /show telemetry and authority streams/i }));
  expect(screen.getByText('SHADOW authority read model')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Capabilities' }).getAttribute('href')).toBe('/admin');
});

it('leaves the intake write controls to a gym admin', async () => {
  await renderConsole('organization_admin');

  await waitFor(() => expect(screen.getByRole('button', { name: /upload pdf/i })).toBeTruthy());
  expect(screen.queryByText(/read-only in a platform-owner session/i)).toBeNull();
  expect((screen.getByRole('button', { name: 'APPROVE' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: /approve for learning/i }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole('button', { name: /document security review/i })).toBeTruthy();
});

// ── After Hours room DNA ────────────────────────────────────────────────────

it('reads its rates off the room instrument and its counts off .stat', async () => {
  await renderConsole('organization_admin', { withMetrics: true });

  await waitFor(() => expect(document.querySelectorAll('.gauge-bezel').length).toBeGreaterThan(0));

  const captions = [...document.querySelectorAll('.gauge-cap')].map((node) => node.textContent);
  expect(captions).toContain('Filter Rate');
  expect(captions).toContain('Satisfaction');

  const values = [...document.querySelectorAll('.gauge-val')].map((node) => node.textContent);
  expect(values).toContain('12.5%');
  expect(values).toContain('75.0%');

  // Law 2: the red band is only for a reading with a genuine danger threshold,
  // and nothing server-side defines one for these rates.
  expect(document.querySelector('.gauge-arc')).toBeNull();

  // Counts are figures, not dials.
  const statLabels = [...document.querySelectorAll('.stat-label')].map((node) => node.textContent);
  expect(statLabels).toContain('Interactions');
  expect(statLabels).toContain('Research Created');
  // The count is new rows on the Library's sources shelf, not patterns.
  expect(statLabels).toContain('New Library Sources');
  expect(statLabels).not.toContain('New Patterns');
  expect(document.querySelectorAll('.stat-val').length).toBeGreaterThan(0);
});

it('wears the slate instrument panel, not the Front Office rivets', async () => {
  await renderConsole('organization_admin');

  expect(await screen.findByText('SHADOW Data Intake + Command Console')).toBeTruthy();
  expect(document.querySelector('.rivet')).toBeNull();
  expect(document.querySelector('.frame')).toBeNull();
  expect(document.querySelectorAll('.mat-slate').length).toBeGreaterThan(0);
});

// ── A failed read is not zero ───────────────────────────────────────────────
//
// Each list on this console used to answer a failed read with its own empty
// state: the catch emptied the array (or nothing caught at all) and the render
// counted it. These pin, per list, that a read which did not come back says
// "unavailable" -- no empty sentence and no zero -- and that a read which came
// back empty still says so.

const notOk = async () => jsonResponse({ error: 'Database unavailable' }, false, 500);
const rejects = async (): Promise<Response> => {
  throw new Error('network down');
};
const unparseable = async () =>
  ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }) as unknown as Response;
const FAILED_READS: Array<[string, () => Promise<Response>]> = [
  ['answers non-ok', notOk],
  ['rejects', rejects],
  ['answers 200 with a body that will not parse', unparseable],
];

function renderConsoleWith(reads: ReadOverrides) {
  const fetchMock = consoleFetchMock({ reads });
  mockUsePilotSession.mockReturnValue(session('organization_admin'));
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<AdminShadowConsolePage />);
  return fetchMock;
}

function pageText() {
  return document.body.textContent ?? '';
}

function runCommand(command: string) {
  fireEvent.change(screen.getByPlaceholderText(/merge \| status \| list/), { target: { value: command } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit Command' }));
}

const INTAKE_UNAVAILABLE =
  'The intake queue could not be loaded. The list is unavailable, not empty. Reload to retry.';
const INTAKE_EMPTY = 'No pending intake items. Use Upload File or Quick Add to create staging entries.';

describe('the intake queue', () => {
  it.each(FAILED_READS)('says unavailable, never zero or empty, when the read %s', async (_label, read) => {
    renderConsoleWith({ '/shadow/review-projection': read });

    expect(await screen.findByText(INTAKE_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByText(INTAKE_EMPTY)).toBeNull();
    expect(pageText()).toContain('Pending: unavailable');
    expect(pageText()).toContain('Approved: unavailable');
    expect(pageText()).not.toContain('Pending: 0');
    expect(pageText()).not.toContain('Approved: 0');
  });

  it.each(FAILED_READS)('answers the typed commands without claiming an empty queue when the read %s', async (_label, read) => {
    renderConsoleWith({ '/shadow/review-projection': read });
    await screen.findByText(INTAKE_UNAVAILABLE);

    runCommand('status');
    await screen.findByText(/MESSAGE: Queue=unavailable/);
    expect(pageText()).not.toContain('Queue=0');

    runCommand('list');
    await screen.findByText(/STATUS: List/);
    expect(pageText()).not.toContain('No pending intake items in queue.');

    runCommand('summarize');
    await screen.findByText(/STATUS: Summary/);
    expect(pageText()).not.toContain('0 pending item(s)');
    expect(pageText()).not.toMatch(/Queue status: \d/);
  });

  it('still says the queue is empty, and counts zero, when the read came back empty', async () => {
    renderConsoleWith({ '/shadow/review-projection': async () => jsonResponse({ ok: true, queue: [] }) });

    expect(await screen.findByText(INTAKE_EMPTY)).toBeTruthy();
    expect(pageText()).toContain('Pending: 0');
    expect(pageText()).toContain('Approved: 0');
    expect(screen.queryByText(INTAKE_UNAVAILABLE)).toBeNull();

    runCommand('status');
    await screen.findByText(/MESSAGE: Queue=0 /);
    runCommand('list');
    await screen.findByText(/MESSAGE: No pending intake items in queue\./);
    runCommand('summarize');
    await screen.findByText(/MESSAGE: Queue status: 0 pending item\(s\)/);
  });

  it('does not print the empty sentence before the first read has answered', async () => {
    let release: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    renderConsoleWith({ '/shadow/review-projection': () => held });

    expect(await screen.findByText('Loading intake queue…')).toBeTruthy();
    expect(screen.queryByText(INTAKE_EMPTY)).toBeNull();
    expect(pageText()).not.toContain('Pending: 0');

    release(jsonResponse({ ok: true, queue: [] }));
    expect(await screen.findByText(INTAKE_EMPTY)).toBeTruthy();
  });

  // The read runs again after every upload, review action and promotion. The
  // state is set by the read itself, so a re-read that fails cannot leave the
  // earlier count and rows standing as if they were the queue.
  it('says unavailable, and refuses the review keys, when a re-read after an upload fails', async () => {
    let queueReads = 0;
    const fetchMock = renderConsoleWith({
      '/shadow/review-projection': async () => {
        queueReads += 1;
        return queueReads > 1 ? notOk() : jsonResponse({ ok: true, queue: [queueEntry] });
      },
      '/shadow/upload': async () =>
        jsonResponse({
          ok: true,
          intake_case_id: 'case-2',
          classification: 'general',
          routed_queue: 'admin',
          document_type: 'general_intake',
        }),
    });
    await screen.findByText(/Board packet intake/);
    expect(pageText()).toContain('Pending: 1');

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['%PDF'], 'waiver.pdf', { type: 'application/pdf' })] } });

    expect(await screen.findByText(INTAKE_UNAVAILABLE)).toBeTruthy();
    expect(pageText()).toContain('Pending: unavailable');
    expect(pageText()).not.toMatch(/Pending: \d/);
    expect(screen.queryByRole('button', { name: 'APPROVE' })).toBeNull();
    expect(queueReads).toBe(2);

    // The upload left its row selected and in memory. With the list gone, the
    // keys and the typed commands are refused in words, before any write is
    // launched. (A refusal that threw instead would fail this test: jest
    // fails on the unhandled rejection.)
    const refusals = () => (pageText().match(/blocked: backend review queue is unavailable\./g) ?? []).length;
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(refusals()).toBe(1));
    fireEvent.keyDown(window, { key: 'r' });
    await waitFor(() => expect(refusals()).toBe(2));
    fireEvent.keyDown(window, { key: 'i' });
    await waitFor(() => expect(refusals()).toBe(3));
    expect(pageText()).toContain('MESSAGE: Promotion blocked: backend review queue is unavailable.');
    runCommand('approve');
    await waitFor(() => expect(refusals()).toBe(4));
    runCommand('reject');
    await waitFor(() => expect(refusals()).toBe(5));
    expect(pageText()).toContain('MESSAGE: Review action blocked: backend review queue is unavailable.');

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/intake/review-action'))).toBe(false);
    expect(queueReads).toBe(2);
  });
});

const FEEDBACK_UNAVAILABLE =
  'Feedback awaiting review could not be loaded. The list is unavailable, not empty. Refresh to retry.';
const FEEDBACK_EMPTY = 'No feedback is awaiting human review.';

describe('the feedback review queue', () => {
  it.each(FAILED_READS)('says unavailable, never zero or empty, when the read %s', async (_label, read) => {
    renderConsoleWith({ '/shadow/feedback': read });

    expect(await screen.findByText(FEEDBACK_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByText(FEEDBACK_EMPTY)).toBeNull();
    expect(pageText()).not.toMatch(/Awaiting review \(\d+\)/);
  });

  it('still says nothing is awaiting review when the read came back empty', async () => {
    renderConsoleWith({ '/shadow/feedback': async () => jsonResponse({ ok: true, summary: null, items: [] }) });

    expect(await screen.findByText(FEEDBACK_EMPTY)).toBeTruthy();
    expect(pageText()).toContain('Awaiting review (0)');
    expect(screen.queryByText(FEEDBACK_UNAVAILABLE)).toBeNull();
  });

  it('drops the list it had when a later Refresh fails', async () => {
    let fail = false;
    renderConsoleWith({
      '/shadow/feedback': async () =>
        fail ? notOk() : jsonResponse({ ok: true, summary: null, items: [feedbackItem] }),
    });
    await screen.findByText('Missed the point');
    expect(pageText()).toContain('Awaiting review (1)');

    fail = true;
    // The Learning Review panel is the first panel with a Refresh lever.
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh' })[0]);

    expect(await screen.findByText(FEEDBACK_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByText('Missed the point')).toBeNull();
    expect(pageText()).not.toMatch(/Awaiting review \(\d+\)/);

    // And comes back, with its count, once a read answers again.
    fail = false;
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh' })[0]);

    expect(await screen.findByText('Missed the point')).toBeTruthy();
    expect(pageText()).toContain('Awaiting review (1)');
    expect(screen.queryByText(FEEDBACK_UNAVAILABLE)).toBeNull();
  });
});

const TELEMETRY_UNAVAILABLE = 'SHADOW telemetry could not be loaded. Unavailable, not empty.';
const AUTHORITY_UNAVAILABLE = 'SHADOW authority checks could not be loaded. Unavailable, not empty.';
const TELEMETRY_EMPTY = 'No SHADOW telemetry events returned.';
const AUTHORITY_EMPTY = 'No SHADOW authority checks returned.';

async function openStreams() {
  await screen.findByText(/Board packet intake/);
  fireEvent.click(screen.getByRole('button', { name: /telemetry and authority streams/ }));
}

describe('the telemetry and authority streams', () => {
  it.each(FAILED_READS)('says telemetry is unavailable, not "none returned", when its read %s', async (_label, read) => {
    renderConsoleWith({ '/shadow/telemetry': read });
    await openStreams();

    expect(await screen.findByText(TELEMETRY_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByText(TELEMETRY_EMPTY)).toBeNull();
  });

  it.each(FAILED_READS)('says authority checks are unavailable, not "none returned", when their read %s', async (_label, read) => {
    renderConsoleWith({ '/shadow/authority': read });
    await openStreams();

    expect(await screen.findByText(AUTHORITY_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByText(AUTHORITY_EMPTY)).toBeNull();
  });

  it('keeps the stream that did answer when only the other one is refused', async () => {
    renderConsoleWith({ '/shadow/telemetry': notOk });
    await openStreams();

    expect(await screen.findByText(TELEMETRY_UNAVAILABLE)).toBeTruthy();
    expect(await screen.findByText(AUTHORITY_EMPTY)).toBeTruthy();
    expect(screen.queryByText(AUTHORITY_UNAVAILABLE)).toBeNull();
  });

  it('still says none were returned when both reads came back empty', async () => {
    renderConsoleWith({});
    await openStreams();

    expect(await screen.findByText(TELEMETRY_EMPTY)).toBeTruthy();
    expect(await screen.findByText(AUTHORITY_EMPTY)).toBeTruthy();
    expect(screen.queryByText(TELEMETRY_UNAVAILABLE)).toBeNull();
    expect(screen.queryByText(AUTHORITY_UNAVAILABLE)).toBeNull();
  });
});

// A body that parses is not yet a read. Each list takes its answer only when
// the application says ok AND the list is actually in it; `{ ok: false, <list>:
// [] }` and `{ ok: true }` used to be taken as "loaded, and empty".
describe('a 200 that parses but is not the list', () => {
  interface ListUnderTest {
    route: string;
    key: string;
    unavailable: string;
    empty: string;
    // The zero this list would print if the body were taken as loaded-empty.
    zero: RegExp | null;
    behindLever: boolean;
  }
  const lists: Array<[string, ListUnderTest]> = [
    ['intake queue', { route: '/shadow/review-projection', key: 'queue', unavailable: INTAKE_UNAVAILABLE, empty: INTAKE_EMPTY, zero: /Pending: \d/, behindLever: false }],
    ['feedback review queue', { route: '/shadow/feedback', key: 'items', unavailable: FEEDBACK_UNAVAILABLE, empty: FEEDBACK_EMPTY, zero: /Awaiting review \(\d+\)/, behindLever: false }],
    ['telemetry stream', { route: '/shadow/telemetry', key: 'telemetry', unavailable: TELEMETRY_UNAVAILABLE, empty: TELEMETRY_EMPTY, zero: null, behindLever: true }],
    ['authority stream', { route: '/shadow/authority', key: 'authority_checks', unavailable: AUTHORITY_UNAVAILABLE, empty: AUTHORITY_EMPTY, zero: null, behindLever: true }],
  ];
  const shapes: Array<[string, (key: string) => unknown]> = [
    ['ok:false with an empty list present', (key) => ({ ok: false, [key]: [] })],
    ['ok:true with the list absent', () => ({ ok: true })],
    // The two halves are exact: only `true` is ok, and only an array is a list.
    ['a truthy ok that is not true, with an empty list', (key) => ({ ok: 1, [key]: [] })],
    ['ok:true with an object where the list should be', (key) => ({ ok: true, [key]: {} })],
    ['a null body', () => null],
  ];
  const cases = lists.flatMap(([name, list]) =>
    shapes.map(([shape, body]) => [name, shape, list, body] as const),
  );

  it.each(cases)('%s is unavailable, never empty or zero, for %s', async (_name, _shape, list, body) => {
    renderConsoleWith({ [list.route]: async () => jsonResponse(body(list.key)) });
    if (list.behindLever) {
      fireEvent.click(await screen.findByRole('button', { name: /telemetry and authority streams/ }));
    }

    expect(await screen.findByText(list.unavailable)).toBeTruthy();
    expect(screen.queryByText(list.empty)).toBeNull();
    if (list.zero) expect(pageText()).not.toMatch(list.zero);
  });

  it.each(shapes)('review flags heading carries no count for %s', async (_shape, body) => {
    renderConsoleWith({ '/shadow/library/review-flags': async () => jsonResponse(body('flags')) });
    await screen.findByText(/Board packet intake/);

    await waitFor(() => expect(screen.queryByText('Loading flags…')).toBeNull());
    expect(screen.getByRole('heading', { name: /Review Flags/ }).textContent).toBe('Review Flags');
    expect(screen.queryByText(/No pending flags\./)).toBeNull();
    expect(screen.getByText('Failed to load library review flags')).toBeTruthy();
  });
});

describe('the library review flags heading', () => {
  it.each(FAILED_READS)('carries no count when the read %s', async (_label, read) => {
    renderConsoleWith({ '/shadow/library/review-flags': read });
    await screen.findByText(/Board packet intake/);

    await waitFor(() => expect(screen.queryByText('Loading flags…')).toBeNull());
    expect(screen.getByRole('heading', { name: /Review Flags/ }).textContent).toBe('Review Flags');
    expect(pageText()).not.toContain('Review Flags (0)');
    expect(screen.queryByText(/No pending flags\./)).toBeNull();
  });

  it('counts zero when the read came back empty', async () => {
    renderConsoleWith({});

    expect(await screen.findByText(/No pending flags\./)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Review Flags/ }).textContent).toBe('Review Flags (0)');
  });
});

describe('the console names itself and reads its dials honestly (F-024)', () => {
  it('has one page heading', async () => {
    await renderConsole('organization_admin');

    expect(screen.getByRole('heading', { level: 1, name: 'SHADOW Admin Console' })).toBeTruthy();
  });

  it('says no outcome was reviewed, not "Unavailable", when that is the reason there is no effectiveness score', async () => {
    const noReviews = {
      ...growthMetrics,
      effectiveness: {
        ...growthMetrics.effectiveness,
        avgRecommendationScore: null,
        unavailableReasons: { avgRecommendationScore: 'NO_HUMAN_REVIEWED_OUTCOMES_IN_PERIOD' },
      },
    };
    renderConsoleWith({ '/shadow/metrics': async () => jsonResponse({ ok: true, metrics: noReviews }) });

    expect(await screen.findByText('No reviewed outcomes yet')).toBeTruthy();
    const effectivenessGauge = screen.getByText('Effectiveness').closest('.gauge');
    expect(effectivenessGauge?.textContent).not.toContain('Unavailable');
  });
});

describe('the feature unlock panel reports each fact on its own (L46 item 13)', () => {
  const fineTuningThreshold = {
    featureKey: 'fine_tuning_pipeline',
    metricKey: 'org_labeled_training_examples',
    minValue: 500,
    activationMode: 'enabled',
    description: 'Disabled until an approved training-data process exists.',
  };

  it('says a switched-on, counter-met fine-tuning pipeline is not built, not on and not measured', async () => {
    renderConsoleWith({
      '/shadow/unlocks': async () => jsonResponse({
        ok: true,
        thresholds: [fineTuningThreshold],
        state: {
          features: {
            fine_tuning_pipeline: {
              unlocked: false,
              activationMode: 'enabled',
              satisfied: true,
              implemented: false,
              measuredPerformance: null,
              currentValue: 600,
              thresholdValue: 500,
            },
          },
        },
      }),
    });

    expect(await screen.findByText('Not built: the app has no fine-tuning code.')).toBeTruthy();
    expect(screen.getByText('Reviewed feedback with a message (not training data)')).toBeTruthy();
    expect(pageText()).toContain('Enough data: yes (600 / 500) \u00b7 Built: no \u00b7 On: no \u00b7 Measured: not measured');
    // The raw counter key no longer stands in for what it counts.
    expect(pageText()).not.toContain('org_labeled_training_examples: 600');
    expect(pageText()).not.toContain('Counter has not reached the threshold.');
  });
});

describe('the feature unlock panel says what Library proposals do to the concern list', () => {
  it('notes it on the auto_library_updates row', async () => {
    renderConsoleWith({
      '/shadow/unlocks': async () => jsonResponse({
        ok: true,
        thresholds: [{
          featureKey: 'auto_library_updates',
          metricKey: 'org_recommendation_outcomes',
          minValue: 40,
          activationMode: 'observation',
          description: 'Enable automatic promote/demote updates.',
        }],
        state: {
          features: {
            auto_library_updates: {
              unlocked: false,
              activationMode: 'observation',
              satisfied: false,
              implemented: true,
              measuredPerformance: null,
              currentValue: 3,
              thresholdValue: 40,
            },
          },
        },
      }),
    });

    expect(await screen.findByText('With proposals on, a pending promote can keep a topic off the concern list until a curator acts.')).toBeTruthy();
  });
});
