/**
 * @jest-environment jsdom
 */

/**
 * The wall runs unattended for twelve hours in front of the whole gym, so what
 * these tests pin is mostly what happens when something goes wrong: it refreshes
 * itself, it never blanks, it never prints an error, and it stops asserting who
 * is in the room once its data is too old to be true.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';

import WallDisplay, {
  WALL_ABANDON_MS,
  WALL_POLL_MS,
  WALL_STALE_MS,
  boardHealth,
  floorDensity,
  formatClock,
  nextPollDelayMs,
  parseTimestamp,
} from './WallDisplay';
import type { WallBoard } from '@/src/server/pilot/wallDisplay';

function board(over: Partial<WallBoard> = {}): WallBoard {
  return {
    generated_at: '2026-08-03T18:30:00.000Z',
    gym_day: '2026-08-03',
    time_zone: 'America/New_York',
    name_mode: 'initials',
    sessions: [],
    on_floor: [],
    on_floor_total: 0,
    marquee: [],
    notice: null,
    ...over,
  };
}

function respondWith(payload: unknown, ok = true) {
  return jest.fn().mockResolvedValue({
    ok,
    json: async () => payload,
  } as unknown as Response);
}

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-03T18:30:00.000Z'));
  fetchMock = respondWith({ ok: true, board: board() });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** Let the pending fetch promise chain settle inside act(). */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/* --------------------------------------------------------------- policy -- */

describe('refresh policy', () => {
  it('polls on a steady interval while things are working', () => {
    expect(nextPollDelayMs(0)).toBe(WALL_POLL_MS);
  });

  it('comes back FASTER after a failure, not slower', () => {
    // The point is the screen recovering the moment the network does. The ramp
    // only exists so a genuinely dead backend is not hammered forever.
    expect(nextPollDelayMs(1)).toBe(5_000);
    expect(nextPollDelayMs(2)).toBe(10_000);
    expect(nextPollDelayMs(3)).toBe(20_000);
  });

  it('never backs off past the steady interval', () => {
    for (const failures of [4, 8, 40, 4000]) {
      expect(nextPollDelayMs(failures)).toBe(WALL_POLL_MS);
    }
  });
});

describe('board health', () => {
  const t = 1_000_000;

  it('is fresh right after a good read', () => {
    expect(boardHealth(t, t + 1_000)).toBe('fresh');
  });

  it('goes stale, then stops claiming altogether', () => {
    expect(boardHealth(t, t + WALL_STALE_MS)).toBe('stale');
    expect(boardHealth(t, t + WALL_ABANDON_MS)).toBe('abandoned');
  });

  it('reports never when no read has ever landed', () => {
    expect(boardHealth(null, t)).toBe('never');
  });
});

describe('timestamps', () => {
  it('reads the non-ISO form Postgres hands back for a timestamptz', () => {
    expect(parseTimestamp('2026-08-03 17:00:00+00')?.toISOString()).toBe('2026-08-03T17:00:00.000Z');
  });

  it('returns an em dash rather than "Invalid Date" at sixty pixels', () => {
    expect(parseTimestamp('whenever')).toBeNull();
    expect(formatClock('whenever')).toBe('—');
    expect(formatClock(null)).toBe('—');
  });
});

/* ------------------------------------------------------------ behaviour -- */

describe('WallDisplay', () => {
  it('reads the board once on mount and again on the interval, with nobody touching it', async () => {
    render(<WallDisplay />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/pilot/wall');

    await act(async () => {
      jest.advanceTimersByTime(WALL_POLL_MS);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the gym\'s name and a clock before any data has arrived', () => {
    // The standing state. It must be true without a network, because that is
    // the one moment it has to carry the room on its own.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    render(<WallDisplay />);
    expect(screen.getByText(/Punxsy Prominence/i)).toBeTruthy();
    expect(screen.getByText(/coming up/i)).toBeTruthy();
  });

  it('never puts an error, a status code or a stack trace on the wall', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.4:5432'));
    const { container } = render(<WallDisplay />);
    await settle();

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/error|failed|econnrefused|undefined|NaN|5432|503/i);
    expect(screen.getByText(/reconnecting|coming up/i)).toBeTruthy();
  });

  it('keeps the last good board on screen when a read fails, and dates it', async () => {
    render(<WallDisplay />);
    await settle();

    fetchMock.mockRejectedValue(new Error('network'));
    await act(async () => {
      jest.advanceTimersByTime(WALL_POLL_MS);
    });
    await settle();

    // Still the board, not a blank screen -- and honest about its age.
    expect(screen.getByText(/On the floor/i)).toBeTruthy();
    expect(screen.getByText(/^As of /)).toBeTruthy();
  });

  it('retries five seconds after a failure rather than waiting out the full interval', async () => {
    render(<WallDisplay />);
    await settle();
    fetchMock.mockRejectedValue(new Error('network'));

    await act(async () => {
      jest.advanceTimersByTime(WALL_POLL_MS);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops naming who is in the room once the board is too old to be true', async () => {
    fetchMock = respondWith({
      ok: true,
      board: board({
        on_floor: [{ key: 'k1', name: 'M.R.', visibility: 'initials' }],
        on_floor_total: 1,
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<WallDisplay />);
    await settle();
    expect(screen.getByText('M.R.')).toBeTruthy();

    // A list from forty minutes ago is not stale, it is false: it names a child
    // as being in a room they may have left.
    fetchMock.mockRejectedValue(new Error('network'));
    await act(async () => {
      jest.advanceTimersByTime(WALL_ABANDON_MS + 1_000);
    });
    await settle();

    await waitFor(() => expect(screen.queryByText('M.R.')).toBeNull());
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
  });

  it('treats a 200 that is not ok:true as a failure rather than rendering nothing', async () => {
    fetchMock = respondWith({ ok: false, error: 'The board is unavailable.' });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(<WallDisplay />);
    await settle();
    expect(container.textContent).not.toContain('unavailable');
    expect(screen.getByText(/coming up/i)).toBeTruthy();
  });

  it('does not ship a build-time clock in the prerendered HTML', () => {
    // /wall prerenders. A clock initialised from Date.now() is BUILD time, so
    // the shipped HTML carried a fixed date and every browser showed that stale
    // instant until hydration -- on the one screen in the building whose entire
    // job is to be true. The masthead holds space instead and the first tick
    // fills it.
    const html = renderToStaticMarkup(<WallDisplay />);
    expect(html).toContain('Punxsy Prominence');
    expect(html).not.toMatch(/\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b/);
    expect(html).not.toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i);
  });

  it('does not stack up polls when the television wakes the tab', async () => {
    // A visibilitychange arriving mid-request used to start a second poll; both
    // finished, both scheduled a timer, and only the later one was tracked --
    // so the orphan kept firing and the wall doubled its request rate every
    // time the TV woke up.
    let release: (() => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, json: async () => ({ ok: true, board: board() }) } as unknown as Response);
        }),
    );

    render(<WallDisplay />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (let i = 0; i < 5; i += 1) document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await settle();

    // And the single timer that was scheduled is the only one still running.
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, board: board() }) } as unknown as Response);
    await act(async () => {
      jest.advanceTimersByTime(WALL_POLL_MS);
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops polling when the display unmounts', async () => {
    const { unmount } = render(<WallDisplay />);
    await settle();
    unmount();

    await act(async () => {
      jest.advanceTimersByTime(WALL_POLL_MS * 4);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* --------------------------------------------------------- empty states -- */

describe('empty states', () => {
  async function renderBoard(over: Partial<WallBoard>) {
    fetchMock = respondWith({ ok: true, board: board(over) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const view = render(<WallDisplay />);
    await settle();
    return view;
  }

  it('says the gym is empty rather than showing a blank panel', async () => {
    await renderBoard({});
    expect(screen.getByText(/Nobody checked in yet today/i)).toBeTruthy();
  });

  it('says the schedule is empty rather than showing a blank panel', async () => {
    await renderBoard({});
    expect(screen.getByText(/Nothing on the schedule/i)).toBeTruthy();
  });

  it('reports a headcount without names when the operator has names switched off', async () => {
    await renderBoard({ name_mode: 'off', on_floor: [], on_floor_total: 7 });
    expect(screen.getByText(/7 people training/i)).toBeTruthy();
  });

  it('steps the floor names down the ladder as the room fills, instead of clipping', async () => {
    // Overflow:hidden on the list would hide the last row rather than report
    // it, which is a list that lies about who is in the room.
    expect(floorDensity(1)).toBe('roomy');
    expect(floorDensity(8)).toBe('roomy');
    expect(floorDensity(9)).toBe('dense');
    expect(floorDensity(15)).toBe('packed');

    const { container } = await renderBoard({
      on_floor: Array.from({ length: 15 }, (_, i) => ({ key: `k${i}`, name: 'M.R.', visibility: 'initials' as const })),
      on_floor_total: 15,
    });
    expect(container.querySelector('.wall-floor-list')?.getAttribute('data-density')).toBe('packed');
  });

  it('reports the people it could not fit rather than dropping them silently', async () => {
    await renderBoard({
      on_floor: [{ key: 'k1', name: 'M.R.', visibility: 'initials' }],
      on_floor_total: 24,
    });
    expect(screen.getByText('+23 more')).toBeTruthy();
    expect(screen.getByText('24')).toBeTruthy();
  });

  it('keeps the gym\'s voice slot even when nothing is posted', async () => {
    // The slot is the point: an empty line is the gym choosing to say nothing
    // today, which is a different thing from the slot not existing.
    await renderBoard({});
    expect(screen.getByText(/Nothing posted today/i)).toBeTruthy();
  });

  it('prints a posted notice and credits whoever posted it', async () => {
    await renderBoard({
      notice: { message: 'Closed Monday for the holiday.', author: 'Coach Dan · coach', posted_at: '2026-08-01T12:00:00.000Z' },
    });
    expect(screen.getByText('Closed Monday for the holiday.')).toBeTruthy();
    expect(screen.getByText(/Coach Dan/)).toBeTruthy();
  });

  it('keeps the marquee band and states the ladder when nobody has crossed anything', async () => {
    // Not an invented number: 5/13/34/89/233 is the ladder itself. A band that
    // appears and disappears would also reflow the whole board.
    const { container } = await renderBoard({});
    expect(container.querySelector('.marquee')).not.toBeNull();
    expect(screen.getByText('5 · 13 · 34 · 89 · 233')).toBeTruthy();
  });

  it('puts a crossing up with the name the server decided on, and nothing more', async () => {
    const { container } = await renderBoard({
      marquee: [{ key: 'k1-34', name: 'Marcus', visibility: 'first_name', milestone: 34, crossed_on: '2026-08-03' }],
    });
    expect(screen.getAllByText('Marcus').length).toBeGreaterThan(0);
    expect(screen.getAllByText('34').length).toBeGreaterThan(0);
    // The travelling loop needs the run twice; the echo is hidden from readers.
    expect(container.querySelectorAll('.marquee-run')).toHaveLength(2);
    expect(container.querySelector('.marquee-run[aria-hidden="true"]')).not.toBeNull();
  });
});

/* ------------------------------------------------------------- nothing to
   touch --------------------------------------------------------------- */

describe('it is a display, not an interface', () => {
  it('renders no control of any kind', async () => {
    fetchMock = respondWith({
      ok: true,
      board: board({
        sessions: [{ key: 'c1', title: 'Youth Boxing', start_at: '2026-08-03T22:00:00.000Z', end_at: '2026-08-03T23:00:00.000Z', location: 'Floor', state: 'upcoming', on_floor: 3 }],
        on_floor: [{ key: 'k1', name: 'M.R.', visibility: 'initials' }],
        on_floor_total: 1,
        marquee: [{ key: 'k1-5', name: 'M.R.', visibility: 'initials', milestone: 5, crossed_on: '2026-08-02' }],
        notice: { message: 'Open mat Saturday.', author: 'Coach Dan', posted_at: '2026-08-01T12:00:00.000Z' },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { container } = render(<WallDisplay />);
    await settle();

    for (const selector of ['button', 'a', 'input', 'select', 'textarea', 'form', '[role="button"]', '[tabindex]']) {
      expect({ selector, found: container.querySelectorAll(selector).length }).toEqual({ selector, found: 0 });
    }
  });
});
