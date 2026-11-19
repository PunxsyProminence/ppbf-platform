/**
 * @jest-environment jsdom
 */

/*
 * Gym tablet idle sign-out (lane U1, AS2-b; OW25-53 A, Overwatch Q1 = A).
 * Fake timers drive the clock: Date.now() and the 1-second tick move together.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import TabletIdleSignOut from './TabletIdleSignOut';
import { clearRoleSession } from './roleSession';
import { setGymTabletMark } from '@/src/lib/gymTabletMark';
import { endThisSession, leaveForLogin } from '@/src/lib/signOut';

jest.mock('./roleSession', () => ({ clearRoleSession: jest.fn() }));
jest.mock('@/src/lib/signOut', () => ({ endThisSession: jest.fn(), leaveForLogin: jest.fn() }));

const mockEnd = endThisSession as jest.Mock;
const mockLeave = leaveForLogin as jest.Mock;
const mockClear = clearRoleSession as jest.Mock;

const MINUTE = 60_000;

function idleRead(response: { ok: boolean; status?: number; body?: unknown }) {
  global.fetch = jest.fn(async (url: unknown) => {
    if (String(url).includes('/api/pilot/gym-tablet/idle')) {
      return { ok: response.ok, status: response.status ?? 200, json: async () => response.body } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ authenticated: true }) } as Response;
  }) as unknown as typeof fetch;
}

async function mount() {
  await act(async () => {
    render(<TabletIdleSignOut />);
  });
  // Let the idle-time read settle.
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

const originalFetch = global.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-19T18:00:00Z'));
  window.localStorage.clear();
  mockEnd.mockReset().mockResolvedValue(true);
  mockLeave.mockReset();
  mockClear.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
});

describe('a device that is not marked', () => {
  test('shows nothing, reads nothing, and never signs out', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    expect(screen.queryByText('Gym tablet')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    await advance(5 * 60 * MINUTE);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockEnd).not.toHaveBeenCalled();
    expect(mockLeave).not.toHaveBeenCalled();
  });
});

describe('a marked gym tablet', () => {
  beforeEach(() => {
    setGymTabletMark(true);
  });

  test('shows the "Gym tablet" plate and reads the gym\'s time', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    expect(screen.getByText('Gym tablet')).toBeTruthy();
    expect((global.fetch as jest.Mock).mock.calls.some(([url]) => String(url).includes('/api/pilot/gym-tablet/idle'))).toBe(true);
  });

  test('counts down in the last minute, and a tap anywhere keeps it signed in', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();

    await advance(14 * MINUTE - 1_000);
    expect(screen.queryByRole('alert')).toBeNull();

    await advance(2_000);
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('No one has used this tablet for a while. Signing out in 0:59.');
    expect(banner.textContent).toContain('Tap anywhere to stay signed in. Anything not saved on this screen will be lost.');
    expect(banner.getAttribute('data-surface')).toBe('kiosk');

    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    expect(screen.queryByRole('alert')).toBeNull();

    // The time starts again from the tap.
    await advance(14 * MINUTE - 1_000);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  test('"Stay signed in" keeps it signed in', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    await advance(14 * MINUTE + 5_000);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    await advance(10 * MINUTE);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  test('at the limit it covers the page, ends the session, clears the role session and leaves for /login', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    let finish: (value: boolean) => void = () => {};
    mockEnd.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    await mount();

    await advance(15 * MINUTE);
    expect(screen.getByRole('alert').textContent).toBe('Signing out…');
    expect(mockEnd).toHaveBeenCalledTimes(1);
    // Nothing is cleared, and nobody leaves, until the server says the session is gone.
    expect(mockClear).not.toHaveBeenCalled();
    expect(mockLeave).not.toHaveBeenCalled();

    // A tap while signing out does not bring the page back.
    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    expect(screen.getByRole('alert').textContent).toBe('Signing out…');

    await act(async () => {
      finish(true);
      await Promise.resolve();
    });
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockLeave).toHaveBeenCalledTimes(1);
  });

  test('with no connection the cover stays, says so, and retries until the session is ended', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    mockEnd.mockResolvedValue(false);
    await mount();

    await advance(15 * MINUTE);
    expect(screen.getByRole('alert').textContent).toBe('This tablet could not finish signing out: no connection. It keeps trying.');
    expect(mockLeave).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();

    await advance(15_000);
    expect(mockEnd).toHaveBeenCalledTimes(2);

    mockEnd.mockResolvedValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
    });
    expect(mockLeave).toHaveBeenCalledTimes(1);
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  test('woken after the limit has passed, it signs out at once with no countdown', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();

    // The tablet slept: the clock moved, the tick did not run.
    jest.setSystemTime(new Date('2026-11-19T19:00:00Z'));
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(screen.queryByText(/Signing out in/)).toBeNull();
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockLeave).toHaveBeenCalledTimes(1);
  });

  test('with no setting saved, the default one hour applies', async () => {
    idleRead({ ok: true, body: { idle_minutes: 60, is_default: true } });
    await mount();
    await advance(59 * MINUTE - 1_000);
    expect(screen.queryByRole('alert')).toBeNull();
    await advance(2_000);
    expect(screen.getByRole('alert').textContent).toContain('Signing out in 0:59');
  });

  test('if the time cannot be read, it still signs out after one hour, never "no sign-out"', async () => {
    idleRead({ ok: false, status: 403, body: { error: 'Forbidden' } });
    await mount();
    await advance(60 * MINUTE);
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockLeave).toHaveBeenCalledTimes(1);
  });

  test('unmarking stops it', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    await act(async () => {
      setGymTabletMark(false);
    });
    expect(screen.queryByText('Gym tablet')).toBeNull();
    await advance(60 * MINUTE);
    expect(mockEnd).not.toHaveBeenCalled();
  });
});

describe('Back after a sign-out, on any device', () => {
  test('a page restored from the back/forward cache leaves for /login when nobody is signed in', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ authenticated: false }) } as Response)) as unknown as typeof fetch;
    await mount();
    const restored = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restored, 'persisted', { value: true });
    await act(async () => {
      window.dispatchEvent(restored);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockLeave).toHaveBeenCalledTimes(1);
  });

  test('a restored page with a live session stays', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ authenticated: true }) } as Response)) as unknown as typeof fetch;
    await mount();
    const restored = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restored, 'persisted', { value: true });
    await act(async () => {
      window.dispatchEvent(restored);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockLeave).not.toHaveBeenCalled();
  });
});
