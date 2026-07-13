import { getRoleRoute, type ClubRole } from './roleRoutes';

export const ROLE_SESSION_KEY = 'ppbf-role-session';
export const ROLE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const OPERATOR_PIN = '15715';
const ROLE_SESSION_CHANGE_EVENT = 'ppbf-role-session-change';

let cachedRoleSessionRaw: string | null | undefined;
let cachedRoleSessionValue: RoleSession | null = null;

export interface RoleSession {
  role: ClubRole;
  expiresAt: number;
}

export function createRoleSession(role: ClubRole, pin: string) {
  if (pin.trim() !== OPERATOR_PIN) {
    return { ok: false as const, reason: 'Invalid PIN' };
  }

  const session: RoleSession = {
    role,
    expiresAt: Date.now() + ROLE_SESSION_TTL_MS,
  };

  window.localStorage.setItem(ROLE_SESSION_KEY, JSON.stringify(session));
  window.localStorage.setItem('ppbf-club-role', role);
  window.dispatchEvent(new Event(ROLE_SESSION_CHANGE_EVENT));

  return { ok: true as const, session };
}

export function readRoleSession(): RoleSession | null {
  const raw = window.localStorage.getItem(ROLE_SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RoleSession>;
    if (!parsed.role || typeof parsed.expiresAt !== 'number') {
      return null;
    }

    if (parsed.expiresAt < Date.now()) {
      clearRoleSession();
      return null;
    }

    return { role: parsed.role, expiresAt: parsed.expiresAt };
  } catch {
    clearRoleSession();
    return null;
  }
}

export function getRoleSessionSnapshot(): RoleSession | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(ROLE_SESSION_KEY);
  if (raw === cachedRoleSessionRaw) {
    return cachedRoleSessionValue;
  }

  cachedRoleSessionRaw = raw;

  if (!raw) {
    cachedRoleSessionValue = null;
    return cachedRoleSessionValue;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RoleSession>;
    if (!parsed.role || typeof parsed.expiresAt !== 'number' || parsed.expiresAt < Date.now()) {
      cachedRoleSessionValue = null;
      return cachedRoleSessionValue;
    }

    cachedRoleSessionValue = { role: parsed.role, expiresAt: parsed.expiresAt };
    return cachedRoleSessionValue;
  } catch {
    cachedRoleSessionValue = null;
    return cachedRoleSessionValue;
  }
}

export function clearRoleSession() {
  window.localStorage.removeItem(ROLE_SESSION_KEY);
  window.localStorage.removeItem('ppbf-club-role');
  window.dispatchEvent(new Event(ROLE_SESSION_CHANGE_EVENT));
}

export function subscribeRoleSession(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === ROLE_SESSION_KEY || event.key === 'ppbf-club-role') {
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

export function getRoleSessionRoute() {
  const session = readRoleSession();
  return session ? getRoleRoute(session.role) : '/login';
}

export function getPostLoginRoute(session: RoleSession) {
  return session.role === 'admin' ? '/operations' : getRoleRoute(session.role);
}
