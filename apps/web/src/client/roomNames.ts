/**
 * THE GYM'S ROOM NAMES IN THE BROWSER (lane W4-9, RN-2; OW27-11, OW27-40 A).
 *
 * One GET /api/pilot/room-names per sign-in, shared by every screen that shows
 * a renamable name. useRoomNames() answers a lookup that falls back to the
 * name the app ships with (ROOM_NAME_DEFAULTS) while the read is on its way,
 * when nobody is signed in, and when the read fails. A name is words, not a
 * figure, so the default standing in for a moment says nothing false; the
 * gym's own words replace it when the read answers (INFERRED: a renamed gym
 * sees the default for that moment).
 *
 * WHICH SIGN-IN. The browser's role session (roleSession.ts) is the only
 * signed-in identity it holds: the role (and a board seat) and when the session
 * ends. The names are read once per role session (sessionKey, below); a
 * sign-out drops them, and the next sign-in reads them again. The read itself
 * is answered for the session's own gym only (the route takes the
 * organization from the session).
 *
 * It starts on first use, so no header component has to mount it.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { Room } from '@/components/buildingMap';
import { apiBase } from '@/lib/apiBase';
import { getRoleSessionSnapshot, subscribeRoleSession, type RoleSession } from '@/components/roleSession';
import type { RoomPlace } from '@/components/roomPlaces';
import { isRoomNameKey, ROOM_NAME_DEFAULTS, type RoomNameKey } from '@/src/shared/roomNames';

type GymNames = Readonly<Partial<Record<RoomNameKey, string>>>;

export interface RoomNameLookup {
  /** The name a renamable key shows: the gym's, else the default. */
  readonly name: (key: RoomNameKey) => string;
  /** A Room Map room's shown name. */
  readonly place: (place: RoomPlace) => string;
  /** One of the 7 rooms' shown name. */
  readonly room: (room: Room) => string;
}

export function roomNameLookup(names: GymNames | null): RoomNameLookup {
  const name = (key: RoomNameKey) => names?.[key] ?? ROOM_NAME_DEFAULTS[key];
  return {
    name,
    place: (place) => name(`place:${place}`),
    room: (room) => name(`room:${room}`),
  };
}

/** The names as the app ships them: what every screen shows before the read answers. */
export const DEFAULT_ROOM_NAMES: RoomNameLookup = roomNameLookup(null);

/** Only the names the gym has changed, and only keys on the list; anything else in the answer is ignored. */
function gymNamesFrom(body: unknown): GymNames | null {
  const names = (body as { names?: unknown } | null)?.names;
  if (!names || typeof names !== 'object') return null;
  const out: Partial<Record<RoomNameKey, string>> = {};
  for (const [key, value] of Object.entries(names as Record<string, unknown>)) {
    const entry = value as { name?: unknown; is_default?: unknown } | null;
    if (isRoomNameKey(key) && entry && typeof entry.name === 'string' && entry.is_default === false) {
      out[key] = entry.name;
    }
  }
  return out;
}

interface State {
  /** The sign-in these names belong to; null when nobody is signed in. */
  readonly session: string | null;
  readonly names: GymNames | null;
  readonly started: boolean;
  /** When the last read failed (Date.now()), or null. */
  readonly failedAt: number | null;
}

/**
 * Overwatch's Q-J A on #2215: the defaults show while the read is on its way;
 * after a failed read, the next screen that mounts reads again, at most once
 * every 30 seconds, instead of keeping the defaults until the next sign-in.
 */
export const ROOM_NAMES_RETRY_AFTER_MS = 30_000;

const EMPTY: State = { session: null, names: null, started: false, failedAt: null };
let state: State = EMPTY;
const listeners = new Set<() => void>();

function publish(next: State): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Which sign-in the names belong to: the role (and board seat), NOT expiresAt.
 * RoleSessionGate re-verifies the session on every gated route and mints a
 * fresh expiresAt each time (persistAuthoritativeRoleSession), so keying on it
 * re-read the names and flickered them back to the defaults on every page
 * change (Codex P2 on #2215). A sign-out (no session) still drops the names,
 * and a different role signing in reads them again.
 */
function sessionKey(session: RoleSession | null): string | null {
  return session ? `${session.role}:${session.boardSeat ?? ''}` : null;
}

/** Reads the names once for this sign-in; a second caller for the same sign-in waits on the first. */
function ensureRead(session: string | null): void {
  if (state.session === session) {
    if (session === null) return;
    const retryDue = state.failedAt !== null && Date.now() - state.failedAt >= ROOM_NAMES_RETRY_AFTER_MS;
    if (state.started && !retryDue) return;
  }
  publish({ session, names: null, started: session !== null, failedAt: null });
  if (session === null || typeof fetch !== 'function') return;
  const failed = () => {
    if (state.session === session) publish({ ...state, failedAt: Date.now() });
  };
  // Inside the chain, so a fetch that throws as it is called is caught like one that fails.
  Promise.resolve()
    .then(() => fetch(`${apiBase()}/api/pilot/room-names`, { credentials: 'include', cache: 'no-store' }))
    .then((response) => (response?.ok ? response.json() : null))
    .then((body) => {
      // The person signed out or someone else signed in meanwhile: not theirs.
      if (state.session !== session) return;
      const names = gymNamesFrom(body);
      // A refused read, or an answer that is not names, is a failure too.
      if (names === null) failed();
      else publish({ ...state, names, failedAt: null });
    })
    .catch(() => {
      // The defaults stay; a screen mounting 30 s or more later reads again.
      failed();
    });
}

/**
 * A sign-out, and every sign-in (SignInPanel clears the old session first),
 * passes through having no session. The screens that show names are unmounted
 * by then, so their effects never see it: the module listens itself and drops
 * the names, so the next sign-in reads them again even in the same role on a
 * shared gym device (Codex P1 on #2215). Subscribed on first use, once.
 */
let listening = false;
function listenForSignOut(): void {
  if (listening) return;
  listening = true;
  subscribeRoleSession(() => {
    if (getRoleSessionSnapshot() === null && state.session !== null) {
      publish(EMPTY);
    }
  });
}

export function useRoomNames(): RoomNameLookup {
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const key = sessionKey(session);
  useEffect(() => {
    listenForSignOut();
    ensureRead(key);
  }, [key]);
  const names = useSyncExternalStore(
    subscribe,
    () => (state.session === key ? state.names : null),
    () => null,
  );
  return useMemo(() => (names ? roomNameLookup(names) : DEFAULT_ROOM_NAMES), [names]);
}

/** Tests only: forget every read, as a fresh page load would. */
export function resetRoomNamesForTests(): void {
  state = EMPTY;
  listening = false;
}
