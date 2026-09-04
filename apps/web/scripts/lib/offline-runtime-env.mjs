/**
 * Environment boundary for the local offline replica.
 *
 * The child receives only operating-system variables required to execute
 * locally. External-service configuration is explicitly present as blank so
 * Next's .env loading cannot repopulate the current integration keys.
 */

const SAFE_INHERITED_ENV_KEYS = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);

export const BLOCKED_EXTERNAL_ENV_KEYS = Object.freeze([
  'AZURE_POSTGRES_CONNECTION_STRING',
  'AZURE_STORAGE_CONNECTION_STRING',
  'AZURE_AI_ENDPOINT',
  'AZURE_AI_KEY',
  'AZURE_AI_DEPLOYMENT_NAME',
  'AZURE_AI_EMBEDDING_DEPLOYMENT_NAME',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',

  'PPBF_MS_TENANT_ID',
  'PPBF_MS_CLIENT_ID',
  'PPBF_MS_CLIENT_SECRET',
  'PPBF_MS_REDIRECT_URI',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',

  'GRAPH_TENANT_ID',
  'GRAPH_CLIENT_ID',
  'GRAPH_CLIENT_SECRET',

  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_DRIVE_FOLDER_ID',

  'SHAREPOINT_SITE_ID',
  'SHAREPOINT_DRIVE_ID',
  'SHAREPOINT_FOLDER_PATH',

  'DATAVERSE_ORG_URL',
  'DATAVERSE_TENANT_ID',
  'DATAVERSE_CLIENT_ID',
  'DATAVERSE_CLIENT_SECRET',
  'DATAVERSE_TABLE_LOGICAL_NAME',

  'PAYMENT_CONNECT_CLIENT_ID',
  'PAYMENT_PLATFORM_SECRET_KEY',
  'PAYMENT_PLATFORM_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',

  // Not a credential, but the same escape shape: apiBase() (src/lib/apiBase.ts)
  // reads this unvalidated at browser-bundle time, so a value adopted from a
  // developer's own .env.local here would route offline browser traffic to
  // that external origin. Blank it for the same reason as the keys above --
  // so Next's own .env loading cannot repopulate it -- and no earlier than
  // this array, because a key already present when Next loads is the one
  // thing its precedence rules cannot override.
  'NEXT_PUBLIC_API_BASE',
]);

export function buildOfflineChildEnv(baseEnv = {}) {
  const childEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value == null) continue;
    if (!SAFE_INHERITED_ENV_KEYS.has(String(key).toUpperCase())) continue;
    childEnv[key] = String(value);
  }

  for (const key of BLOCKED_EXTERNAL_ENV_KEYS) {
    childEnv[key] = '';
  }

  return childEnv;
}