/**
 * @jest-environment jsdom
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import BehaviourSampleWindow from './BehaviourSampleWindow';

// The coach's sampled-window screen for gym tablets (PATTERN-1f). The routes decide who may do
// what (behaviour-windows route suites and behaviourSampleWindows.pg.test.ts); this suite asserts
// what the screen sends and shows: one athlete, one window, the coach's own taps only, and nothing
// it does not know.

const KEYS = '/api/pilot/coach/behaviour-keys';
const WINDOWS = '/api/pilot/coach/behaviour-windows';
const NAMES = [
  { behaviour_key: 'k_drop', label: 'Drops the lead hand after the jab', status: 'active' },
  { behaviour_key: 'k_old', label: 'An old name', status: 'retired' },
];
const OPEN_ROW = {
  window_id: 'win-1', athlete_id: 'ath-1', behaviour_key: 'k_drop', run_id: 'run 1', context_kind: 'context',
  context_id: 'session', task_constraint: 'controlled', chances: 10, closed_at: null,
};

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Call { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[];

/** Answers by method and path; a handler returning undefined is a route this test does not expect. */
function serve(handler: (call: Call) => Response | Promise<Response> | undefined) {
  calls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const answer = await handler(call);
    if (!answer) throw new Error(`unexpected ${call.method} ${call.url}`);
    return answer;
  }) as unknown as typeof fetch;
}

const lists = (open: unknown[] = []) => (call: Call) => {
  if (call.method === 'GET' && call.url === KEYS) return respond({ ok: true, keys: NAMES, skillCodes: [] });
  if (call.method === 'GET' && call.url === `${WINDOWS}?sessionRunId=run%201`) return respond({ ok: true, windows: open });
  return undefined;
};

async function press(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

async function showOpened() {
  await act(async () => {
    render(<BehaviourSampleWindow runId="run 1" athleteId="ath-1" athleteName="Ada Reyes" />);
  });
  await press(/Watch a behaviour/);
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('reads nothing until the coach opens it, then offers the active names, the contexts and the task, ten chances unless set', async () => {
  serve(lists());
  await act(async () => {
    render(<BehaviourSampleWindow runId="run 1" athleteId="ath-1" athleteName="Ada Reyes" />);
  });
  expect(calls).toEqual([]);
  expect(screen.getByRole('button', { name: /Watch a behaviour/ })).toHaveAttribute('aria-expanded', 'false');
  await press(/Watch a behaviour/);
  const name = screen.getByLabelText('Behaviour') as HTMLSelectElement;
  expect(Array.from(name.options).map((option) => option.textContent)).toEqual(['Drops the lead hand after the jab']);
  expect((screen.getByLabelText('What they are doing') as HTMLSelectElement).value).toBe('session');
  expect((screen.getByLabelText('Task') as HTMLSelectElement).value).toBe('controlled');
  expect((screen.getByLabelText('Chances') as HTMLInputElement).value).toBe('10');
});

test('opens a window for this athlete in this run, as asked, then shows chance 1 of its chances', async () => {
  serve((call) => lists()(call) ?? (call.method === 'POST' && call.url === WINDOWS
    ? respond({ ok: true, window: { ...OPEN_ROW, task_constraint: 'live', chances: 6 } }, 201) : undefined));
  await showOpened();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'live' } });
    fireEvent.change(screen.getByLabelText('What they are doing'), { target: { value: 'technical_sparring' } });
    fireEvent.change(screen.getByLabelText('Chances'), { target: { value: '6' } });
  });
  await press('Open the window');
  expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
    athleteId: 'ath-1', behaviourKey: 'k_drop', sessionRunId: 'run 1', attemptContext: 'technical_sparring',
    taskConstraint: 'live', chances: 6,
  });
  expect(screen.getByText('Chance 1 of 6')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Shown' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Not shown' })).toBeInTheDocument();
});

test('a tap goes to the chance on screen, the count moves on, and change last tap flips the coach\'s own last tap', async () => {
  serve((call) => {
    if (call.method === 'GET' && call.url === `${WINDOWS}/win-1`) {
      return respond({ ok: true, window: OPEN_ROW, currentChance: 1, myTaps: [] });
    }
    if (call.method === 'PATCH' && call.url === `${WINDOWS}/win-1`) {
      const body = call.body as { action: string; chance?: number; polarity: string };
      return respond({ ok: true, tap: { chance: body.chance ?? 1, polarity: body.polarity } });
    }
    return lists([OPEN_ROW])(call);
  });
  await showOpened();
  await press(/Join: Drops the lead hand after the jab/);
  expect(screen.getByText('Chance 1 of 10')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Change last tap/ })).toBeNull();
  await press('Shown');
  expect(calls.at(-1)?.body).toEqual({ action: 'tap', chance: 1, polarity: 'occurrence' });
  expect(screen.getByText('Chance 2 of 10')).toBeInTheDocument();
  expect(screen.getByText('You: 1 shown of 1 tapped')).toBeInTheDocument();
  await press(/Change last tap to Not shown/);
  expect(calls.at(-1)?.body).toEqual({ action: 'change_last', polarity: 'counterexample' });
  expect(screen.getByText('You: 0 shown of 1 tapped')).toBeInTheDocument();
  expect(screen.getByText('Chance 2 of 10')).toBeInTheDocument();
});

test('a coach joining starts at the chance the count stands at; one coming back starts after their own last chance', async () => {
  let mine: unknown[] = [];
  serve((call) => (call.method === 'GET' && call.url === `${WINDOWS}/win-1`
    ? respond({ ok: true, window: OPEN_ROW, currentChance: 4, myTaps: mine }) : lists([OPEN_ROW, { ...OPEN_ROW, window_id: 'win-9', athlete_id: 'ath-2' }])(call)));
  await showOpened();
  // Only this athlete's open window is offered.
  expect(screen.getAllByRole('button', { name: /^Join:/ })).toHaveLength(1);
  await press(/Join:/);
  expect(screen.getByText('Chance 4 of 10')).toBeInTheDocument();
  expect(screen.getByText('You: no taps yet')).toBeInTheDocument();

  mine = [{ chance: 1, polarity: 'occurrence' }, { chance: 2, polarity: 'counterexample' }];
  await press(/Close this screen/);
  await press(/Watch a behaviour/);
  await press(/Join:/);
  expect(screen.getByText('Chance 3 of 10')).toBeInTheDocument();
  expect(screen.getByText('You: 1 shown of 2 tapped')).toBeInTheDocument();
});

test('past its last chance the window shows as full, with no tap buttons; a closed window takes no tap', async () => {
  let row: Record<string, unknown> = OPEN_ROW;
  serve((call) => (call.method === 'GET' && call.url === `${WINDOWS}/win-1`
    ? respond({ ok: true, window: row, currentChance: 11, myTaps: [] }) : lists([OPEN_ROW])(call)));
  await showOpened();
  await press(/Join:/);
  expect(screen.getByText('All 10 chances are tapped: the window is full.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Shown' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Not shown' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Close the window' })).toBeInTheDocument();

  row = { ...OPEN_ROW, closed_at: '2026-11-22T20:00:00Z' };
  await press(/Close this screen/);
  await press(/Watch a behaviour/);
  await press(/Join:/);
  expect(screen.getByText('This window is closed.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Shown' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Close the window' })).toBeNull();
});

test('closing sends close and the screen says the window is closed', async () => {
  serve((call) => {
    if (call.method === 'GET' && call.url === `${WINDOWS}/win-1`) return respond({ ok: true, window: OPEN_ROW, currentChance: 3, myTaps: [] });
    if (call.method === 'PATCH') return respond({ ok: true, window: { ...OPEN_ROW, closed_at: '2026-11-22T20:00:00Z' } });
    return lists([OPEN_ROW])(call);
  });
  await showOpened();
  await press(/Join:/);
  await press('Close the window');
  expect(calls.at(-1)?.body).toEqual({ action: 'close' });
  expect(screen.getByText('This window is closed.')).toBeInTheDocument();
});

test('a refused tap says the server\'s reason and reads the window again; a lost answer says it is not known', async () => {
  let patches = 0;
  serve((call) => {
    if (call.method === 'GET' && call.url === `${WINDOWS}/win-1`) return respond({ ok: true, window: OPEN_ROW, currentChance: 1, myTaps: [] });
    if (call.method === 'PATCH') {
      patches += 1;
      if (patches === 1) return respond({ ok: false, error: 'That window is closed.' }, 400);
      throw new Error('network');
    }
    return lists([OPEN_ROW])(call);
  });
  await showOpened();
  await press(/Join:/);
  const reads = () => calls.filter((call) => call.method === 'GET' && call.url === `${WINDOWS}/win-1`).length;
  await press('Not shown');
  expect(screen.getByRole('status')).toHaveTextContent('Not saved: That window is closed.');
  expect(reads()).toBe(2);
  await press('Shown');
  expect(screen.getByRole('status')).toHaveTextContent('It is not known whether the tap was saved; the window has been read again.');
  expect(reads()).toBe(3);
});

test('a list it could not read says so, never "no names"; with no active name it offers no form', async () => {
  serve((call) => (call.url === KEYS ? respond({ ok: false }, 500) : lists()(call)));
  await showOpened();
  expect(screen.getByText('The behaviour names or this run\'s windows could not be read just now.')).toBeInTheDocument();
  expect(screen.queryByLabelText('Behaviour')).toBeNull();
  serve((call) => (call.url === KEYS ? respond({ ok: true, keys: [NAMES[1]] }) : lists()(call)));
  await press('Read again');
  expect(screen.getByText('This gym has no active behaviour name yet, so a window cannot be opened.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open the window' })).toBeNull();
});

test('the screen shows only the coach\'s own count: no tier, label, bar or other coach\'s taps (Q2 A, Q6, LL-Q2)', async () => {
  serve((call) => (call.method === 'GET' && call.url === `${WINDOWS}/win-1`
    ? respond({ ok: true, window: OPEN_ROW, currentChance: 6, myTaps: [{ chance: 5, polarity: 'occurrence' }] }) : lists([OPEN_ROW])(call)));
  await showOpened();
  await press(/Join:/);
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByRole('meter')).toBeNull();
  expect(document.body.textContent).not.toMatch(/tier|emerging|established|pattern|bar\b/i);
  expect(screen.getByText('You: 1 shown of 1 tapped')).toBeInTheDocument();
});
