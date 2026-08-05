export const PILOT_SESSION_COOKIE = 'ppbf_pilot_session';

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

/**
 * How much of an athlete's name the gym's wall display may print.
 *
 * 'off' | 'initials' | 'consent'. Unset means 'initials' -- see
 * wallDisplay.ts for why the default is not 'consent': reaching a real name on
 * a public screen has to take two deliberate acts by two different people, and
 * an unset environment variable is neither.
 */
export function getWallDisplayNameMode(): string | undefined {
  return process.env.PPBF_WALL_DISPLAY_NAMES?.trim();
}

/** Where the gym is, so the board's "today" is the gym's day, not the server's. */
export function getWallTimeZone(): string {
  return process.env.PPBF_WALL_TIMEZONE?.trim() || 'America/New_York';
}

/**
 * Where member portraits live. A container of its own, deliberately not the
 * SHADOW or video one: those two hand out read-only SAS URLs, and a signed URL
 * to a child's photograph is a bearer token for that child's face. Nothing
 * mints a SAS against this container -- the bytes are read server-side by an
 * authorized request and streamed, the same stance downloadPilotVideoFile
 * takes for a minor's footage.
 */
export function getPilotProfileContainerName(): string {
  return process.env.PPBF_PILOT_PROFILE_CONTAINER?.trim() || 'ppbf-pilot-profile';
}
