/**
 * @jest-environment jsdom
 */

// BASE-05 Slice 1. The athlete's own attempt log over the existing
// training-attempts ledger. Two things are held here: every request is bound
// to the athlete_id the session handed the component (there is no way to aim
// at another athlete from this surface), and nothing is described as
// recorded that the canonical API did not accept. Cross-athlete refusal is
// the API route's job and is proven there, not by client filtering.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import AthleteAttemptLog from './AthleteAttemptLog';

type Call = { url: string; method: string; body: Record<string, unknown> | null };

let fetchCalls: Call[] = [];
let storedAttempts: Array<Record<string, unknown>> = [];
let listFails = false;
let recordFails = false;
// When set, the list read waits on it: the initial GET stays unresolved
// until the test releases it.
let listGate: Promise<void> | null = null;

function parseBody(init?: RequestInit): Record<string, unknown> | null {
  if (!init?.body || typeof init.body !== 'string') return null;
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 403,
    json: async () => payload,
  } as Response;
}

function attempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organization_id: 'org-1',
    attempt_id: 'att-1',
    athlete_id: 'ath_test',
    athlete_name: 'Test Athlete',
    context_type: 'open_floor',
    context_id: null,
    metric_kind: 'reps',
    direction: 'at_least',
    target_value: '10',
    achieved_value: '8',
    made: false,
    note: 'gassed on the last two',
    attempted_at: '2026-09-07T18:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  fetchCalls = [];
  storedAttempts = [];
  listFails = false;
  recordFails = false;
  listGate = null;

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    fetchCalls.push({ url, method, body: parseBody(init) });

    if (!url.includes('/api/pilot/training-attempts')) {
      throw new Error(`unexpected request: ${method} ${url}`);
    }
    if (method === 'POST') {
      if (recordFails) return jsonResponse({ error: 'Forbidden: athlete cannot access another athlete record' }, false);
      const body = parseBody(init) ?? {};
      const row = attempt({
        attempt_id: `att-${storedAttempts.length + 1}`,
        metric_kind: body.metric_kind,
        target_value: body.target_value == null ? null : String(body.target_value),
        achieved_value: String(body.achieved_value),
        // The verdict is the server's. The stub mimics the module's rule only
        // so the list can show something truthful after a save.
        made: body.target_value == null ? null : Number(body.achieved_value) >= Number(body.target_value),
        note: typeof body.note === 'string' ? body.note : '',
      });
      storedAttempts = [row, ...storedAttempts];
      return jsonResponse({ item: row });
    }
    if (listGate) await listGate;
    if (listFails) return jsonResponse({ error: 'Internal server error' }, false);
    return jsonResponse({ items: storedAttempts });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  jest.resetAllMocks();
});

function listCalls() {
  return fetchCalls.filter((call) => call.method === 'GET');
}

function postCalls() {
  return fetchCalls.filter((call) => call.method === 'POST');
}

async function recordOne(values: { achieved: string; target?: string; note?: string; metric?: string }) {
  if (values.metric) {
    fireEvent.change(screen.getByLabelText(/what you measured/i), { target: { value: values.metric } });
  }
  fireEvent.change(screen.getByLabelText(/what you got/i), { target: { value: values.achieved } });
  if (values.target !== undefined) {
    fireEvent.change(screen.getByLabelText(/target/i), { target: { value: values.target } });
  }
  if (values.note !== undefined) {
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: values.note } });
  }
  fireEvent.click(screen.getByRole('button', { name: /record attempt/i }));
}

describe('AthleteAttemptLog', () => {
  test('loads the athlete\'s own attempts from the canonical API on mount and renders them', async () => {
    storedAttempts = [attempt()];

    render(<AthleteAttemptLog athleteId="ath_test" />);

    await screen.findByText(/gassed on the last two/);
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0].url).toContain('/api/pilot/training-attempts?athlete_id=ath_test');
    expect(screen.getByText(/Missed/)).toBeTruthy();
    expect(screen.getByText(/8 \/ 10 reps/)).toBeTruthy();
  });

  test('renders a truthful empty state when nothing has been recorded', async () => {
    render(<AthleteAttemptLog athleteId="ath_test" />);

    await screen.findByText(/No attempts recorded yet/);
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  test('records an attempt bound to the session athlete_id and never sends a verdict', async () => {
    render(<AthleteAttemptLog athleteId="ath_test" />);
    await screen.findByText(/No attempts recorded yet/);

    await recordOne({ achieved: '8', target: '10', note: 'gassed on the last two' });

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const body = postCalls()[0].body ?? {};
    expect(body.athlete_id).toBe('ath_test');
    expect(body.metric_kind).toBe('reps');
    expect(body.context_type).toBe('open_floor');
    expect(body.achieved_value).toBe(8);
    expect(body.target_value).toBe(10);
    expect(body.note).toBe('gassed on the last two');
    expect(Object.keys(body)).not.toContain('made');
  });

  test('after a successful record the canonical list is re-read and the attempt appears', async () => {
    render(<AthleteAttemptLog athleteId="ath_test" />);
    await screen.findByText(/No attempts recorded yet/);

    await recordOne({ achieved: '12', target: '10' });

    await screen.findByText(/Made/);
    // One read on mount, one after the save: the list is the server's, not a
    // client-side ledger appended to.
    expect(listCalls()).toHaveLength(2);
    expect(screen.queryByText(/No attempts recorded yet/)).toBeNull();
  });

  test('a target-less attempt is shown as a measurement, not a make or a miss', async () => {
    render(<AthleteAttemptLog athleteId="ath_test" />);
    await screen.findByText(/No attempts recorded yet/);

    await recordOne({ achieved: '45', metric: 'time_seconds' });

    await screen.findByText(/Measurement/);
    const body = postCalls()[0].body ?? {};
    expect(body.target_value).toBeNull();
    expect(body.metric_kind).toBe('time_seconds');
  });

  test('a failed read is stated, not hidden behind an empty list', async () => {
    listFails = true;

    render(<AthleteAttemptLog athleteId="ath_test" />);

    await screen.findByText(/Could not load your attempts/);
    expect(screen.queryByText(/No attempts recorded yet/)).toBeNull();
  });

  test('a refused record is stated with the server\'s reason and nothing is described as saved', async () => {
    recordFails = true;

    render(<AthleteAttemptLog athleteId="ath_test" />);
    await screen.findByText(/No attempts recorded yet/);

    await recordOne({ achieved: '8' });

    await screen.findByText(/athlete cannot access another athlete record/);
    expect(screen.queryByText(/Attempt saved/)).toBeNull();
    expect(listCalls()).toHaveLength(1);
  });

  test('refuses to submit without a usable achieved value and sends nothing', async () => {
    render(<AthleteAttemptLog athleteId="ath_test" />);
    await screen.findByText(/No attempts recorded yet/);

    fireEvent.click(screen.getByRole('button', { name: /record attempt/i }));

    await screen.findByText(/Enter what you got/);
    expect(postCalls()).toHaveLength(0);
  });

  test('without a session athlete record it neither reads nor offers to record', async () => {
    render(<AthleteAttemptLog athleteId={null} />);

    await screen.findByText(/not linked to an athlete record/i);
    expect(fetchCalls).toHaveLength(0);
    expect((screen.getByRole('button', { name: /record attempt/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  // D003: the fixed context this surface records in (open_floor) is visible
  // product meaning, not a hidden tag. The athlete can tell what it is for.
  test('tells the athlete this surface records open-floor attempts', async () => {
    render(<AthleteAttemptLog athleteId="ath_test" />);

    await screen.findByText(/No attempts recorded yet/);
    expect(screen.getByText(/open-floor attempts/i)).toBeTruthy();
  });

  // D004: while the initial canonical read is still unresolved, recording is
  // not offered. Otherwise a save's re-read and the delayed mount read race,
  // and whichever lands last is what the athlete sees.
  test('while the initial list read is unresolved, recording is unavailable and no POST can be sent', async () => {
    let releaseList: () => void = () => {};
    listGate = new Promise<void>((resolve) => { releaseList = resolve; });

    render(<AthleteAttemptLog athleteId="ath_test" />);

    await screen.findByText(/Loading your attempts/);
    expect(listCalls()).toHaveLength(1);
    const button = screen.getByRole('button', { name: /record attempt/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect((screen.getByLabelText(/what you got/i) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(postCalls()).toHaveLength(0);

    releaseList();
    await screen.findByText(/No attempts recorded yet/);
    await waitFor(() => expect(button.disabled).toBe(false));

    await recordOne({ achieved: '8', target: '10' });
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0].body?.context_type).toBe('open_floor');
  });
});
