import type { ClubRole } from './roleRoutes';
import { getPilotRoleDestination, isBoardSeatSlug } from '@/src/shared/pilotRoleRouting';
import type { BoardSeatSlug } from '@/app/board/boardWorkspaceConfig';

export { getPilotRoleDestination, isBoardSeatSlug } from '@/src/shared/pilotRoleRouting';

export const ROLE_SESSION_KEY = 'ppbf-role-session';
export const ROLE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ROLE_SESSION_CHANGE_EVENT = 'ppbf-role-session-change';
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
      statusCode?: number;
    };

function notifyRoleSessionChange(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.dispatchEvent(new Event(ROLE_SESSION_CHANGE_EVENT));
  } catch {
    // Best-effort change notification for subscribed UI only.
  }
}

function sanitizeRoleSession(session: RoleSession | null): RoleSession | null {
  if (!session) {
    return null;
  }

  if (typeof session.expiresAt !== 'number' || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
    return null;
  }

  return {
    role: session.role,
    expiresAt: session.expiresAt,
    ...(session.role === 'board' && isBoardSeatSlug(session.boardSeat) ? { boardSeat: session.boardSeat } : {}),
  };
}

let lastSourceValue: RoleSession | null = null;
let lastSnapshot: RoleSession | null = null;

// useSyncExternalStore requires getSnapshot to return a STABLE reference when
// nothing has changed -- a fresh object on every single call reads as "the
// store changed" on every check, and React's own tearing guard treats a
// getSnapshot that never settles as an infinite loop. That is exactly what
// signing in used to do: createPersistentRoleSession's change notification
// forced every subscriber to re-check, and sanitizeRoleSession allocated a
// new (structurally identical) object each time, so the check never
// concluded "unchanged" -- crashing the whole page with "Maximum update
// depth exceeded" on the very first successful login.
//
// Memoized on cachedRoleSessionValue's REFERENCE, not on a deep comparison:
// that reference only changes from createPersistentRoleSession or
// clearRoleSession, so between those calls this returns the exact same
// object every time. The one thing a reference check cannot catch -- the
// session simply aging past its own expiresAt with no write in between --
// is checked explicitly, once per source reference, rather than by
// re-sanitizing (and re-allocating) on every call regardless of whether
// anything actually changed.
function computeRoleSessionSnapshot(): RoleSession | null {
  if (cachedRoleSessionValue !== lastSourceValue) {
    lastSourceValue = cachedRoleSessionValue;
    lastSnapshot = sanitizeRoleSession(cachedRoleSessionValue);
    return lastSnapshot;
  }

  if (lastSnapshot && lastSnapshot.expiresAt <= Date.now()) {
    lastSnapshot = null;
  }

  return lastSnapshot;
}

export function readRoleSession(): RoleSession | null {
  const session = computeRoleSessionSnapshot();
  if (!session && cachedRoleSessionValue) {
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
  cachedRoleSessionValue = session;

  notifyRoleSessionChange();
  return session;
}

export function getRoleSessionSnapshot(): RoleSession | null {
  const session = computeRoleSessionSnapshot();
  if (!session && cachedRoleSessionValue) {
    clearRoleSession();
  }
  return session;
}

export function clearRoleSession() {
  cachedRoleSessionValue = null;

  notifyRoleSessionChange();
}

export function subscribeRoleSession(listener: () => void) {
  if (typeof window !== 'undefined') {
    window.addEventListener(ROLE_SESSION_CHANGE_EVENT, listener);
  }

  return () => {
    if (typeof window !== 'undefined') {
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
    method?: 'GET' | 'POST';
  } = {},
): Promise<AuthoritativeRoleSessionResolution> {
  const fetcher = options.fetcher ?? fetch;
  const method = options.method ?? 'POST';
  const response = await fetcher(url, {
    method,
    credentials: 'include',
    cache: 'no-store',
    signal: options.signal,
  });

  if (!response.ok) {
    return {
      ok: false,
      reason: response.status >= 500 ? 'server_error' : 'unauthenticated',
      statusCode: response.status,
    };
  }

  const payload = await response.json().catch(() => null) as AuthoritativePilotSessionPayload | null;
  return resolveAuthoritativeRoleSession(payload);
}

export function isRoleSessionAllowed(session: RoleSession, allowedRoles: readonly ClubRole[]): boolean {
  return allowedRoles.includes(session.role);
}
