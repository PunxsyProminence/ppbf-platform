/**
 * @jest-environment jsdom
 */

// The wall's round bell through the REAL sound path (WO-N1-04): the app's useGymSound hook and the
// design system's engine, with only the browser's Web Audio faked. A TV whose sound was switched on
// before is armed by the first press of the remote, and from then on the round bell actually
// reaches the engine. Nothing here mocks playGymSound.

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import WallDisplay from './WallDisplay';
import type { RoundTimerView } from '@/src/server/pilot/roundTimers';
import type { WallBoard } from '@/src/server/pilot/wallDisplay';

type Node = { connect: jest.Mock; disconnect: jest.Mock; [key: string]: unknown };
const param = () => ({ value: 0, setValueAtTime: jest.fn(), exponentialRampToValueAtTime: jest.fn() });
const node = (extra: Record<string, unknown> = {}): Node => ({ connect: jest.fn(), disconnect: jest.fn(), ...extra });

class FakeAudioContext {
  static oscillators = 0;
  state = 'suspended';
  sampleRate = 8000;
  destination = node();
  get currentTime() {
    return Date.now() / 1000;
  }
  async resume() {
    this.state = 'running';
  }
  createGain() {
    return node({ gain: param() });
  }
  createOscillator() {
    FakeAudioContext.oscillators += 1;
    return node({ type: 'sine', frequency: param(), start: jest.fn(), stop: jest.fn() });
  }
  createBuffer(_c: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return node({ buffer: null, start: jest.fn() });
  }
  createBiquadFilter() {
    return node({ type: 'lowpass', frequency: param(), Q: { value: 0 } });
  }
}

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

function timerAt(secondsLeft: number): RoundTimerView {
  return { state: 'running', phase: 'work', round: 1, rounds_total: 3, round_seconds: 30, rest_seconds: 15, seconds_left: secondsLeft, is_paused: false };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  FakeAudioContext.oscillators = 0;
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tv: { tv_name: 'Gym main' }, session: { run_id: 'ssrun_1', timer: timerAt(Math.max(1, 5 - Math.floor((Date.now() - T0) / 1000))) }, board: board(), board_status: 'ok' }),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  window.localStorage.clear();
});

test("a TV whose sound is on rings the real engine's bell at the end of the round, once the remote has been pressed", async () => {
  window.localStorage.setItem('ppbf.sound.enabled', '1');
  render(<WallDisplay />);
  await settle();
  expect(screen.getByRole('button', { name: 'Sound waiting' })).toBeInTheDocument();
  // The first press anywhere arms audio (the hook's own gesture listener).
  await act(async () => {
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: 'Enter' });
  });
  await settle();
  expect(FakeAudioContext.oscillators).toBe(0);
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await settle();
  }
  // The bell is five partials: the engine was asked to play it.
  expect(FakeAudioContext.oscillators).toBeGreaterThanOrEqual(5);
});

test('a TV whose sound is off rings nothing, and the clock still shows', async () => {
  render(<WallDisplay />);
  await settle();
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await settle();
  }
  expect(FakeAudioContext.oscillators).toBe(0);
  expect(screen.getByRole('region', { name: 'Round clock' })).toBeInTheDocument();
});
