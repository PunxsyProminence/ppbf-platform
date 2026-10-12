/**
 * @jest-environment jsdom
 */

// The paired gym TV's sound control (WO-N1-02). The engine is the app's one
// sound engine (useGymSound); here it is faked so each test can say what state
// it is in and see exactly what the wall asked it to do.

import { act, fireEvent, render, screen } from '@testing-library/react';

import WallDisplay from './WallDisplay';
import type { WallBoard } from '@/src/server/pilot/wallDisplay';

type Status = 'off' | 'arming' | 'on' | 'unavailable';

const sound = {
  enabled: false,
  ready: false,
  status: 'off' as Status,
  play: jest.fn(() => true),
  setEnabled: jest.fn(async (on: boolean) => on),
};

jest.mock('./useGymSound', () => ({
  __esModule: true,
  default: () => sound,
}));

function board(): WallBoard {
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
  } as WallBoard;
}

const PAIRED = { tv: { tv_name: 'Gym main' }, session: null, board: board(), board_status: 'ok' };

function pairedFetch() {
  return jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => PAIRED } as unknown as Response);
}

function unpairedFetch() {
  return jest.fn().mockImplementation(async (url: string) => {
    if (url.includes('/api/pilot/tv/session')) {
      return { ok: false, status: 401, json: async () => ({ error: 'TV_NOT_PAIRED' }) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, board: { ...board(), scope: 'public' } }),
    } as unknown as Response;
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setSound(status: Status) {
  sound.status = status;
  sound.enabled = status !== 'off';
  sound.ready = status === 'on';
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-03T18:30:00.000Z'));
  setSound('off');
  sound.play.mockClear();
  sound.setEnabled.mockClear();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('the TV sound control', () => {
  test('shows on a paired screen, and says sound is off until somebody turns it on', async () => {
    global.fetch = pairedFetch() as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    const toggle = screen.getByRole('button', { name: 'Sound off' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Test bell' })).toBeNull();
    expect(sound.play).not.toHaveBeenCalled();
  });

  test('is absent on an unpaired screen, where the pair box stays the only control', async () => {
    global.fetch = unpairedFetch() as unknown as typeof fetch;
    const { container } = render(<WallDisplay />);
    await settle();
    expect(screen.queryByRole('group', { name: 'TV sound' })).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  test('turning sound on is the press that starts audio, and rings the bell once to prove it', async () => {
    global.fetch = pairedFetch() as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    });
    expect(sound.setEnabled).toHaveBeenCalledWith(true);
    expect(sound.play.mock.calls).toEqual([['bell']]);
  });

  test('no bell when the browser refuses to start audio', async () => {
    sound.setEnabled.mockResolvedValueOnce(false);
    global.fetch = pairedFetch() as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sound off' }));
    });
    expect(sound.play).not.toHaveBeenCalled();
  });

  test('with sound on, "Test bell" rings once per press and the switch turns it off', async () => {
    setSound('on');
    global.fetch = pairedFetch() as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Test bell' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test bell' }));
    expect(sound.play.mock.calls).toEqual([['bell'], ['bell']]);

    const toggle = screen.getByRole('button', { name: 'Sound on' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(sound.setEnabled).toHaveBeenCalledWith(false);
    expect(sound.play.mock.calls).toEqual([['bell'], ['bell']]);
  });

  test.each([
    ['arming', 'Sound waiting'],
    ['unavailable', 'No audio'],
  ] as const)('a %s engine says "%s" and offers no test bell', async (status, label) => {
    setSound(status);
    global.fetch = pairedFetch() as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    expect(screen.getByRole('button', { name: label })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Test bell' })).toBeNull();
  });

  test('a poll does not ring anything or touch the sound setting', async () => {
    setSound('on');
    const fetchMock = pairedFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<WallDisplay />);
    await settle();
    const reads = fetchMock.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    await settle();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(reads);
    expect(sound.play).not.toHaveBeenCalled();
    expect(sound.setEnabled).not.toHaveBeenCalled();
    expect(screen.getAllByRole('group', { name: 'TV sound' })).toHaveLength(1);
  });
});
