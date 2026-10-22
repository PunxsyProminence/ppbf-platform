/**
 * @jest-environment jsdom
 */

// The engine's recorded voice (issue 1792 item 4; Jason 2026-10-21, "A: Free boxing-bell recording
// (Rec.)"): a surface may hand it a recording to ring in place of the synthesized bell. The
// synthesized bell stays the fallback until the file has loaded, and for good if it never does.

import '@/../../design-system/ppbf-sound.js';

type Node = { connect: jest.Mock; disconnect: jest.Mock; [key: string]: unknown };

function param() {
  return { value: 0, setValueAtTime: jest.fn(), exponentialRampToValueAtTime: jest.fn() };
}

function node(extra: Record<string, unknown> = {}): Node {
  return { connect: jest.fn(), disconnect: jest.fn(), ...extra };
}

const RECORDING = { duration: 2.5 };

class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  state = 'suspended';
  currentTime = 0;
  sampleRate = 8000;
  destination = node();
  oscillators: Node[] = [];
  sources: Node[] = [];
  decoded = 0;
  constructor() {
    FakeAudioContext.created.push(this);
  }
  async resume() {
    this.state = 'running';
  }
  async decodeAudioData() {
    this.decoded += 1;
    return RECORDING;
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
    this.sources.push(s);
    return s;
  }
  createBiquadFilter() {
    return node({ type: 'lowpass', frequency: param(), Q: { value: 0 } });
  }
}

type Engine = { enable(): Promise<boolean>; play(name: string): boolean; setRecording(name: string, url: string | null): void };
const Engine = (globalThis as unknown as { PPBFSound: new () => Engine }).PPBFSound;

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

let fetchMock: jest.Mock;

beforeEach(() => {
  FakeAudioContext.created = [];
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  fetchMock = jest.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  window.localStorage.clear();
});

afterEach(() => {
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
});

test('a recording asked for before audio is live is fetched once audio starts, and then rings as the bell', async () => {
  const engine = new Engine();
  engine.setRecording('bell', '/sounds/boxing-bell.wav');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await engine.enable()).toBe(true);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/sounds/boxing-bell.wav');

  const ctx = FakeAudioContext.created[0];
  expect(engine.play('bell')).toBe(true);
  expect(ctx.oscillators).toHaveLength(0);
  expect(ctx.sources).toHaveLength(1);
  expect(ctx.sources[0].buffer).toBe(RECORDING);
  // The recording holds the engine for its own length: nothing stacks on it.
  ctx.currentTime = 2.4;
  expect(engine.play('knock')).toBe(false);
  ctx.currentTime = 2.6;
  expect(engine.play('knock')).toBe(true);
});

test('only the voice it was given is recorded: the knock stays synthesized', async () => {
  const engine = new Engine();
  engine.setRecording('bell', '/sounds/boxing-bell.wav');
  await engine.enable();
  await flush();
  const ctx = FakeAudioContext.created[0];
  expect(engine.play('knock')).toBe(true);
  expect(ctx.oscillators.length).toBeGreaterThan(0);
  expect(ctx.sources.every((s) => s.buffer !== RECORDING)).toBe(true);
});

test('a missing file leaves the synthesized bell ringing, and is not asked for again', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  const engine = new Engine();
  engine.setRecording('bell', '/sounds/boxing-bell.wav');
  await engine.enable();
  await flush();
  const ctx = FakeAudioContext.created[0];
  expect(ctx.decoded).toBe(0);
  expect(engine.play('bell')).toBe(true);
  expect(ctx.oscillators.length).toBeGreaterThan(0);
  engine.setRecording('bell', '/sounds/boxing-bell.wav');
  await engine.enable();
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a fetch that throws (offline) leaves the synthesized bell ringing, and the next bell tries the file again', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  const engine = new Engine();
  engine.setRecording('bell', '/sounds/boxing-bell.wav');
  await engine.enable();
  await flush();
  const ctx = FakeAudioContext.created[0];
  expect(engine.play('bell')).toBe(true);
  expect(ctx.oscillators.length).toBeGreaterThan(0);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  ctx.currentTime = 5;
  ctx.oscillators.length = 0;
  expect(engine.play('bell')).toBe(true);
  expect(ctx.oscillators).toHaveLength(0);
  expect(ctx.sources.some((s) => s.buffer === RECORDING)).toBe(true);
});

test('null goes back to the synthesized bell', async () => {
  const engine = new Engine();
  engine.setRecording('bell', '/sounds/boxing-bell.wav');
  await engine.enable();
  await flush();
  engine.setRecording('bell', null);
  const ctx = FakeAudioContext.created[0];
  expect(engine.play('bell')).toBe(true);
  expect(ctx.oscillators.length).toBeGreaterThan(0);
  expect(ctx.sources.every((s) => s.buffer !== RECORDING)).toBe(true);
});
