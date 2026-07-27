import { query } from './db';
import { ShadowRuntimeUnavailableError } from './shadowRuntimeError';

interface ShadowRuntimeReadinessOptions {
  requireBlob?: boolean;
  requiredTables: string[];
}

// Re-exported so existing import sites can keep sourcing the type from here.
// jsonError deliberately imports it from './shadowRuntimeError' instead, so a
// test that stubs this whole module cannot break the instanceof check.
export { ShadowRuntimeUnavailableError };

const tableCheckCache = new Map<string, boolean>();

function requireRuntimeEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ShadowRuntimeUnavailableError({ missingEnvVar: name });
  }
  return value;
}

async function assertTablesExist(requiredTables: string[]): Promise<void> {
  const normalized = [...new Set(requiredTables.map((table) => table.trim()).filter(Boolean))].sort();
  if (normalized.length === 0) {
    return;
  }

  const cacheKey = normalized.join('|');
  if (tableCheckCache.get(cacheKey)) {
    return;
  }

  const rows = await query<{ table_name: string }>(
    `select table_name
     from information_schema.tables
     where table_schema = 'pilot'
       and table_name = any($1::text[])`,
    [normalized],
  );

  const existing = new Set(rows.map((row) => row.table_name));
  const missing = normalized.filter((table) => !existing.has(table));
  if (missing.length > 0) {
    throw new ShadowRuntimeUnavailableError({ missingTables: missing });
  }

  tableCheckCache.set(cacheKey, true);
}

export async function assertShadowRuntimeReadiness(options: ShadowRuntimeReadinessOptions): Promise<void> {
  requireRuntimeEnv('AZURE_POSTGRES_CONNECTION_STRING');
  if (options.requireBlob) {
    requireRuntimeEnv('AZURE_STORAGE_CONNECTION_STRING');
  }

  await assertTablesExist(options.requiredTables);
}
