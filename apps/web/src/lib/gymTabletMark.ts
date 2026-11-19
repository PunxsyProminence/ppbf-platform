/**
 * WHICH DEVICE IS A GYM TABLET (lane U1, AS2-b; Overwatch Q1 = A: a device
 * mark the gym admin sets on the tablet, shown as a header plate; personal
 * phones are not signed out).
 *
 * The mark is one key in this browser's localStorage. It is set and removed
 * only from Customize the Gym, a gym-admin page, on the tablet itself. It is a
 * fact about the DEVICE, not the person, so signing out does not clear it
 * (roleSession.ts's clearRoleSession leaves it alone).
 *
 * What it is not: a security boundary. Anyone with the browser's developer
 * tools could set or clear it. Setting it only makes that device sign out
 * sooner. Clearing it (or clearing the site's data) stops the idle sign-out on
 * that device, which is why a marked device shows "Gym tablet" in the header:
 * a tablet that has lost its mark is visible to whoever looks at it.
 *
 * Storage can be missing or refuse (private mode, a locked-down browser).
 * Then the device reads as not marked, and marking says it could not be saved.
 */

const STORAGE_KEY = 'ppbf.device.gymTablet';
const CHANGE_EVENT = 'ppbf:gym-tablet-mark';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isGymTabletMarked(): boolean {
  try {
    return storage()?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Marks or unmarks this device. Returns whether the browser kept it. */
export function setGymTabletMark(marked: boolean): boolean {
  const store = storage();
  if (!store) return false;
  try {
    if (marked) store.setItem(STORAGE_KEY, '1');
    else store.removeItem(STORAGE_KEY);
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return isGymTabletMarked() === marked;
}

/** Calls back when the mark changes, in this tab or another one. */
export function subscribeGymTabletMark(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

/*
 * WHEN THIS DEVICE WAS LAST USED (AS2-b review A, BLOCKER). Kept in storage,
 * not only in memory: a tablet that wakes from sleep often RELOADS the page,
 * and a clock kept in memory would start again from zero while the last
 * person's session is still alive. Shared by every tab, so a hidden tab does
 * not sign out someone working in another.
 *
 * Cleared only at a session boundary (markSessionBoundary below): a confirmed
 * idle sign-out (TabletIdleSignOut), the server ANSWERING that nobody is
 * signed in (GlobalRoleHeader's self-heal, SignInPanel's check on /login,
 * where every sign-in starts), and a fresh sign-in (SignInPanel, the athlete
 * sign-in page, the sign-in link page). Never by a plain cache clear,
 * which can happen while the session is alive (AS2-b review A). If one is
 * ever left behind stale (a sign-in path not listed), the cost is that
 * sign-in being signed out at once; signing in again starts clean.
 */
const LAST_USE_KEY = 'ppbf.device.gymTabletLastUse';

export function readGymTabletLastUse(): number | null {
  try {
    const raw = storage()?.getItem(LAST_USE_KEY);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeGymTabletLastUse(at: number): void {
  try {
    storage()?.setItem(LAST_USE_KEY, String(at));
  } catch {
    // Memory still holds it for this tab.
  }
}

/*
 * WHEN THIS DEVICE LAST CONFIRMED A SIGN-OUT (AS2-b review A, re-review). A
 * tab opened before that moment shows the person who was signed out, even if
 * the clock has since been restarted by someone new; on seeing a newer mark
 * it covers itself and reloads /login (without ending the session, which may
 * now be the next person's).
 */
const SIGNED_OUT_KEY = 'ppbf.device.gymTabletSignedOutAt';

export function readGymTabletSignedOutAt(): number | null {
  try {
    const store = storage();
    const raw = store?.getItem(SIGNED_OUT_KEY);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    // A mark in the future (the device clock was set back) would make every
    // new page look older than it, and reload forever: it is dropped, not
    // capped (a capped mark would still match). AS2-b review A, round 4.
    if (value > Date.now()) {
      store?.removeItem(SIGNED_OUT_KEY);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function writeGymTabletSignedOutAt(at: number): void {
  try {
    storage()?.setItem(SIGNED_OUT_KEY, String(at));
  } catch {
    // This tab still leaves; another tab may not learn of it.
  }
}

/**
 * A SESSION BOUNDARY on this device: a fresh sign-in, or the server answering
 * that nobody is signed in. The idle clock starts fresh, and every page opened
 * before now shows someone else, so each one still open leaves (review A,
 * round 4: however the last person left -- the idle sign-out, Logout, a closed
 * tab -- their other tabs must not survive into the next person's session).
 */
export function markSessionBoundary(): void {
  clearGymTabletLastUse();
  writeGymTabletSignedOutAt(Date.now());
}

export function clearGymTabletLastUse(): void {
  try {
    storage()?.removeItem(LAST_USE_KEY);
  } catch {
    // Nothing to clear.
  }
}
