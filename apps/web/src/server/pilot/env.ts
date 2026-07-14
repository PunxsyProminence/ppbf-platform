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
