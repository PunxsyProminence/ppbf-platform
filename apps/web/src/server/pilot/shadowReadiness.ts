import { query } from './db';

interface ShadowRuntimeReadinessOptions {
  requireBlob?: boolean;
  requiredTables: string[];
}

const tableCheckCache = new Map<string, boolean>();

function requireRuntimeEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
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
    throw new Error(`Missing required pilot tables: ${missing.join(', ')}`);
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
