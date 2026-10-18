/**
 * @jest-environment jsdom
 */

import { act, render, screen } from '@testing-library/react';

import WallDisplay, { SESSION_STRIP_MAX, WALL_STALE_MS, pickLiveSession, stripWindow, type WallSessionBlock } from './WallDisplay';
import type { WallBoard } from '@/src/server/pilot/wallDisplay';

/**
 * THE SESSION ON THE TV (lane L39 PR 2). Jason's workout walk-through (OD-2026-10-06-014 Q1,
 * "basically the work out walk through we had talked about timers. Bells wood knocking ect"): a
 * paired TV the coach has sent a live session to shows NOW, the strip of blocks with a pictogram
 * and a word for each kind, and NEXT UP. The paired read has carried these fields since S2b; this
 * screen renders them by name, and only them.
 */

const KINDS = ['arrival', 'instruction', 'demonstration', 'drill_round', 'reset_minute', 'conditioning', 'reflection', 'close'];
const LABELS = ['Arrival and wraps', 'Today: the jab', 'Coach shows it', 'Jab on the bag', 'Water', 'Rope and core', 'One thing learned', 'Close'];

function block(i: number) {
  return {
    block_id: `b${i}`,
    block_order: i + 1,
    block_label: LABELS[i],
    block_kind: KINDS[i],
    drill_name: KINDS[i] === 'drill_round' ? 'Jab - double jab' : null,
    scale_level: null,
    start_offset_min: i * 5,
    end_offset_min: i * 5 + 5,
  };
}

const BLOCKS = KINDS.map((_, i) => block(i));

function session(over: Record<string, unknown> = {}) {
  return {
    run_id: 'run-1',
    script_name: 'Jab night',
    total_minutes: 40,
    started_at: '2026-08-03T18:14:00.000Z',
    server_time: '2026-08-03T18:30:00.000Z',
    elapsed_seconds: 960,
    is_paused: false,
    current_block: { ...BLOCKS[3], seconds_to_scheduled_end: 480 },
    next_block: BLOCKS[4],
    blocks: BLOCKS,
    timer: null,
    ...over,
  };
}

function board(over: Partial<WallBoard> = {}): WallBoard {
  return {
    generated_at: '2026-08-03T18:30:00.000Z',
    gym_day: '2026-08-03',
    time_zone: 'America/New_York',
    name_mode: 'initials',
    sessions: [
      { key: 'c1', title: 'Open Gym', start_at: '2026-08-03T18:00:00.000Z', end_at: '2026-08-03T19:00:00.000Z', location: 'Main floor', state: 'now', on_floor: 2 },
    ],
    on_floor: [
      { key: 'p1', name: 'A.B.', visibility: 'initials' },
      { key: 'p2', name: 'C.D.', visibility: 'initials' },
    ],
    on_floor_total: 2,
    marquee: [],
    notice: null,
    ...over,
  };
}

/** A paired TV: every read answers with this payload. */
function paired(payload: unknown) {
  return jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload } as unknown as Response);
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-03T18:30:00.000Z'));
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function strip(container: HTMLElement): HTMLLIElement[] {
  return [...container.querySelectorAll<HTMLLIElement>('ol[aria-label="Today\'s session"] > li')];
}

describe('the session on a paired TV', () => {
  it('puts up NOW, the strip and NEXT UP, and shrinks the board around them', async () => {
    global.fetch = paired({ session: session(), board: board(), quotes: [] }) as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();

    const now = screen.getByRole('region', { name: 'Now' });
    expect(now.textContent).toContain('Jab on the bag');
    expect(now.textContent).toContain('Jab - double jab');
    expect(now.textContent).toContain('Drill');
    expect(now.textContent).toContain('Block 4 of 8');
    expect(now.textContent).toContain('8:00');

    const tiles = strip(container);
    expect(tiles).toHaveLength(SESSION_STRIP_MAX);
    // Eight blocks, the coach on the fourth: the row slides back one so it stays full.
    expect(tiles.map((tile) => tile.querySelector('.wall-strip-number')?.textContent)).toEqual(['2', '3', '4', '5', '6', '7', '8']);
    const current = tiles.filter((tile) => tile.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0].dataset.state).toBe('now');
    expect(current[0].textContent).toContain('Drill');
    expect(tiles.map((tile) => tile.dataset.state)).toEqual(['done', 'done', 'now', 'next', 'next', 'next', 'next']);
    for (const tile of tiles) expect(tile.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    const next = screen.getByRole('region', { name: 'Next up' });
    expect(next.textContent).toContain('Water');
    expect(next.textContent).toContain('Reset');

    expect(screen.getByRole('region', { name: 'On the floor' }).textContent).toContain('A.B.');
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull();
  });

  it('says Paused and holds the plan time while the coach has paused', async () => {
    global.fetch = paired({ session: session({ is_paused: true }), board: board(), quotes: [] }) as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    const now = screen.getByRole('region', { name: 'Now' });
    expect(now.textContent).toContain('Paused');
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    expect(screen.getByRole('region', { name: 'Now' }).textContent).toContain('8:00');
  });

  it('counts the plan time down between reads while the session runs', async () => {
    global.fetch = paired({ session: session(), board: board(), quotes: [] }) as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Now' }).textContent).not.toContain('Paused');
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    expect(screen.getByRole('region', { name: 'Now' }).textContent).toContain('7:57');
  });

  it('asks again within one short poll while a session is up, so a coach\'s Next reaches the room', async () => {
    const fetchMock = paired({ session: session(), board: board(), quotes: [] });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the thirty-second poll when no session is up', async () => {
    const fetchMock = paired({ session: null, board: board(), quotes: [] });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Today' })).toBeTruthy();
  });

  it('goes back to the board when the session comes off the TV', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ session: session(), board: board(), quotes: [] }) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ session: null, board: board(), quotes: [] }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Now' })).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await settle();
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Today' })).toBeTruthy();
  });

  it('takes the session down once its reading is as old as a stale board', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ session: session(), board: board(), quotes: [] }) })
      .mockRejectedValue(new Error('network'));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Now' })).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(WALL_STALE_MS);
    });
    await settle();
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
  });

  it('never prints a field that is not on the TV\'s list', async () => {
    const leaky = session({
      what_to_say: 'COACH NOTE ONE',
      current_block: { ...BLOCKS[3], seconds_to_scheduled_end: 480, what_to_say: 'COACH NOTE TWO', watch: 'COACH NOTE THREE' },
      blocks: BLOCKS.map((b) => ({ ...b, fix: 'COACH NOTE FOUR' })),
    });
    global.fetch = paired({ session: leaky, board: board(), quotes: [] }) as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Now' })).toBeTruthy();
    expect(container.textContent).not.toContain('COACH NOTE');
  });

  it('follows the coach through a board outage: a read with no board still moves NOW', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ session: session(), board: board(), quotes: [] }) })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          session: session({ current_block: { ...BLOCKS[4], seconds_to_scheduled_end: 60 }, next_block: BLOCKS[5] }),
          board: null,
          board_status: 'unavailable',
        }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Now' }).textContent).toContain('Jab on the bag');
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('region', { name: 'Now' }).textContent).toContain('Water');
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('says "Last block." only on the last block, and nothing when the coach is on none', async () => {
    global.fetch = paired({
      session: session({ current_block: { ...BLOCKS[7], seconds_to_scheduled_end: 60 }, next_block: null }),
      board: board(),
      quotes: [],
    }) as unknown as typeof fetch;
    const view = render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Next up' }).textContent).toContain('Last block.');
    view.unmount();

    global.fetch = paired({ session: session({ current_block: null, next_block: null }), board: board(), quotes: [] }) as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Next up' }).textContent).not.toContain('Last block.');
  });

  it('takes NEXT UP from the plan when the next block did not come through', async () => {
    global.fetch = paired({ session: session({ next_block: { block_id: 'broken' } }), board: board(), quotes: [] }) as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Next up' }).textContent).toContain('Water');
  });

  it('steps the names down as the room fills while a session is up', async () => {
    const people = Array.from({ length: 16 }, (_, i) => ({ key: `p${i}`, name: `P${i}.`, visibility: 'initials' as const }));
    global.fetch = paired({ session: session(), board: board({ on_floor: people, on_floor_total: 16 }), quotes: [] }) as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();
    expect(container.querySelector('.wall-floor-list')?.getAttribute('data-density')).toBe('session-packed');
  });

  it('carries cream enamel only on the sign bands, the clock plate and the strip numbers (burn-in)', async () => {
    global.fetch = paired({ session: session(), board: board(), quotes: [] }) as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();
    const enamelled = [...container.querySelectorAll('.ge-enamel')].map((el) => `${el.tagName.toLowerCase()}.${el.classList[0]}`);
    expect(enamelled.filter((name) => name !== 'span.wall-strip-number').sort()).toEqual(
      ['h2.wall-heading', 'h2.wall-heading', 'h2.wall-heading', 'p.wall-clock'],
    );
    expect(enamelled.filter((name) => name === 'span.wall-strip-number')).toHaveLength(SESSION_STRIP_MAX);
  });

  it('keeps only the fields it names, whatever else the payload carries', () => {
    const leaky = session({
      what_to_say: 'COACH NOTE ONE',
      blocks: BLOCKS.map((b) => ({ ...b, fix: 'COACH NOTE FOUR', what_to_say: 'COACH NOTE FIVE' })),
    });
    const picked = pickLiveSession(leaky);
    expect(Object.keys(picked ?? {}).sort()).toEqual(
      ['blocks', 'current_block_id', 'is_paused', 'next_block_id', 'run_id', 'scheduled_seconds_left', 'script_name'],
    );
    for (const picked_block of picked?.blocks ?? []) {
      expect(Object.keys(picked_block).sort()).toEqual(
        ['block_id', 'block_kind', 'block_label', 'block_order', 'drill_name', 'end_offset_min', 'start_offset_min'],
      );
    }
  });

  it('takes the session down at once when the TV is told it is no longer paired', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ session: session(), board: board(), quotes: [] }) })
      .mockImplementation(async (url: string) =>
        url.includes('/api/pilot/tv/session')
          ? ({ ok: false, status: 401, json: async () => ({ error: 'TV_NOT_PAIRED' }) } as unknown as Response)
          : ({ ok: false, status: 503, json: async () => ({}) } as unknown as Response));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('region', { name: 'Now' })).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await settle();
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
  });

  it('shows no session on an unpaired TV, whatever the public read carries', async () => {
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/pilot/tv/session')) {
        return { ok: false, status: 401, json: async () => ({ error: 'TV_NOT_PAIRED' }) } as unknown as Response;
      }
      const { generated_at, gym_day, time_zone, sessions, on_floor_total, notice } = board();
      const publicBoard = { scope: 'public', generated_at, gym_day, time_zone, sessions, on_floor_total, notice };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, board: publicBoard, session: session() }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
    expect(strip(container)).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'Today' })).toBeTruthy();
  });
});

describe('which blocks the strip shows', () => {
  const plan: WallSessionBlock[] = Array.from({ length: 62 }, (_, i) => ({
    block_id: `b${i}`,
    block_order: i + 1,
    block_label: `Block ${i + 1}`,
    block_kind: 'drill_round',
    drill_name: null,
    start_offset_min: i,
    end_offset_min: i + 1,
  }));
  const orders = (blocks: WallSessionBlock[]) => blocks.map((b) => b.block_order);

  it('shows the block before the current one, the current one, and what follows', () => {
    expect(orders(stripWindow(plan, 'b29'))).toEqual([29, 30, 31, 32, 33, 34, 35]);
  });

  it('keeps the row full at the end of a long plan', () => {
    expect(orders(stripWindow(plan, 'b61'))).toEqual([56, 57, 58, 59, 60, 61, 62]);
  });

  it('starts at the first block before the coach has reached one', () => {
    expect(orders(stripWindow(plan, null))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(orders(stripWindow(plan, 'b0'))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('shows a short plan whole', () => {
    expect(orders(stripWindow(plan.slice(0, 3), 'b1'))).toEqual([1, 2, 3]);
  });
});
