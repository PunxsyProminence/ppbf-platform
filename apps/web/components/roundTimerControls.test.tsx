/**
 * @jest-environment jsdom
 */

// The coach's round timer controls (WO-N1-03). The route is faked; each test says what the server
// holds and checks the exact action the screen sends and that it shows what the server answered.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import RoundTimerControls from './RoundTimerControls';
import type { RoundTimerView } from '@/src/server/pilot/roundTimers';

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

const URL = '/api/pilot/session-scripts/runs/ssrun_1/timer';

function timer(overrides: Partial<RoundTimerView> = {}): RoundTimerView {
  return {
    state: 'ready',
    phase: 'ready',
    round: 0,
    rounds_total: 3,
    round_seconds: 180,
    rest_seconds: 60,
    seconds_left: 0,
    is_paused: false,
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

let held: RoundTimerView | null;
let answer: (body: Record<string, unknown>) => Response;
let fetchMock: jest.Mock;

function posts(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderControls() {
  render(<RoundTimerControls runId="ssrun_1" />);
  await settle();
}

beforeEach(() => {
  jest.useFakeTimers();
  held = null;
  answer = () => json({ error: 'UNEXPECTED' }, 500);
  fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(URL);
    if (init?.method === 'POST') return answer(JSON.parse(String(init.body)) as Record<string, unknown>);
    return json({ timer: held });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('round timer controls', () => {
  test('no rounds set: says so, offers the three numbers and Set rounds, and nothing starts', async () => {
    await renderControls();
    expect(screen.getByText('No rounds set for this session.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set rounds' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start rounds' })).toBeNull();
    expect(posts()).toEqual([]);
  });

  test('Set rounds sends exactly the three numbers, and shows the ready timer the server answered', async () => {
    answer = (body) => json({ timer: timer({ round_seconds: Number(body.round_seconds), rounds_total: Number(body.rounds_total), rest_seconds: Number(body.rest_seconds) }) });
    await renderControls();
    fireEvent.change(screen.getByLabelText('Round (seconds)'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('Rest (seconds)'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set rounds' }));
    await settle();
    expect(posts()).toEqual([{ action: 'configure', round_seconds: 120, rest_seconds: 30, rounds_total: 5 }]);
    expect(screen.getByLabelText('Round timer status')).toHaveTextContent('Ready');
    // Setting rounds never starts them.
    expect(screen.getByRole('button', { name: 'Start rounds' })).toBeInTheDocument();
  });

  test('a number that is not whole is refused on the screen, before any request', async () => {
    await renderControls();
    fireEvent.change(screen.getByLabelText('Round (seconds)'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set rounds' }));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Round, rest and rounds must be whole numbers.');
    expect(posts()).toEqual([]);
  });

  test('Start sends only the start action and shows the round, phase and time the server gave', async () => {
    held = timer();
    answer = () => json({ timer: timer({ state: 'running', phase: 'work', round: 1, seconds_left: 180 }) });
    await renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Start rounds' }));
    await settle();
    expect(posts()).toEqual([{ action: 'start' }]);
    expect(screen.getByLabelText('Round timer status')).toHaveTextContent('Round 1 of 3 · Work · 3:00 left');
    expect(screen.getByRole('button', { name: 'Pause rounds' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set rounds' })).toBeNull();
  });

  test('the seconds tick down for display only, and the server is asked again when a period runs out', async () => {
    held = timer({ state: 'running', phase: 'work', round: 1, seconds_left: 3 });
    await renderControls();
    const reads = fetchMock.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.getByLabelText('Round timer status')).toHaveTextContent('0:01 left');
    expect(fetchMock.mock.calls.length).toBe(reads);
    held = timer({ state: 'running', phase: 'rest', round: 1, seconds_left: 60 });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    await settle();
    expect(fetchMock.mock.calls.length).toBe(reads + 1);
    expect(screen.getByLabelText('Round timer status')).toHaveTextContent('Round 1 of 3 · Rest · 1:00 left');
    expect(posts()).toEqual([]);
  });

  test('another screen moving the timer shows here on the next read', async () => {
    held = timer({ state: 'running', phase: 'work', round: 2, seconds_left: 100 });
    await renderControls();
    held = timer({ state: 'paused', phase: 'work', round: 2, seconds_left: 90, is_paused: true });
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    await settle();
    expect(screen.getByLabelText('Round timer status')).toHaveTextContent('Round 2 of 3 · Work · Paused at 1:30');
    expect(screen.getByRole('button', { name: 'Resume rounds' })).toBeInTheDocument();
  });

  test.each([
    ['Pause rounds', timer({ state: 'running', phase: 'work', round: 1, seconds_left: 50 }), 'pause'],
    ['Resume rounds', timer({ state: 'paused', phase: 'work', round: 1, seconds_left: 50, is_paused: true }), 'resume'],
    ['End rounds', timer({ state: 'running', phase: 'rest', round: 2, seconds_left: 10 }), 'end'],
  ] as const)('%s sends exactly its action', async (label, current, action) => {
    held = current;
    answer = () => json({ timer: current });
    await renderControls();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await settle();
    expect(posts()).toEqual([{ action }]);
  });

  test('a double tap sends one request', async () => {
    held = timer();
    let release: (value: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => { release = resolve; }) as unknown as Response;
    await renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Start rounds' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start rounds' }));
    await settle();
    expect(posts()).toHaveLength(1);
    release(json({ timer: timer({ state: 'running', phase: 'work', round: 1, seconds_left: 180 }) }));
    await settle();
  });

  test('a refusal shows the server code and keeps the last state the server gave', async () => {
    held = timer();
    answer = () => json({ error: 'SESSION_RUN_NOT_LIVE' }, 409);
    await renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Start rounds' }));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('The server refused: SESSION_RUN_NOT_LIVE');
    expect(screen.getByLabelText('Round timer status')).toHaveTextContent('Ready');
  });

  test('a failed first read says so, never "no rounds set"', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'X' }, 500));
    await renderControls();
    expect(screen.getByText('The round timer could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('No rounds set for this session.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set rounds' })).toBeNull();
  });

  test('ended: offers Set rounds for another set, and no End', async () => {
    held = timer({ state: 'ended', phase: 'ended' });
    await renderControls();
    expect(screen.getByLabelText('Round timer status')).toHaveTextContent('Ended');
    expect(screen.getByRole('button', { name: 'Set rounds' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End rounds' })).toBeNull();
  });
});
