export const PILOT_SESSION_COOKIE = 'ppbf_pilot_session';

// Production serves the frontend from an Azure Static Web App and the API
// from a separate Container App (see NEXT_PUBLIC_API_BASE in lib/apiBase.ts
// and scripts/postbuild-swa.mjs) -- every browser fetch() to the API is
// therefore cross-origin. A cookie set with SameSite=Lax is stored fine on
// that cross-origin response, but browsers will NOT attach it to any later
// fetch() back to that origin (Lax only rides along on top-level
// navigation), so the very next authenticated request looks unauthenticated.
// That is what "login succeeds but I'm kept on the login screen" actually
// was: the immediate post-login session check silently lost its cookie.
//
// SameSite=None is required for a cross-origin cookie to be sent back, and
// the spec mandates Secure whenever SameSite=None is used, so both must flip
// together. Local dev (NODE_ENV !== 'production') stays on Lax/non-Secure
// because it runs over plain HTTP, where a Secure cookie would never be set
// at all.
export function pilotSessionCookieAttributes(): { sameSite: 'lax' | 'none'; secure: boolean } {
  const isProduction = process.env.NODE_ENV === 'production';
  return { sameSite: isProduction ? 'none' : 'lax', secure: isProduction };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getAzurePostgresConnectionString(): string {
  return requireEnv('AZURE_POSTGRES_CONNECTION_STRING');
}

export function getAzureStorageConnectionString(): string {
  return requireEnv('AZURE_STORAGE_CONNECTION_STRING');
}

export function getPilotShadowContainerName(): string {
  return process.env.PPBF_PILOT_SHADOW_CONTAINER?.trim() || 'ppbf-pilot-shadow';
}

export function getPilotDefaultOrganizationId(): string {
  return process.env.PPBF_PILOT_DEFAULT_ORG_ID?.trim() || 'ppbf-default-org';
}

export function getPilotVideoContainerName(): string {
  return process.env.PPBF_PILOT_VIDEO_CONTAINER?.trim() || 'ppbf-pilot-video';
}
