import { getPilotLoginRedirectPath } from './loginPageHelpers';

export interface PilotSessionResponse {
  authenticated: boolean;
  account_id?: string;
  role?: string;
  organization_id?: string;
  athlete_id?: string | null;
  auth_provider?: 'ppbf_local' | 'microsoft';
  authProvider?: 'ppbf_local' | 'microsoft';
  has_master_shadow_access?: boolean;
  hasMasterShadowAccess?: boolean;
}

export function getPilotSessionAuthProvider(session: Pick<PilotSessionResponse, 'auth_provider' | 'authProvider'>): 'ppbf_local' | 'microsoft' | null {
  return session.authProvider ?? session.auth_provider ?? null;
}

export function getPilotSessionRedirectPath(session: Pick<PilotSessionResponse, 'role' | 'has_master_shadow_access' | 'hasMasterShadowAccess'>): string {
  const hasMasterShadowAccess = session.hasMasterShadowAccess ?? session.has_master_shadow_access ?? false;
  return getPilotLoginRedirectPath(session.role || '', hasMasterShadowAccess);
}

export async function fetchPilotSession(): Promise<PilotSessionResponse> {
  const response = await fetch('/api/pilot/auth/session', {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  return (await response.json().catch(() => ({ authenticated: false }))) as PilotSessionResponse;
}