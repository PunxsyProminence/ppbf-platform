/**
 * @jest-environment jsdom
 */

/*
 * Gym tablet idle sign-out (lane U1, AS2-b; OW25-53 A, Overwatch Q1 = A).
 * Fake timers drive the clock: Date.now() and the 1-second tick move together.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import TabletIdleSignOut, { resetTabletSignOutForTests } from './TabletIdleSignOut';
import { clearRoleSession } from './roleSession';
import {
  readGymTabletLastUse,
  readGymTabletSignedOutAt,
  setGymTabletMark,
  writeGymTabletLastUse,
  writeGymTabletSignedOutAt,
} from '@/src/lib/gymTabletMark';
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
  resetTabletSignOutForTests();
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
    /* AS2-d: pinned by inline style, because app/globals.css's unlayered
       `body > *` (position: relative; z-index: 2) beats Tailwind's layered
       `fixed`. jsdom applies no stylesheet cascade, so this pins the inline
       style that wins it; that the banner sits at the bottom of a long page
       is for the signed-in tablet check. */
    expect(banner.parentElement).toBe(document.body);
    expect(banner.style.position).toBe('fixed');
    expect(banner.style.bottom).toBe('0px');
    expect(banner.style.left).toBe('0px');
    expect(banner.style.right).toBe('0px');
    expect(banner.style.zIndex).toBe('1000');

    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    expect(screen.queryByRole('alert')).toBeNull();

    // The time starts again from the tap.
    await advance(14 * MINUTE - 1_000);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  /* Review B: hidden at the press, the banner would let the tap land on the
     page under it. A press on the banner keeps it until its own click. */
  test('a press on "Stay signed in" keeps the banner until the click lands on the button', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    await advance(14 * MINUTE + 5_000);
    const button = screen.getByRole('button', { name: 'Stay signed in' });
    await act(async () => {
      fireEvent.pointerDown(button);
    });
    expect(screen.getByRole('button', { name: 'Stay signed in' })).toBe(button);
    /* AS2-d review B: the press restarted the time, so a tick while the
       finger is still down used to hide the banner under it. Held, it stays. */
    await advance(1_000);
    expect(screen.getByRole('button', { name: 'Stay signed in' })).toBe(button);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.queryByText(/Signing out in/)).toBeNull();
    await advance(10 * MINUTE);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  test('a second press before the last lift is released keeps the hold', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    await advance(14 * MINUTE + 5_000);
    const banner = screen.getByRole('alert');
    await act(async () => {
      fireEvent.pointerDown(banner);
      fireEvent.pointerUp(banner);
    });
    await advance(200);
    await act(async () => {
      fireEvent.pointerDown(banner);
    });
    // The first lift's release (500 ms) has passed and a tick has run: still held.
    await advance(1_500);
    expect(screen.getByRole('alert')).toBe(banner);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  test('a hold whose lift never arrives is let go after ten seconds', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    await advance(14 * MINUTE + 5_000);
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('alert'));
    });
    await advance(9_000);
    expect(screen.getByRole('alert')).toBeTruthy();
    await advance(2_000);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  /* AS2-d review B: a finger that lands on the banner's text (not the button)
     and lifts. The banner stays through the lift and the click the browser
     makes from it, then goes, and the time has started again. */
  test('a press held on the banner keeps it up until a moment after the lift', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    await advance(14 * MINUTE + 5_000);
    const banner = screen.getByRole('alert');
    await act(async () => {
      fireEvent.pointerDown(banner);
    });
    await advance(2_000);
    expect(screen.getByRole('alert')).toBe(banner);
    await act(async () => {
      fireEvent.pointerUp(banner);
    });
    await advance(300);
    expect(screen.getByRole('alert')).toBe(banner);
    await advance(1_500);
    expect(screen.queryByRole('alert')).toBeNull();
    await advance(10 * MINUTE);
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
    expect(screen.getByRole('alert').textContent).toBe('This tablet could not finish signing out. It keeps trying.');
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

  /* AS2-b review A, BLOCKER: a tablet that wakes often RELOADS the page. The
     clock is the device's, kept in storage, so a reload resumes it. */
  test("a page reloaded after the limit signs out at once: the clock is the device's, not the page's", async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    writeGymTabletLastUse(Date.now() - 20 * MINUTE);
    await mount();
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockLeave).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Signing out in/)).toBeNull();
  });

  test('a page reloaded inside the limit resumes the clock rather than starting it again', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    writeGymTabletLastUse(Date.now() - 10 * MINUTE);
    await mount();
    await advance(4 * MINUTE + 1_000);
    expect(screen.getByRole('alert').textContent).toContain('Signing out in 0:59');
  });

  test('use in another tab counts: this tab does not sign out someone working there', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    await advance(10 * MINUTE);
    writeGymTabletLastUse(Date.now()); // the other tab's tap
    await advance(10 * MINUTE);
    expect(mockEnd).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('use is written for the device, at most every two seconds', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    const start = readGymTabletLastUse();
    await advance(5_000);
    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    expect(readGymTabletLastUse()).toBe((start ?? 0) + 5_000);
    await advance(500);
    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    expect(readGymTabletLastUse()).toBe((start ?? 0) + 5_000);
  });

  /* AS2-b review A: nothing under the cover can take focus or keys, and a
     plain cover stays up after the role session is cleared, until /login. */
  test('while covered the page under it is inert, and a plain cover stays on the way to /login', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    let finish: (value: boolean) => void = () => {};
    mockEnd.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    await mount();

    await advance(15 * MINUTE);
    expect(field.closest('[inert]')).not.toBeNull();
    expect(document.activeElement).not.toBe(field);

    await act(async () => {
      finish(true);
      await Promise.resolve();
    });
    const leaving = document.getElementById('gym-tablet-leaving');
    expect(leaving?.textContent).toBe('Signing out…');
    expect(mockClear).toHaveBeenCalledTimes(1);
    field.remove();
  });

  /* AS2-b review A, re-review: another component may clear the role cache
     (and unmount this watcher) while the session is still alive. Once
     started, the sign-out belongs to the document: the cover and the retry
     outlive the component. */
  test('the cover and the retry outlive the watcher being unmounted', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    mockEnd.mockResolvedValue(false);
    let view: ReturnType<typeof render> | null = null;
    await act(async () => {
      view = render(<TabletIdleSignOut />);
    });
    await advance(15 * MINUTE);
    expect(document.getElementById('gym-tablet-leaving')?.textContent).toBe('This tablet could not finish signing out. It keeps trying.');

    await act(async () => {
      view!.unmount();
    });
    expect(document.getElementById('gym-tablet-leaving')).not.toBeNull();
    await advance(15_000);
    expect(mockEnd).toHaveBeenCalledTimes(2);

    mockEnd.mockResolvedValue(true);
    await advance(15_000);
    expect(mockLeave).toHaveBeenCalledTimes(1);
  });

  test("a confirmed sign-out clears the device's idle clock; the mark stays", async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    expect(readGymTabletLastUse()).not.toBeNull();
    await advance(15 * MINUTE);
    expect(mockLeave).toHaveBeenCalledTimes(1);
    expect(readGymTabletLastUse()).toBeNull();
  });

  test('a last use stored in the future (a clock set back) counts as now, not later', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    writeGymTabletLastUse(Date.now() + 60 * MINUTE);
    await mount();
    await advance(15 * MINUTE);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  /* AS2-b review A, round 3: a tab opened before a sign-out confirmed in
     another tab shows the person signed out, even after someone new has
     restarted the clock. It covers itself and reloads /login, ending
     nothing: the session may now be the next person's. */
  test('a tab older than a sign-out confirmed elsewhere covers itself and reloads /login, ending nothing', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    await advance(5 * MINUTE);
    writeGymTabletSignedOutAt(Date.now()); // the other tab confirmed a sign-out
    writeGymTabletLastUse(Date.now()); // and someone new signed in there
    await advance(1_000);
    expect(document.getElementById('gym-tablet-leaving')?.textContent).toBe('Signing out…');
    expect(mockLeave).toHaveBeenCalledTimes(1);
    expect(mockEnd).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  test('a signed-out mark in the future (a clock set back) does not send a new page round /login', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    writeGymTabletSignedOutAt(Date.now() + 60 * MINUTE);
    await mount();
    await advance(5 * MINUTE);
    expect(mockLeave).not.toHaveBeenCalled();
    expect(readGymTabletSignedOutAt()).toBeNull();
  });

  test('a tab opened after an earlier sign-out is not treated as stale', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    writeGymTabletSignedOutAt(Date.now() - 60_000);
    await mount();
    await advance(5 * MINUTE);
    expect(mockLeave).not.toHaveBeenCalled();
  });

  test("a confirmed sign-out leaves the signed-out mark for the device's other tabs", async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    await mount();
    expect(readGymTabletSignedOutAt()).toBeNull();
    await advance(15 * MINUTE);
    expect(readGymTabletSignedOutAt()).toBe(Date.now());
  });

  test('a dialog the page adds after the cover went up is inert too', async () => {
    idleRead({ ok: true, body: { idle_minutes: 15, is_default: false } });
    mockEnd.mockResolvedValue(false);
    await mount();
    await advance(15 * MINUTE);
    const late = document.createElement('div');
    await act(async () => {
      document.body.appendChild(late);
      await Promise.resolve();
    });
    expect(late.hasAttribute('inert')).toBe(true);
    expect(document.getElementById('gym-tablet-leaving')?.hasAttribute('inert')).toBe(false);
    late.remove();
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
