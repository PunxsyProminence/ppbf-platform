import { roleRoutes, type ClubRole } from './roleRoutes';
import { getPilotRoleDestination, isBoardSeatSlug } from '@/src/shared/pilotRoleRouting';
import type { BoardSeatSlug } from '@/app/board/boardWorkspaceConfig';

export { getPilotRoleDestination, isBoardSeatSlug } from '@/src/shared/pilotRoleRouting';

export const ROLE_SESSION_KEY = 'ppbf-role-session';
export const ROLE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ROLE_SESSION_CHANGE_EVENT = 'ppbf-role-session-change';
// roleRoutes lists the roles that get a self-service landing card; it has no
// platform_owner entry by design. But mapPilotRoleToClubRole legitimately
// returns 'platform_owner' and createPersistentRoleSession stores it, so the
// parse set must accept it too -- otherwise the very next read rejected the
// owner's own session and erased it, blanking the global header.
const clubRoles = new Set<ClubRole>([...roleRoutes.map((item) => item.role), 'platform_owner']);

let cachedRoleSessionRaw: string | null | undefined;
let cachedRoleSessionValue: RoleSession | null = null;

export interface RoleSession {
  role: ClubRole;
  expiresAt: number;
  /**
   * The governing-board seat this session holds, when it holds one.
   *
   * A seat is additional identity carried alongside the role, never a role of
   * its own: the authoritative client role for every board member stays
   * 'board', and every page guard keeps asking exactly that. The seat decides
   * which page the member lands on and lets a board surface address the holder
   * by their office. Present only for board sessions that hold a seat, so a
   * cached session for any other role stores nothing extra.
   */
  boardSeat?: BoardSeatSlug;
}

export interface AuthoritativePilotSessionPayload {
  authenticated?: unknown;
  role?: unknown;
  auth_provider?: unknown;
  must_change_pin?: unknown;
  // The one seat a board session lands on, and every seat it holds -- a small
  // board doubles up. Both are absent for every other role.
  board_seat?: unknown;
  board_seats?: unknown;
}

export type AuthoritativeRoleSessionResolution =
  | { ok: true; session: RoleSession; destination: string }
  | {
      ok: false;
      reason:
        | 'unauthenticated'
        | 'unsupported_role'
        | 'privileged_auth_required'
        | 'pin_change_required'
        | 'server_error';
    };

function isClubRole(value: unknown): value is ClubRole {
  return typeof value === 'string' && clubRoles.has(value as ClubRole);
}

function getRoleSessionStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function notifyRoleSessionChange(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.dispatchEvent(new Event(ROLE_SESSION_CHANGE_EVENT));
  } catch {
    // Browser storage/events are a display cache only. Authentication remains
    // authoritative in the HttpOnly server session.
  }
}

function parseRoleSession(raw: string | null): RoleSession | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RoleSession>;
    if (!isClubRole(parsed.role)) {
      return null;
    }

    if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= Date.now()) {
      return null;
    }

    // An unrecognized seat is dropped rather than rejecting the session. The
    // seat is display identity layered on the role; discarding the whole
    // cache over it would sign a legitimately authenticated board member out.
    return {
      role: parsed.role,
      expiresAt: parsed.expiresAt,
      ...(isBoardSeatSlug(parsed.boardSeat) ? { boardSeat: parsed.boardSeat } : {}),
    };
  } catch {
    return null;
  }
}

export function readRoleSession(): RoleSession | null {
  const storage = getRoleSessionStorage();
  if (!storage) {
    return null;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(ROLE_SESSION_KEY);
  } catch {
    return null;
  }

  const session = parseRoleSession(raw);
  if (!session && raw) {
    clearRoleSession();
  }
  return session;
}

export function createPersistentRoleSession(role: ClubRole, boardSeat?: unknown): RoleSession {
  const session: RoleSession = {
    role,
    expiresAt: Date.now() + ROLE_SESSION_TTL_MS,
    // Only a board session that actually holds a seat stores one. Every other
    // role's cache keeps exactly the two keys it has always had.
    ...(role === 'board' && isBoardSeatSlug(boardSeat) ? { boardSeat } : {}),
  };
  const raw = JSON.stringify(session);

  cachedRoleSessionRaw = raw;
  cachedRoleSessionValue = session;

  const storage = getRoleSessionStorage();
  if (storage) {
    try {
      storage.setItem(ROLE_SESSION_KEY, raw);
      storage.removeItem('ppbf-club-role');
    } catch {
      // A blocked/full localStorage must never turn a valid server login into
      // a client-side login failure.
    }
  }

  notifyRoleSessionChange();
  return session;
}

export function getRoleSessionSnapshot(): RoleSession | null {
  const storage = getRoleSessionStorage();
  if (!storage) {
    return null;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(ROLE_SESSION_KEY);
  } catch {
    return null;
  }

  if (
    raw === cachedRoleSessionRaw
    && cachedRoleSessionValue
    && cachedRoleSessionValue.expiresAt > Date.now()
  ) {
    return cachedRoleSessionValue;
  }

  cachedRoleSessionRaw = raw;
  cachedRoleSessionValue = parseRoleSession(raw);
  if (!cachedRoleSessionValue && raw) {
    clearRoleSession();
  }
  return cachedRoleSessionValue;
}

export function clearRoleSession() {
  cachedRoleSessionRaw = null;
  cachedRoleSessionValue = null;

  const storage = getRoleSessionStorage();
  if (storage) {
    try {
      storage.removeItem(ROLE_SESSION_KEY);
      storage.removeItem('ppbf-club-role');
    } catch {
      // Best-effort display cache cleanup only.
    }
  }

  notifyRoleSessionChange();
}

export function subscribeRoleSession(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === ROLE_SESSION_KEY) {
      listener();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
    window.addEventListener(ROLE_SESSION_CHANGE_EVENT, listener);
  }

  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(ROLE_SESSION_CHANGE_EVENT, listener);
    }
  };
}

export function mapPilotRoleToClubRole(role: unknown): ClubRole | null {
  // platform_owner used to fold in here with the org admins. It cannot: the
  // server treats Omega as broader in breadth and strictly narrower in depth,
  // so a single 'admin' bucket made every page guard wrong in one direction
  // or the other. Two live symptoms, both reported: an organization_admin
  // could not open /coach/video-analysis even though the upload API admits
  // that role, and Omega rendered admin pages whose API then refused it
  // ("admin takes me to omega, i dont have access").
  if (role === 'platform_owner') {
    return 'platform_owner';
  }

  // 'admin' remains the ORGANIZATION administrator bucket, so every existing
  // ['admin'] guard keeps meaning what it already meant for these two roles.
  if (role === 'organization_admin' || role === 'admin') {
    return 'admin';
  }

  if (
    role === 'coach'
    || role === 'athlete'
    || role === 'parent'
    || role === 'board'
    || role === 'staff'
    || role === 'volunteer'
  ) {
    return role;
  }

  return null;
}

export function resolveAuthoritativeRoleSession(
  payload: AuthoritativePilotSessionPayload | null,
): AuthoritativeRoleSessionResolution {
  if (!payload || payload.authenticated !== true) {
    return { ok: false, reason: 'unauthenticated' };
  }

  const role = mapPilotRoleToClubRole(payload.role);
  // The seat only ever refines where a board member lands. It cannot make an
  // unroutable role routable, and it is never mapped to a role of its own.
  const boardSeat = role === 'board' && isBoardSeatSlug(payload.board_seat) ? payload.board_seat : null;
  const destination = getPilotRoleDestination(payload.role, boardSeat);
  if (!role || !destination) {
    return { ok: false, reason: 'unsupported_role' };
  }

  if (payload.auth_provider !== 'microsoft' && payload.auth_provider !== 'ppbf_local') {
    return { ok: false, reason: 'unauthenticated' };
  }

  if (role !== 'athlete' && payload.auth_provider !== 'microsoft') {
    return { ok: false, reason: 'privileged_auth_required' };
  }

  // Authenticated, but still on the starting PIN the gym handed out. The
  // server refuses every route except the PIN change in this state, so
  // sending this session on to its dashboard would render a page made
  // entirely of 403s. It is not 'unauthenticated' either -- bouncing to
  // /login would loop, because signing in again lands right back here.
  if (payload.must_change_pin === true) {
    return { ok: false, reason: 'pin_change_required' };
  }

  return {
    ok: true,
    session: {
      role,
      expiresAt: Date.now() + ROLE_SESSION_TTL_MS,
      ...(boardSeat ? { boardSeat } : {}),
    },
    destination,
  };
}

// Stores a session the server just authorized, seat included. Callers that
// only have a role can keep calling createPersistentRoleSession directly; this
// exists so a caller holding the whole resolved session does not have to know
// which of its fields are worth persisting.
export function persistAuthoritativeRoleSession(session: RoleSession): RoleSession {
  return createPersistentRoleSession(session.role, session.boardSeat);
}

export async function loadAuthoritativeRoleSession(
  url: string,
  options: {
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  } = {},
): Promise<AuthoritativeRoleSessionResolution> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(url, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    signal: options.signal,
  });

  if (!response.ok) {
    return {
      ok: false,
      reason: response.status >= 500 ? 'server_error' : 'unauthenticated',
    };
  }

  const payload = await response.json().catch(() => null) as AuthoritativePilotSessionPayload | null;
  return resolveAuthoritativeRoleSession(payload);
}

export function isRoleSessionAllowed(session: RoleSession, allowedRoles: readonly ClubRole[]): boolean {
  return allowedRoles.includes(session.role);
}
