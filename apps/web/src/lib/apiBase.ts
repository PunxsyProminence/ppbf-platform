/**
 * Returns the base URL for all pilot API calls.
 *
 * - Local dev / Container App (standalone): empty string → calls go to self
 * - SWA static export: NEXT_PUBLIC_API_BASE points to the Container App FQDN
 *   so API calls cross-origin to the running backend.
 *
 * Usage:
 *   import { apiBase } from '@/lib/apiBase';
 *   fetch(`${apiBase()}/api/pilot/shadow/events`)
 *
 * Azure SWA setting to add (one-time, in Azure Portal → SWA → Configuration):
 *   NEXT_PUBLIC_API_BASE = https://app-ppbf-production.<suffix>.azurecontainerapps.io
 */
export function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_BASE ?? '';
}
