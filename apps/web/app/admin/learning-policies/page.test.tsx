/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  APPROVED_CITATIONS_V1,
  APPROVED_OBSERVER_CALIBRATION_V1,
  APPROVED_PATTERN_FORMATION_V1,
} from '@/src/server/pilot/learningPolicyApprovedV1';

import LearningBarsPage from './page';

/**
 * THE LEARNING BARS (PATTERN-1c, PunxsyProminence/ppbf-platform#2082).
 *
 * Staff read the approved bars, their sources and what is in force. Only the
 * gym's organization admin signed in with Microsoft is offered "Put in force"
 * (OD-2026-10-18-003), and it sends the approved bar exactly as approved. A
 * failed read never reads as "not in force".
 */

let session = { loading: false, role: 'organization_admin', authProvider: 'microsoft' } as Record<string, unknown>;

jest.mock('@/components/usePilotSession', () => ({
  usePilotSession: () => session,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/BackHome', () => ({
  __esModule: true,
  default: () => null,
}));

const KINDS = ['pattern_formation', 'athlete_lesson', 'observer_calibration'] as const;
const TITLES: Record<(typeof KINDS)[number], string> = {
  pattern_formation: 'Pattern labels',
  athlete_lesson: 'Lesson results',
  observer_calibration: 'Coach calibration',
};

function respond(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 403, json: () => Promise.resolve(body) } as Response);
}

let fetchMock: jest.Mock;
function withPolicies(policies: unknown[]) {
  fetchMock = jest.fn((url: string, init?: RequestInit) => (init?.method === 'POST'
    ? respond({ ok: true, policy: {} })
    : respond({ ok: true, policies })));
  global.fetch = fetchMock as unknown as typeof fetch;
}

const section = (kind: (typeof KINDS)[number]) => screen.getByRole('region', { name: TITLES[kind] });

beforeEach(() => {
  session = { loading: false, role: 'organization_admin', authProvider: 'microsoft' };
  withPolicies([]);
});

describe('reading the bars', () => {
  test('each of the three approved bars is shown with its cited sources, and nothing in force says so', async () => {
    render(<LearningBarsPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Learning Bars' })).toBeInTheDocument();
    for (const kind of KINDS) {
      const region = await waitFor(() => section(kind));
      expect(within(region).getByText('Not in force')).toBeInTheDocument();
      for (const citation of APPROVED_CITATIONS_V1[kind]) {
        expect(within(region).getByText(citation.source)).toBeInTheDocument();
      }
    }
    expect(within(section('pattern_formation')).getByText(/Pattern: 5\+ sessions/)).toBeInTheDocument();
    expect(within(section('observer_calibration')).getByText(/30\+ paired judgments/)).toBeInTheDocument();
  });

  test('a bar in force shows its version, and offers no second "Put in force"', async () => {
    withPolicies([{
      policy_id: 'p-2', policy_kind: 'pattern_formation', version: 2, status: 'active',
      ratified_at: '2026-11-20T15:00:00.000Z', parameters: APPROVED_PATTERN_FORMATION_V1, citations: [],
    }]);
    render(<LearningBarsPage />);
    const region = await waitFor(() => section('pattern_formation'));
    await waitFor(() => expect(within(region).getByText(/In force: version 2/)).toBeInTheDocument());
    expect(within(region).queryByRole('button', { name: /Put in force/ })).toBeNull();
    expect(within(section('athlete_lesson')).getByRole('button', { name: /Put in force/ })).toBeInTheDocument();
  });

  test('a failed read says the bars could not be read, and never "Not in force"', async () => {
    fetchMock = jest.fn(() => respond({ ok: false, error: 'Forbidden: role not allowed' }, false));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<LearningBarsPage />);
    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(screen.getByText(/Forbidden: role not allowed/)).toBeInTheDocument();
    expect(screen.queryByText('Not in force')).toBeNull();
    expect(screen.queryByRole('button', { name: /Put in force/ })).toBeNull();
  });
});

describe('who may put a bar in force (OD-2026-10-18-003)', () => {
  test.each([
    ['a coach', { role: 'coach', authProvider: 'microsoft' }],
    ['an organization admin on a PIN sign-in', { role: 'organization_admin', authProvider: 'ppbf_local' }],
    ['the legacy admin role', { role: 'admin', authProvider: 'microsoft' }],
  ])('%s reads the bars and is offered no button, only who can', async (_label, who) => {
    session = { loading: false, ...who };
    render(<LearningBarsPage />);
    await waitFor(() => expect(within(section('pattern_formation')).getByText('Not in force')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Put in force/ })).toBeNull();
    expect(screen.getByText(/Only the gym's organization admin, signed in with Microsoft/)).toBeInTheDocument();
  });

  test('the organization admin on Microsoft confirms, and the approved bar is sent exactly as approved', async () => {
    render(<LearningBarsPage />);
    const region = await waitFor(() => section('observer_calibration'));
    fireEvent.click(await within(region).findByRole('button', { name: 'Put in force' }));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    fireEvent.click(within(region).getByRole('button', { name: 'Yes, put Coach calibration in force' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
    const [url, init] = fetchMock.mock.calls.find(([, call]) => call?.method === 'POST')!;
    expect(String(url)).toMatch(/\/api\/pilot\/admin\/learning-policies$/);
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'observer_calibration',
      parameters: APPROVED_OBSERVER_CALIBRATION_V1,
      citations: APPROVED_CITATIONS_V1.observer_calibration,
    });
    // The list is read again after the save.
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, call]) => call?.method !== 'POST')).toHaveLength(2));
  });

  test('cancel sends nothing', async () => {
    render(<LearningBarsPage />);
    const region = await waitFor(() => section('athlete_lesson'));
    fireEvent.click(await within(region).findByRole('button', { name: 'Put in force' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Cancel' }));
    expect(within(region).getByRole('button', { name: 'Put in force' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  test('a refused save shows the server\'s reason', async () => {
    fetchMock = jest.fn((url: string, init?: RequestInit) => (init?.method === 'POST'
      ? respond({ ok: false, error: 'Only an admin of this gym can ratify a bar.' }, false)
      : respond({ ok: true, policies: [] })));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<LearningBarsPage />);
    const region = await waitFor(() => section('pattern_formation'));
    fireEvent.click(await within(region).findByRole('button', { name: 'Put in force' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Yes, put Pattern labels in force' }));
    expect(await within(region).findByText(/Only an admin of this gym can ratify a bar/)).toBeInTheDocument();
  });
});

describe('review fixes on #2102', () => {
  test('the summary carries the observer rules and reads minimums as minimums', async () => {
    render(<LearningBarsPage />);
    const pattern = await waitFor(() => section('pattern_formation'));
    expect(within(pattern).getByText(/Pattern: 5\+ sessions, 80%\+ of at least 8 chances.*2\+ coaches, or 20%\+ of sessions double-coded/))
      .toBeInTheDocument();
    expect(within(pattern).getByText(/Established: .*2\+ calibrated coaches, each 3\+ sessions, agreeing/)).toBeInTheDocument();
    expect(within(section('observer_calibration')).getByText(/below the bar, its notes stop counting/i)).toBeInTheDocument();
  });

  test('every number the admin puts in force is listed, taken from the bar itself', async () => {
    render(<LearningBarsPage />);
    const lesson = await waitFor(() => section('athlete_lesson'));
    expect(within(lesson).getByText('effectRule.shiftSd: 0.25')).toBeInTheDocument();
    expect(within(lesson).getByText('followUpWeeks: 1, 4, 12')).toBeInTheDocument();
    expect(within(section('observer_calibration')).getByText('belowBar: stop_counting')).toBeInTheDocument();
    expect(within(section('pattern_formation')).getByText('tiers.pattern.observers.orDoubleCodedShare: 0.2')).toBeInTheDocument();
  });

  test('a save in flight says so and locks every button; once saved, the bar reads in force at once', async () => {
    let finishSave: (value: Response) => void = () => {};
    fetchMock = jest.fn((url: string, init?: RequestInit) => (init?.method === 'POST'
      ? new Promise<Response>((resolve) => { finishSave = resolve; })
      : (fetchMock.mock.calls.length > 2 ? new Promise<Response>(() => {}) : respond({ ok: true, policies: [] }))));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<LearningBarsPage />);
    const region = await waitFor(() => section('pattern_formation'));
    fireEvent.click(await within(region).findByRole('button', { name: 'Put in force' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Yes, put Pattern labels in force' }));
    expect(await within(region).findByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(within(section('athlete_lesson')).getByRole('button', { name: 'Put in force' })).toBeDisabled();
    finishSave({ ok: true, status: 201, json: () => Promise.resolve({ ok: true, policy: {
      policy_kind: 'pattern_formation', version: 1, status: 'active', ratified_at: '2026-11-22T16:00:00.000Z',
    } }) } as Response);
    // The reload never answers here: the saved version shows anyway, and no second "Put in force".
    expect(await within(region).findByText(/In force: version 1/)).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: /Put in force/ })).toBeNull();
  });

  test('a reply that is not JSON reads as "could not be read", not as a parser error', async () => {
    fetchMock = jest.fn(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('Unexpected token <')) } as Response));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<LearningBarsPage />);
    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(screen.queryByText(/Unexpected token/)).toBeNull();
  });

  test('while the first read is on its way, the page says so', () => {
    fetchMock = jest.fn(() => new Promise<Response>(() => {}));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<LearningBarsPage />);
    expect(screen.getByText('Reading the bars…')).toBeInTheDocument();
    expect(screen.queryByText('Not in force')).toBeNull();
  });
});
