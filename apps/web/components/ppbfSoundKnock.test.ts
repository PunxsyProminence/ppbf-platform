/**
 * @jest-environment jsdom
 */

// The engine's knock voice (WO-N1-04), against a minimal fake Web Audio context: it sounds only
// while audio is live, it is short, and like every voice it never stacks on a sound still playing.

import '@/../../design-system/ppbf-sound.js';

type Node = { connect: jest.Mock; disconnect: jest.Mock; [key: string]: unknown };

function param() {
  return { value: 0, setValueAtTime: jest.fn(), exponentialRampToValueAtTime: jest.fn() };
}

function node(extra: Record<string, unknown> = {}): Node {
  return { connect: jest.fn(), disconnect: jest.fn(), ...extra };
}

class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  state = 'suspended';
  currentTime = 0;
  sampleRate = 8000;
  destination = node();
  oscillators: Node[] = [];
  noises: Node[] = [];
  constructor() {
    FakeAudioContext.created.push(this);
  }
  async resume() {
    this.state = 'running';
  }
  createGain() {
    return node({ gain: param() });
  }
  createOscillator() {
    const o = node({ type: 'sine', frequency: param(), start: jest.fn(), stop: jest.fn() });
    this.oscillators.push(o);
    return o;
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const s = node({ buffer: null, start: jest.fn() });
    this.noises.push(s);
    return s;
  }
  createBiquadFilter() {
    return node({ type: 'lowpass', frequency: param(), Q: { value: 0 } });
  }
}

type Engine = { enable(): Promise<boolean>; play(name: string): boolean };
const Engine = (globalThis as unknown as { PPBFSound: new () => Engine }).PPBFSound;

beforeEach(() => {
  FakeAudioContext.created = [];
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  window.localStorage.clear();
});

afterEach(() => {
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
});

test('the knock is silent until audio is live', () => {
  expect(new Engine().play('knock')).toBe(false);
});

test('a live engine knocks: two dry hits, short, and nothing stacks on top of it', async () => {
  const engine = new Engine();
  expect(await engine.enable()).toBe(true);
  const ctx = FakeAudioContext.created[0];
  expect(engine.play('knock')).toBe(true);
  expect(ctx.noises).toHaveLength(2);
  expect(ctx.oscillators).toHaveLength(2);
  // Still sounding: a bell asked for now is dropped, not stacked.
  ctx.currentTime = 0.2;
  expect(engine.play('bell')).toBe(false);
  // Under a third of a second later it is free again.
  ctx.currentTime = 0.27;
  expect(engine.play('bell')).toBe(true);
});
