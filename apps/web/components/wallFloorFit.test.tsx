/**
 * @jest-environment jsdom
 */

import { act, render, screen } from '@testing-library/react';

import WallDisplay, { FLOOR_RUNGS, floorFitStep } from './WallDisplay';
import type { WallBoard } from '@/src/server/pilot/wallDisplay';

/**
 * ON THE FLOOR, WHOLE GYM (issue 1792 follow-up; the pilot is the whole gym, OD-2026-10-21-001 D1).
 * Measured at 1920x1080 with full names before this: 5 of 12 names showed and 9 of 18, the next
 * row cut through its letters, and "+N more" clipped away with it. Now the list steps down the
 * ladder after layout until everyone fits, and only when the smallest rung cannot hold them does it
 * show the names that fit whole and "+N more" for the rest, on its own unclipped line. jsdom does no
 * layout, so the geometry below is supplied: every name row is ROW px tall, one name per row.
 */

describe('one measurement of the floor list', () => {
  it('keeps every name when they all fit, with the "+N more" room given back', () => {
    expect(floorFitStep([40, 80, 120], 100, 30, 0, true)).toEqual({ kind: 'all' });
  });

  it('keeps every name and the line when the server already capped the list', () => {
    expect(floorFitStep([40, 80], 100, 30, 6, true)).toEqual({ kind: 'all' });
    expect(floorFitStep([40, 80, 120], 100, 30, 6, true)).toEqual({ kind: 'smaller' });
  });

  it('asks for a smaller rung while there is one', () => {
    expect(floorFitStep([60, 120, 180], 100, 30, 0, true)).toEqual({ kind: 'smaller' });
  });

  it('on the smallest rung, shows the names that fit whole and counts the rest', () => {
    expect(floorFitStep([60, 120, 180], 100, 30, 0, false)).toEqual({ kind: 'cut', shown: 1 });
    expect(floorFitStep([60, 60, 120], 100, 10, 0, false)).toEqual({ kind: 'cut', shown: 2 });
    // Given back, the line's room is enough: everyone, and no line.
    expect(floorFitStep([60, 60, 120], 100, 30, 0, false)).toEqual({ kind: 'all' });
  });
});

const ROW = 50;
const FULL = ['Alexander Montgomery', 'Isabella Fitzgerald', 'Christopher Walsh', 'Madison Kowalski', 'Benjamin Hartley', 'Olivia Castellano', 'Nathaniel Brooks', 'Gabriella Romano', 'Jonathan Pierce', 'Samantha Delgado', 'Maximilian Hayes', 'Victoria Lindqvist'];

function board(count: number, total = count): WallBoard {
  return {
    generated_at: '2026-10-22T18:30:00.000Z',
    gym_day: '2026-10-22',
    time_zone: 'America/New_York',
    name_mode: 'full',
    sessions: [],
    on_floor: FULL.slice(0, count).map((name, i) => ({ key: `p${i}`, name, visibility: 'full' as const })),
    on_floor_total: total,
    marquee: [],
    notice: null,
  } as WallBoard;
}

/** Fake layout: the list is `room` px tall; each name is a ROW-tall row whose height shrinks one step per rung. */
function fakeLayout(roomFor: (rung: string) => number) {
  const spies = [
    jest.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('wall-name')) return 0;
      return [...(this.parentElement?.children ?? [])].indexOf(this) * ROW;
    }),
    jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('wall-name') || this.classList.contains('wall-more') ? ROW : 0;
    }),
    jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('wall-floor-list')) return 0;
      const room = roomFor(this.getAttribute('data-density') ?? '');
      // The "+N more" line, while measuring, takes its own room out of the list's.
      return this.nextElementSibling?.classList.contains('wall-more') ? room - ROW : room;
    }),
  ];
  return () => spies.forEach((spy) => spy.mockRestore());
}

async function show(payload: WallBoard) {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ session: null, board: payload, quotes: [] }) } as unknown as Response) as unknown as typeof fetch;
  const view = render(<WallDisplay />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-22T18:30:00.000Z'));
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('the floor list on the TV', () => {
  it('steps down a rung when the names do not fit, and shows everyone with no "+N more"', async () => {
    // 12 names at one per row need 600px; the room grows as the names shrink, and the snug rung holds them.
    const restore = fakeLayout((rung) => ({ dense: 300, packed: 400, snug: 600, tight: 800 })[rung] ?? 0);
    const { container } = await show(board(12));
    restore();
    const list = container.querySelector('.wall-floor-list');
    expect(list?.getAttribute('data-density')).toBe('snug');
    expect(list?.querySelectorAll('.wall-name')).toHaveLength(12);
    expect(container.querySelector('.wall-more')).toBeNull();
  });

  it('on the smallest rung, shows only whole names and says how many more are on the floor', async () => {
    const restore = fakeLayout(() => 300);
    const { container } = await show(board(12, 20));
    restore();
    const list = container.querySelector('.wall-floor-list');
    expect(list?.getAttribute('data-density')).toBe(FLOOR_RUNGS[FLOOR_RUNGS.length - 1]);
    // 300px less the line's 50 leaves 250: five whole rows. Twenty on the floor, five named.
    expect(list?.querySelectorAll('.wall-name')).toHaveLength(5);
    const more = screen.getByText('+15 more');
    expect(more.parentElement).toBe(list?.parentElement);
    expect(more.getAttribute('aria-hidden')).toBeNull();
    expect(screen.getByRole('region', { name: 'On the floor' }).textContent).toContain('20');
  });

  it('measures again once the web font for the names has loaded, since the slab face is wider than its fallback', async () => {
    let fontLoaded = false;
    let loaded: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready, addEventListener: jest.fn(), removeEventListener: jest.fn() },
    });
    // Before the font: 12 names fit at the count's own rung. After it: they need the snug rung.
    const restore = fakeLayout((rung) => (fontLoaded ? ({ dense: 300, packed: 400, snug: 600 })[rung] ?? 800 : 800));
    try {
      const { container } = await show(board(12));
      expect(container.querySelector('.wall-floor-list')?.getAttribute('data-density')).toBe('dense');
      fontLoaded = true;
      await act(async () => {
        loaded();
        await ready;
      });
      expect(container.querySelector('.wall-floor-list')?.getAttribute('data-density')).toBe('snug');
      expect(container.querySelectorAll('.wall-name')).toHaveLength(12);
    } finally {
      restore();
      delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });

  it('keeps the count-based rung where there is no layout to measure', async () => {
    const { container } = await show(board(12));
    expect(container.querySelector('.wall-floor-list')?.getAttribute('data-density')).toBe('dense');
    expect(container.querySelectorAll('.wall-name')).toHaveLength(12);
  });
});
