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
 * Cleared only when the session is known to be gone (roleSession.ts's
 * clearRoleSession, and the header hearing "signed out" from the server), so
 * the next person starts a fresh clock. If it is ever left behind stale, the
 * cost is a new sign-in being signed out at once; signing in again starts clean.
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

export function clearGymTabletLastUse(): void {
  try {
    storage()?.removeItem(LAST_USE_KEY);
  } catch {
    // Nothing to clear.
  }
}
