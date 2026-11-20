/**
 * @jest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, render, screen } from '@testing-library/react';

import WallDisplay, { WALL_ABANDON_MS, WALL_STALE_MS } from './WallDisplay';
import type { RoundTimerView } from '@/src/server/pilot/roundTimers';
import type { WallBoard } from '@/src/server/pilot/wallDisplay';
import { DESIGN_SYSTEM_ENTRY, readDesignSystemCss } from '@/src/design/readDesignSystemCss';

/**
 * THE TV CLOCKS (U2-6d). Jason, OD-2026-11-19-009: "A: round clock biggest; time of day small;
 * block countdown hidden in the round". The app scrub's finding (ATH-22) was three time readouts
 * on the TV during a session: the time of day, the round clock and NOW's "scheduled" countdown.
 * While the round clock shows a time (6d QP A: a set at Ready, a round, rest, paused, or the
 * waiting board's READY), its time is the biggest of them, the time of day drops to the date's size
 * (6d QQ A), and the countdown is not drawn. With no time on the round clock, the wall is as it
 * was.
 */

jest.mock('./useGymSound', () => ({
  __esModule: true,
  default: () => ({ enabled: false, ready: true, status: 'off', play: jest.fn(), setEnabled: jest.fn() }),
  playGymSound: () => false,
  setGymRecording: () => {},
}));

const KINDS = ['arrival', 'instruction', 'demonstration', 'drill_round', 'reset_minute'];
const LABELS = ['Arrival and wraps', 'Today: the jab', 'Coach shows it', 'Jab on the bag', 'Water'];
const BLOCKS = KINDS.map((kind, i) => ({
  block_id: `b${i}`,
  block_order: i + 1,
  block_label: LABELS[i],
  block_kind: kind,
  drill_name: kind === 'drill_round' ? 'Jab - double jab' : null,
  scale_level: null,
  start_offset_min: i * 5,
  end_offset_min: i * 5 + 5,
}));

const BASE: RoundTimerView = {
  state: 'ready',
  phase: 'ready',
  round: 0,
  rounds_total: 3,
  round_seconds: 180,
  rest_seconds: 60,
  seconds_left: 0,
  is_paused: false,
};

/** One timer per face the wall can show, with the face's label and time. */
const TIMERS: Record<string, { view: RoundTimerView; label: string; time: string }> = {
  ready: { view: BASE, label: 'Round 1 of 3 · Ready', time: '3:00' },
  round: { view: { ...BASE, state: 'running', phase: 'work', round: 2, seconds_left: 125 }, label: 'Round 2 of 3', time: '2:05' },
  rest: { view: { ...BASE, state: 'running', phase: 'rest', round: 1, seconds_left: 42 }, label: 'Rest · round 2 of 3 next', time: '0:42' },
  paused: {
    view: { ...BASE, state: 'paused', phase: 'work', round: 2, seconds_left: 95, is_paused: true },
    label: 'Round 2 of 3 · Paused',
    time: '1:35',
  },
  done: { view: { ...BASE, state: 'running', phase: 'done', round: 3, seconds_left: 0 }, label: 'Rounds done', time: '' },
  stopped: { view: { ...BASE, state: 'ended', phase: 'ended', round: 2, seconds_left: 0 }, label: 'Rounds stopped', time: '' },
};

function session(timer: RoundTimerView | null) {
  return {
    run_id: 'run-1',
    script_name: 'Jab night',
    total_minutes: 25,
    started_at: '2026-08-03T18:14:00.000Z',
    server_time: '2026-08-03T18:30:00.000Z',
    elapsed_seconds: 960,
    is_paused: false,
    current_block: { ...BLOCKS[3], seconds_to_scheduled_end: 480 },
    next_block: BLOCKS[4],
    blocks: BLOCKS,
    timer,
  };
}

function board(): WallBoard {
  return {
    generated_at: '2026-08-03T18:30:00.000Z',
    gym_day: '2026-08-03',
    time_zone: 'America/New_York',
    name_mode: 'initials',
    sessions: [
      { key: 'c1', title: 'Open Gym', start_at: '2026-08-03T18:00:00.000Z', end_at: '2026-08-03T19:00:00.000Z', location: 'Main floor', state: 'now', on_floor: 1 },
    ],
    on_floor: [{ key: 'p1', name: 'A.B.', visibility: 'initials' }],
    on_floor_total: 1,
    marquee: [],
    notice: null,
  };
}

function paired(payload: unknown) {
  return jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload } as unknown as Response);
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const realFetch = global.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-03T18:30:00.000Z'));
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  global.fetch = realFetch;
});

/* ---------------------------------------------------------- the sizes --- */

// The type ladder, resolved to pixels from the design system and globals.css, as the wall's own
// distance test (src/design/wallSurface.test.tsx) resolves it: the property is the size, not the
// class name, so a class that silently fell back to body type would fail here.
const GLOBALS_CSS = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');
const TOKENS = new Map<string, string>();
for (const [, name, value] of `${readDesignSystemCss(DESIGN_SYSTEM_ENTRY)}\n${GLOBALS_CSS}`
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .matchAll(/(?<![\w-])(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
  TOKENS.set(name, value.trim());
}

function px(value: string): number {
  const ref = value.trim().match(/^var\((--[a-z0-9-]+)\)$/i);
  if (ref) return px(TOKENS.get(ref[1]) ?? 'NaN');
  const calc = value.trim().match(/^calc\((.*)\)$/i);
  if (calc) return calc[1].split('*').reduce((product, term) => product * px(term), 1);
  return Number.parseFloat(value);
}

/** The font size an element's one Tailwind size class gives it, in px. */
function sizeOf(el: Element | null): number {
  if (!el) throw new Error('no element');
  const sizes = [...el.classList].flatMap((name) => {
    const ladder = name.match(/^text-((?:[2-9])?xl|xs|sm|base|lg)$/);
    if (ladder) return [`var(--text-${ladder[1]})`];
    const arbitrary = name.match(/^text-\[length:(var\(--[a-z0-9-]+\))\]$/);
    return arbitrary ? [arbitrary[1]] : [];
  });
  if (sizes.length !== 1) throw new Error(`expected one size class on ${el.className}`);
  const size = px(sizes[0]);
  if (!(size > 0)) throw new Error(`size class on ${el.className} did not resolve`);
  return size;
}

/** NOW's countdown is sized by its wall rule, not a class. */
function countdownSize(): number {
  const rule = GLOBALS_CSS.match(/\[data-surface="wall"\] \.wall-now-time \{([^}]*)\}/);
  const size = rule?.[1].match(/font-size:\s*([^;]+);/);
  if (!size) throw new Error('the .wall-now-time rule has no font-size');
  return px(size[1]);
}

function clockPlate(container: HTMLElement) {
  return container.querySelector('.wall-clock');
}

function roundTime(container: HTMLElement) {
  return container.querySelector('.wall-round__time');
}

function now() {
  return screen.getByRole('region', { name: 'Now' });
}

/* ------------------------------------------------------------ the rule --- */

describe('the TV clocks while the round clock shows a time', () => {
  it.each(['ready', 'round', 'rest', 'paused'])('%s: the round time is the biggest readout, the time of day is small, and NOW has no countdown', async (state) => {
    const timer = TIMERS[state];
    global.fetch = paired({ session: session(timer.view), board: board(), quotes: [] }) as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();

    const round = screen.getByRole('region', { name: 'Round clock' });
    expect(round.querySelector('.wall-round__label')?.textContent).toBe(timer.label);
    expect(roundTime(container)?.textContent).toBe(timer.time);
    // The words sit BESIDE the time, in reading order. Stacked over a time this size, words that
    // wrapped made the bezel taller than the masthead's row and cost the floor list half its names
    // (measured at 1920x1080 in a browser; jsdom has no layout, so the class is what is pinned).
    expect(round.classList.contains('flex-row')).toBe(true);
    expect(round.classList.contains('flex-col')).toBe(false);
    expect([...round.children].map((child) => child.classList[0])).toEqual(['wall-round__label', 'wall-round__time']);

    // Round clock biggest: above the time of day, NOW's countdown size, and every other sized
    // line in the masthead (the day, the date, the round's own label).
    const biggest = sizeOf(roundTime(container));
    // The step the time of day has with no round clock (text-8xl), not merely anything above the
    // day's 80.9px: the plan, the comments and the lane row all name this size.
    expect(biggest).toBe(px('var(--text-8xl)'));
    expect(biggest).toBeGreaterThan(sizeOf(clockPlate(container)));
    expect(biggest).toBeGreaterThan(countdownSize());
    for (const el of container.querySelectorAll('header [class*="text-"]')) {
      if (el !== roundTime(container)) expect(biggest).toBeGreaterThan(sizeOf(el));
    }

    // Time of day small: the date's size, below the day's.
    expect(sizeOf(clockPlate(container))).toBe(sizeOf(container.querySelector('.wall-date')));
    expect(sizeOf(clockPlate(container))).toBeLessThan(sizeOf(container.querySelector('.wall-day')));
    // Still the plate it was, still silent to a screen reader.
    expect(clockPlate(container)?.classList.contains('ge-enamel')).toBe(true);
    expect(clockPlate(container)?.getAttribute('aria-hidden')).toBe('true');

    // Block countdown hidden; the rest of NOW stays. (By element: the strip below also carries the
    // block's name, so a text search of the panel would not see the name line go.)
    expect(now().querySelector('.wall-now-left')).toBeNull();
    expect(now().textContent).not.toContain('scheduled');
    expect(now().textContent).not.toContain('8:00');
    expect(now().querySelector('.wall-kind-word')?.textContent).toBe('Drill');
    expect(now().querySelector('.wall-now-label')?.textContent).toBe('Jab on the bag');
    expect(now().querySelector('.wall-now-drill')?.textContent).toBe('Jab - double jab');
    expect(now().querySelector('.wall-session-place')?.textContent).toBe('Block 4 of 5');
    expect(now().querySelectorAll('ol[aria-label="Today\'s session"] > li')).toHaveLength(BLOCKS.length);
  });

  it('the waiting board: READY is the biggest readout and the time of day is small (no session, so no countdown)', async () => {
    global.fetch = paired({ session: null, board: board(), quotes: [] }) as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();

    expect(screen.getByRole('region', { name: 'Round clock' }).textContent).toContain('Waiting for coach');
    expect(roundTime(container)?.textContent).toBe('Ready');
    expect(sizeOf(roundTime(container))).toBeGreaterThan(sizeOf(clockPlate(container)));
    expect(sizeOf(clockPlate(container))).toBe(sizeOf(container.querySelector('.wall-date')));
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
  });
});

describe('the TV clocks with no time on the round clock: the wall as it was', () => {
  it.each(['done', 'stopped'])('%s: the time of day keeps its size and NOW keeps its countdown', async (state) => {
    const timer = TIMERS[state];
    global.fetch = paired({ session: session(timer.view), board: board(), quotes: [] }) as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();

    expect(screen.getByRole('region', { name: 'Round clock' }).textContent).toBe(timer.label);
    expect(roundTime(container)).toBeNull();
    expect(clockPlate(container)?.classList.contains('text-8xl')).toBe(true);
    expect(sizeOf(clockPlate(container))).toBeGreaterThan(sizeOf(container.querySelector('.wall-day')));
    expect(now().querySelector('.wall-now-left')?.textContent).toBe('8:00scheduled');
  });

  it('no round timer: no round clock, the time of day keeps its size, NOW keeps its countdown', async () => {
    global.fetch = paired({ session: session(null), board: board(), quotes: [] }) as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();

    expect(screen.queryByRole('region', { name: 'Round clock' })).toBeNull();
    expect(clockPlate(container)?.classList.contains('text-8xl')).toBe(true);
    expect(now().querySelector('.wall-now-left')?.textContent).toBe('8:00scheduled');
  });

  it('the unpaired public wall: no round clock and the time of day keeps its size', async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes('/api/pilot/tv/session')) return { ok: false, status: 401, json: async () => ({ code: 'TV_NOT_PAIRED' }) } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          board: { scope: 'public', generated_at: '2026-08-03T18:30:00.000Z', gym_day: '2026-08-03', time_zone: 'America/New_York', sessions: [], on_floor_total: 0, notice: null },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();

    // The public board is up (not the standing screen a failed read would leave).
    expect(screen.getByRole('region', { name: 'On the floor' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Round clock' })).toBeNull();
    expect(clockPlate(container)?.classList.contains('text-8xl')).toBe(true);
  });
});

describe('the TV clocks on the edges', () => {
  it('a board miss that kept a timer: the standing screen, the round clock leading, the time of day small', async () => {
    global.fetch = paired({ session: session(TIMERS.round.view), board: null, quotes: [] }) as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();

    expect(roundTime(container)?.textContent).toBe('2:05');
    expect(clockPlate(container)?.classList.contains('text-4xl')).toBe(true);
    // No board, so no NOW and nothing to hide.
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
  });

  it('a timer reading as old as an abandoned board leaves the wall, and the time of day grows back', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ session: session(TIMERS.paused.view), board: board(), quotes: [] }) })
      .mockRejectedValue(new Error('network'));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();
    expect(clockPlate(container)?.classList.contains('text-4xl')).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(WALL_ABANDON_MS + 1_000);
    });
    await settle();

    expect(screen.queryByRole('region', { name: 'Round clock' })).toBeNull();
    expect(clockPlate(container)?.classList.contains('text-8xl')).toBe(true);
  });

  it('a waiting board that is no longer fresh says no READY, so the time of day grows back', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ session: null, board: board(), quotes: [] }) })
      .mockRejectedValue(new Error('network'));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();
    expect(roundTime(container)?.textContent).toBe('Ready');
    expect(clockPlate(container)?.classList.contains('text-4xl')).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(WALL_STALE_MS);
    });
    await settle();

    expect(screen.queryByRole('region', { name: 'Round clock' })).toBeNull();
    expect(clockPlate(container)?.classList.contains('text-8xl')).toBe(true);
  });
});

describe('the round clock leaves the wall', () => {
  it('when the coach clears the timer, the time of day grows back and NOW\'s countdown returns', async () => {
    const fetchMock = paired({ session: session(TIMERS.round.view), board: board(), quotes: [] });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();
    expect(now().querySelector('.wall-now-left')).toBeNull();
    expect(clockPlate(container)?.classList.contains('text-4xl')).toBe(true);

    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ session: session(null), board: board(), quotes: [] }) } as unknown as Response);
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    await settle();

    expect(screen.queryByRole('region', { name: 'Round clock' })).toBeNull();
    expect(clockPlate(container)?.classList.contains('text-8xl')).toBe(true);
    expect(now().querySelector('.wall-now-left')).not.toBeNull();
  });
});
