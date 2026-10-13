/**
 * @jest-environment jsdom
 */

// The paired gym TV's round clock, bell and knock (WO-N1-04), through the real WallDisplay and its
// real poll loop on fake timers. The server is faked: it holds one timer whose reading follows the
// fake clock, exactly as roundTimers.ts derives it from stored instants. The sound engine is faked
// so each test can count what the wall asked it to play.

import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';

import WallDisplay, { WALL_POLL_MS, WALL_ROUND_POLL_MS } from './WallDisplay';
import { advanceRoundTimer } from './wallRoundTimer';
import type { RoundTimerView } from '@/src/server/pilot/roundTimers';
import type { WallBoard } from '@/src/server/pilot/wallDisplay';

const played: string[] = [];
let engineBusy = false;

jest.mock('./useGymSound', () => ({
  __esModule: true,
  default: () => ({ enabled: true, ready: true, status: 'on', play: jest.fn(), setEnabled: jest.fn() }),
  playGymSound: (voice: string) => {
    // Like the engine: a sound asked for while another is still ringing is dropped, not stacked.
    if (engineBusy) return false;
    played.push(voice);
    return true;
  },
}));

const T0 = Date.parse('2026-10-12T18:00:00.000Z');

function board(): WallBoard {
  return {
    generated_at: '2026-10-12T18:00:00.000Z',
    gym_day: '2026-10-12',
    time_zone: 'America/New_York',
    name_mode: 'initials',
    sessions: [],
    on_floor: [],
    on_floor_total: 0,
    marquee: [],
    notice: null,
  } as WallBoard;
}

/** The fake server's timer: started (or not) at a fake-clock instant, read at the current one. */
let serverTimer: { startedAt: number | null; state: RoundTimerView['state']; config?: Partial<RoundTimerView> } | null;

function serverView(): RoundTimerView | null {
  if (!serverTimer) return null;
  const base: RoundTimerView = {
    state: 'ready',
    phase: 'ready',
    round: 0,
    rounds_total: 3,
    round_seconds: 30,
    rest_seconds: 15,
    seconds_left: 0,
    is_paused: false,
    ...serverTimer.config,
  };
  if (serverTimer.state !== 'running' || serverTimer.startedAt === null) return { ...base, state: serverTimer.state, phase: serverTimer.state === 'ended' ? 'ended' : 'ready' };
  const first: RoundTimerView = { ...base, state: 'running', phase: 'work', round: 1, seconds_left: base.round_seconds };
  const now = advanceRoundTimer(first, Math.floor((Date.now() - serverTimer.startedAt) / 1000));
  return { ...first, phase: now.phase, round: now.round, seconds_left: now.seconds_left };
}

let pairedTv = true;
let publicFails = false;
let boardMiss = false;
let fetchMock: jest.Mock;

function sessionReads(): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/pilot/tv/session')).length;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function seconds(count: number) {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await settle();
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  played.length = 0;
  engineBusy = false;
  pairedTv = true;
  publicFails = false;
  boardMiss = false;
  serverTimer = null;
  fetchMock = jest.fn(async (url: string) => {
    if (url.includes('/api/pilot/tv/session')) {
      if (!pairedTv) return { ok: false, status: 401, json: async () => ({ error: 'TV_NOT_PAIRED' }) } as Response;
      const timer = serverView();
      const session = { run_id: 'ssrun_1', timer };
      return { ok: true, status: 200, json: async () => ({ tv: { tv_name: 'Gym main' }, session, board: boardMiss ? null : board(), board_status: boardMiss ? 'unavailable' : 'ok' }) } as Response;
    }
    if (publicFails) return { ok: false, status: 503, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => ({ ok: true, board: { ...board(), scope: 'public' } }) } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('the round clock on a paired TV', () => {
  test('shows the round and time left, counts down between polls, and says Rest in words', async () => {
    serverTimer = { startedAt: T0 - 5_000, state: 'running' };
    render(<WallDisplay />);
    await settle();
    const clock = screen.getByRole('region', { name: 'Round clock' });
    expect(clock).toHaveTextContent('Round 1 of 3');
    expect(clock).toHaveTextContent('0:25');
    await seconds(3);
    expect(clock).toHaveTextContent('0:22');
    await seconds(22);
    expect(screen.getByRole('region', { name: 'Round clock' })).toHaveTextContent('Rest · round 2 of 3 next');
  });

  test('a full set rings each bell and knock once, however many polls land in between', async () => {
    // Started 2 seconds ago: the first reading rings nothing.
    serverTimer = { startedAt: T0 - 2_000, state: 'running' };
    render(<WallDisplay />);
    await settle();
    expect(played).toEqual([]);
    // 3 rounds of 30 with 15 rest = 120 seconds; run well past the end.
    await seconds(130);
    expect(played).toEqual([
      'knock', 'bell', // round 1: knock at 10 left, end bell
      'bell', 'knock', 'bell', // round 2: start, knock, end
      'bell', 'knock', 'bell', // round 3: start, knock, end
    ]);
    expect(screen.getByRole('region', { name: 'Round clock' })).toHaveTextContent('Rounds done');
  });

  test("the coach's Start reaches the wall within one short poll and rings the start bell", async () => {
    serverTimer = { startedAt: null, state: 'ready' };
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Round clock' })).toHaveTextContent('Round 1 of 3 · Ready');
    await seconds(2);
    serverTimer = { startedAt: Date.now(), state: 'running' };
    await seconds(WALL_ROUND_POLL_MS / 1000);
    expect(played).toEqual(['bell']);
    expect(screen.getByRole('region', { name: 'Round clock' })).toHaveTextContent('Round 1 of 3');
  });

  test('a reload mid-round rings nothing late', async () => {
    // 10 seconds into round 1 (of 30): the start bell is long past.
    serverTimer = { startedAt: T0 - 10_000, state: 'running' };
    const first = render(<WallDisplay />);
    await settle();
    first.unmount();
    render(<WallDisplay />);
    await settle();
    await seconds(2);
    expect(played).toEqual([]);
  });

  test('polls every five seconds while rounds are set, and back to thirty once they end', async () => {
    serverTimer = { startedAt: T0, state: 'running' };
    render(<WallDisplay />);
    await settle();
    const start = sessionReads();
    await seconds(WALL_ROUND_POLL_MS / 1000);
    expect(sessionReads()).toBe(start + 1);
    serverTimer = { startedAt: null, state: 'ended' };
    await seconds(WALL_ROUND_POLL_MS / 1000);
    expect(screen.getByRole('region', { name: 'Round clock' })).toHaveTextContent('Rounds stopped');
    const afterEnd = sessionReads();
    await seconds(WALL_ROUND_POLL_MS / 1000);
    expect(sessionReads()).toBe(afterEnd);
    await seconds(WALL_POLL_MS / 1000 - WALL_ROUND_POLL_MS / 1000);
    expect(sessionReads()).toBe(afterEnd + 1);
  });

  test('no timer: no round clock and the usual thirty-second poll', async () => {
    render(<WallDisplay />);
    await settle();
    expect(screen.queryByRole('region', { name: 'Round clock' })).toBeNull();
    const start = sessionReads();
    await seconds(WALL_ROUND_POLL_MS / 1000);
    expect(sessionReads()).toBe(start);
  });

  test('an unpaired screen shows no round clock and rings nothing', async () => {
    pairedTv = false;
    serverTimer = { startedAt: T0 - 19_000, state: 'running' };
    render(<WallDisplay />);
    await settle();
    await seconds(15);
    expect(screen.queryByRole('region', { name: 'Round clock' })).toBeNull();
    expect(played).toEqual([]);
  });

  test('a poll that pulls the count back across a bell never rings that bell twice', async () => {
    // Round 1 ends 3 seconds after load.
    serverTimer = { startedAt: T0 - 27_000, state: 'running' };
    render(<WallDisplay />);
    await settle();
    await seconds(4);
    expect(played).toEqual(['bell']);
    // The server's clock reads 3 seconds behind the TV's from here: the next poll puts round 1 back
    // in work with a second or two left, and it ends again on the TV.
    serverTimer = { startedAt: T0 - 24_000, state: 'running' };
    await seconds(8);
    expect(played).toEqual(['bell']);
  });

  test('a TV that loses its pairing drops the round clock, even when the public read fails too', async () => {
    serverTimer = { startedAt: T0, state: 'running' };
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Round clock' })).toBeInTheDocument();
    pairedTv = false;
    publicFails = true;
    await seconds(WALL_ROUND_POLL_MS / 1000);
    expect(screen.queryByRole('region', { name: 'Round clock' })).toBeNull();
  });

  test('a second set on the same run rings its own bells', async () => {
    serverTimer = { startedAt: T0 - 2_000, state: 'running', config: { rounds_total: 1 } };
    render(<WallDisplay />);
    await settle();
    await seconds(30);
    expect(played).toEqual(['knock', 'bell']);
    // The coach ends, sets one more round and starts, all between two polls.
    serverTimer = { startedAt: Date.now(), state: 'running', config: { rounds_total: 1 } };
    await seconds(WALL_ROUND_POLL_MS / 1000 + 25);
    // The new set: its start bell, its knock and its end bell, none of them blocked by the first set's.
    expect(played).toEqual(['knock', 'bell', 'bell', 'knock', 'bell']);
  });

  test("a board miss still brings the coach's Pause to the wall", async () => {
    serverTimer = { startedAt: T0, state: 'running' };
    render(<WallDisplay />);
    await settle();
    boardMiss = true;
    serverTimer = { startedAt: null, state: 'ready' };
    await seconds(WALL_ROUND_POLL_MS / 1000);
    expect(screen.getByRole('region', { name: 'Round clock' })).toHaveTextContent('Round 1 of 3 · Ready');
  });

  test('a set whose rounds are all done keeps the short poll, so the next Start is seen in time', async () => {
    serverTimer = { startedAt: T0 - 200_000, state: 'running' };
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Round clock' })).toHaveTextContent('Rounds done');
    const start = sessionReads();
    await seconds(WALL_ROUND_POLL_MS / 1000);
    expect(sessionReads()).toBe(start + 1);
  });

  test('a bell the engine dropped because it was still ringing is tried again while still fresh', async () => {
    // Round 1 ends 2 seconds after load.
    serverTimer = { startedAt: T0 - 28_000, state: 'running' };
    render(<WallDisplay />);
    await settle();
    engineBusy = true;
    await seconds(2);
    expect(played).toEqual([]);
    engineBusy = false;
    await seconds(1);
    expect(played).toEqual(['bell']);
    await seconds(3);
    expect(played).toEqual(['bell']);
  });

  // Codex on #1504: the clock follows its own good reading, not the board's.
  test('a first page whose board missed still shows the round clock and rings its bells', async () => {
    boardMiss = true;
    serverTimer = { startedAt: T0 - 27_000, state: 'running' };
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Round clock' })).toHaveTextContent('Round 1 of 3');
    await seconds(4);
    expect(played).toEqual(['bell']);
  });

  test('while only the board misses, the short poll holds', async () => {
    serverTimer = { startedAt: T0, state: 'running', config: { rounds_total: 50 } };
    render(<WallDisplay />);
    await settle();
    boardMiss = true;
    const start = sessionReads();
    await seconds((WALL_ROUND_POLL_MS / 1000) * 6);
    expect(sessionReads()).toBe(start + 6);
  });

  test('a restart in the same round between two polls rings the new start bell', async () => {
    serverTimer = { startedAt: T0 - 2_000, state: 'running' };
    render(<WallDisplay />);
    await settle();
    // 16 seconds into a 30-second round: before the knock, and one second before the next poll.
    await seconds(14);
    expect(played).toEqual([]);
    // Ended, set again and started, all between two polls: round 1 again, just begun.
    serverTimer = { startedAt: Date.now(), state: 'running' };
    await seconds(2);
    expect(played).toEqual(['bell']);
  });
});
