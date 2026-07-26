import { roleRoutes, type ClubRole } from './roleRoutes';
import { getPilotRoleDestination } from '@/src/shared/pilotRoleRouting';

export { getPilotRoleDestination } from '@/src/shared/pilotRoleRouting';

export const ROLE_SESSION_KEY = 'ppbf-role-session';
export const ROLE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ROLE_SESSION_CHANGE_EVENT = 'ppbf-role-session-change';
const clubRoles = new Set<ClubRole>(roleRoutes.map((item) => item.role));

let cachedRoleSessionRaw: string | null | undefined;
let cachedRoleSessionValue: RoleSession | null = null;

export interface RoleSession {
  role: ClubRole;
  expiresAt: number;
}

export interface AuthoritativePilotSessionPayload {
  authenticated?: unknown;
  role?: unknown;
  auth_provider?: unknown;
}

export type AuthoritativeRoleSessionResolution =
  | { ok: true; session: RoleSession; destination: string }
  | {
      ok: false;
      reason: 'unauthenticated' | 'unsupported_role' | 'privileged_auth_required' | 'server_error';
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

    return { role: parsed.role, expiresAt: parsed.expiresAt };
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

export function createPersistentRoleSession(role: ClubRole): RoleSession {
  const session: RoleSession = {
    role,
    expiresAt: Date.now() + ROLE_SESSION_TTL_MS,
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
  if (role === 'platform_owner' || role === 'organization_admin' || role === 'admin') {
    return 'admin';
  }

  if (role === 'coach' || role === 'athlete' || role === 'parent' || role === 'board') {
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
  const destination = getPilotRoleDestination(payload.role);
  if (!role || !destination) {
    return { ok: false, reason: 'unsupported_role' };
  }

  if (payload.auth_provider !== 'microsoft' && payload.auth_provider !== 'ppbf_local') {
    return { ok: false, reason: 'unauthenticated' };
  }

  if (role !== 'athlete' && payload.auth_provider !== 'microsoft') {
    return { ok: false, reason: 'privileged_auth_required' };
  }

  return {
    ok: true,
    session: {
      role,
      expiresAt: Date.now() + ROLE_SESSION_TTL_MS,
    },
    destination,
  };
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
