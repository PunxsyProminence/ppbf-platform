import { getRoleRoute, type ClubRole } from './roleRoutes';

export const ROLE_SESSION_KEY = 'ppbf-role-session';
export const ROLE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const OPERATOR_PIN = '15715';

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

export function clearRoleSession() {
  window.localStorage.removeItem(ROLE_SESSION_KEY);
  window.localStorage.removeItem('ppbf-club-role');
}

export function getRoleSessionRoute() {
  const session = readRoleSession();
  return session ? getRoleRoute(session.role) : '/login';
}

export function getPostLoginRoute(session: RoleSession) {
  return session.role === 'admin' ? '/operations' : getRoleRoute(session.role);
}
