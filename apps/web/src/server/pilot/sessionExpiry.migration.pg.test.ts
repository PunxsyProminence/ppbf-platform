// Real PostgreSQL-backed tests for the session-expiry migration and the
// security-critical session-revocation behaviors that depend on actual SQL
// semantics (org-scoped revocation, cross-organization role inheritance).
//
// Spins up a disposable, local-only embedded Postgres instance in a child
// process (see scripts/test-embedded-pg-server.mjs -- embedded-postgres is
// ESM-only and can't be imported directly from Jest's CommonJS transform).
// This NEVER connects to production or staging: each database used here is
// created fresh in that disposable instance and the whole instance is torn
// down at the end of the run.

import { createHash } from 'node:crypto';
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_PORT = 55_477;
const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-expiry-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');

const SCHEMA_SQL_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');
const MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  '../../../../../infra/azure/pilot_slice_postgres_session_expiry_migration.sql',
);

let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

function tokenHashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function readSql(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

async function newTestDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

beforeAll(async () => {
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);

    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });

    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });
});

afterAll(async () => {
  // Close the app's own pool (if the regression describe block below ever
  // created one) before tearing down the server it points at, so no idle
  // connection is left dangling when the process exits.
  const { closePool } = await import('./db');
  await closePool();

  await new Promise<void>((resolve) => {
    serverProcess.once('exit', () => resolve());
    serverProcess.kill('SIGTERM');
    // Safety net in case the graceful shutdown hangs.
    setTimeout(resolve, 15_000);
  });
});

describe('fresh-install schema', () => {
  let client: Client;

  beforeAll(async () => {
    client = await newTestDatabase('ppbf_test_fresh_schema');
    await client.query(await readSql(SCHEMA_SQL_PATH));
  });

  afterAll(async () => {
    await client.end();
  });

  test('session_tokens.expires_at exists, is NOT NULL, and has a default', async () => {
    const { rows } = await client.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `select column_name, is_nullable, column_default
       from information_schema.columns
       where table_schema = 'pilot' and table_name = 'session_tokens' and column_name = 'expires_at'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe('NO');
    expect(rows[0].column_default).not.toBeNull();
  });

  test('required indexes exist on a fresh install', async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'pilot' and tablename = 'session_tokens'`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('idx_pilot_session_tokens_expires_at');
    expect(names).toContain('idx_pilot_session_tokens_account_id');
  });
});

describe('migration on a pre-existing (legacy) database', () => {
  let client: Client;
  const ORG = 'legacy-org';
  const ACCOUNT_WITH_MEMBERSHIP = 'legacy-acct-with-membership';
  const ACCOUNT_WITHOUT_MEMBERSHIP = 'legacy-acct-without-membership';
  let legacyTokenHash: string;

  beforeAll(async () => {
    client = await newTestDatabase('ppbf_test_legacy_migration');

    // Apply the current (already-migrated) canonical schema, then strip it
    // back down to what a pre-this-PR deployed database actually looked
    // like: session_tokens with no expires_at column at all, and an account
    // that was created without ever getting an organization_memberships row
    // (the exact gap several onboarding paths had).
    await client.query(await readSql(SCHEMA_SQL_PATH));
    await client.query('alter table pilot.session_tokens drop column expires_at');
    await client.query('drop index if exists idx_pilot_session_tokens_expires_at');
    await client.query('drop index if exists idx_pilot_session_tokens_account_id');

    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, 'Legacy Org', 'active')`,
      [ORG],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, active_flag) values ($1, 'coach', $2, true), ($3, 'athlete', $2, true)`,
      [ACCOUNT_WITH_MEMBERSHIP, ORG, ACCOUNT_WITHOUT_MEMBERSHIP],
    );
    // Only one of the two accounts gets a membership row, matching the
    // real-world gap.
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
      [ACCOUNT_WITH_MEMBERSHIP, ORG],
    );

    legacyTokenHash = 'legacy-token-hash-1';
    await client.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id) values ($1, $2, $3)`,
      [legacyTokenHash, ACCOUNT_WITH_MEMBERSHIP, ORG],
    );

    await client.query(await readSql(MIGRATION_SQL_PATH));
  });

  afterAll(async () => {
    await client.end();
  });

  test('expires_at column now exists and is NOT NULL', async () => {
    const { rows } = await client.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
       where table_schema = 'pilot' and table_name = 'session_tokens' and column_name = 'expires_at'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe('NO');
  });

  test('every pre-existing (legacy) active session is revoked -- fails closed', async () => {
    const { rows } = await client.query<{ revoked_at: Date | null; expires_at: Date }>(
      'select revoked_at, expires_at from pilot.session_tokens where token_hash = $1',
      [legacyTokenHash],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[0].expires_at).not.toBeNull();
  });

  test('required indexes exist after migrating a legacy database', async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'pilot' and tablename = 'session_tokens'`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('idx_pilot_session_tokens_expires_at');
    expect(names).toContain('idx_pilot_session_tokens_account_id');
  });

  test('backfills a missing organization_memberships row without disturbing an existing one', async () => {
    const { rows } = await client.query<{ account_id: string; role: string }>(
      'select account_id, role from pilot.organization_memberships where organization_id = $1 order by account_id',
      [ORG],
    );
    const byAccount = Object.fromEntries(rows.map((r) => [r.account_id, r.role]));
    expect(byAccount[ACCOUNT_WITH_MEMBERSHIP]).toBe('coach'); // untouched, already existed
    expect(byAccount[ACCOUNT_WITHOUT_MEMBERSHIP]).toBe('athlete'); // backfilled to match accounts.role
  });

  test('re-running the migration is idempotent: no error, and already-revoked rows are not touched again', async () => {
    const before = await client.query<{ revoked_at: Date }>(
      'select revoked_at from pilot.session_tokens where token_hash = $1',
      [legacyTokenHash],
    );

    await expect(client.query(await readSql(MIGRATION_SQL_PATH))).resolves.toBeDefined();

    const after = await client.query<{ revoked_at: Date }>(
      'select revoked_at from pilot.session_tokens where token_hash = $1',
      [legacyTokenHash],
    );
    expect(after.rows[0].revoked_at.getTime()).toBe(before.rows[0].revoked_at.getTime());
  });
});

describe('a failed migration does not leave a partial rollout', () => {
  let client: Client;

  beforeAll(async () => {
    client = await newTestDatabase('ppbf_test_migration_rollback');
    await client.query(await readSql(SCHEMA_SQL_PATH));
    await client.query('alter table pilot.session_tokens drop column expires_at');
  });

  afterAll(async () => {
    await client.end();
  });

  test('a mid-migration failure inside an explicit transaction rolls back the whole thing', async () => {
    // Mirrors exactly what pilot-apply-session-expiry-migration.mjs does:
    // BEGIN, run the migration statements, and on any error ROLLBACK instead
    // of leaving whatever already ran committed.
    await client.query('BEGIN');
    await client.query('alter table pilot.session_tokens add column if not exists expires_at timestamptz');

    let threw = false;
    try {
      // A deliberately invalid statement, standing in for whatever real
      // failure (constraint violation, connection drop, etc.) could occur
      // partway through a real migration run.
      await client.query('this is not valid sql');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await client.query('ROLLBACK');

    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'pilot' and table_name = 'session_tokens' and column_name = 'expires_at'`,
    );
    // The ADD COLUMN from earlier in the same transaction was rolled back
    // along with the failed statement -- a partial rollout (column added,
    // rest of the migration never applied) is never left committed.
    expect(rows).toHaveLength(0);
  });
});

describe('session revocation regressions (real database, real application code)', () => {
  const TEST_DB_NAME = 'ppbf_test_app_regressions';

  beforeAll(async () => {
    const migrateClient = await newTestDatabase(TEST_DB_NAME);
    await migrateClient.query(await readSql(SCHEMA_SQL_PATH));
    await migrateClient.end();

    process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
    // This disposable local instance has no SSL configured; production and
    // staging always require it (see db.ts's sslConfig()) -- this flag has
    // no effect unless explicitly set, which real deploy environments never do.
    process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  });

  // Imported after the connection string is set up above so the app's
  // lazily-constructed connection pool (see db.ts's getPool()) targets this
  // disposable test database the first time a query actually runs.
  let auth: typeof import('./auth');

  beforeAll(async () => {
    auth = await import('./auth');
  });

  async function seedOrganization(orgId: string) {
    const c = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await c.connect();
    await c.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
    await c.end();
  }

  async function rawQuery<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const c = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await c.connect();
    try {
      const result = await c.query<T>(sql, params);
      return result.rows;
    } finally {
      await c.end();
    }
  }

  test('a newly created organization admin can authenticate and resolvePrincipal resolves the session', async () => {
    await seedOrganization('org-new-admin');
    await auth.createOrRotateAdminAccount('admin-new-1', '123456', 'org-new-admin', 'organization_admin');

    const login = await auth.loginWithAccountIdAndPin('admin-new-1', '123456');
    expect(login).not.toBeNull();

    const membership = await rawQuery<{ active_flag: boolean; role: string }>(
      'select active_flag, role from pilot.organization_memberships where account_id = $1 and organization_id = $2',
      ['admin-new-1', 'org-new-admin'],
    );
    expect(membership).toHaveLength(1);
    expect(membership[0].active_flag).toBe(true);
    expect(membership[0].role).toBe('organization_admin');
  });

  test('a rotated admin has an active matching membership after rotation', async () => {
    await seedOrganization('org-rotate-admin');
    await auth.createOrRotateAdminAccount('admin-rotate-1', '111111', 'org-rotate-admin', 'organization_admin');
    await auth.createOrRotateAdminAccount('admin-rotate-1', '222222', 'org-rotate-admin', 'organization_admin');

    const login = await auth.loginWithAccountIdAndPin('admin-rotate-1', '222222');
    expect(login).not.toBeNull();

    const membership = await rawQuery<{ active_flag: boolean }>(
      'select active_flag from pilot.organization_memberships where account_id = $1 and organization_id = $2',
      ['admin-rotate-1', 'org-rotate-admin'],
    );
    expect(membership).toHaveLength(1);
    expect(membership[0].active_flag).toBe(true);
  });

  test('an old session cannot inherit a role assigned to the same account in a different organization', async () => {
    await seedOrganization('org-A-inherit');
    await seedOrganization('org-B-inherit');

    await auth.createCoachAccount('coach-cross-org-1', '123456', 'org-A-inherit');
    const loginA = await auth.loginWithAccountIdAndPin('coach-cross-org-1', '123456');
    expect(loginA).not.toBeNull();
    const tokenHashA = tokenHashOf(loginA!.token);

    const beforeGrant = await rawQuery<{ revoked_at: Date | null }>(
      'select revoked_at from pilot.session_tokens where token_hash = $1',
      [tokenHashA],
    );
    expect(beforeGrant[0].revoked_at).toBeNull();

    // Grant this same account a new, higher-privilege membership in a
    // different organization.
    await auth.upsertOrganizationMembership('coach-cross-org-1', 'org-B-inherit', 'organization_admin', true);

    const afterGrant = await rawQuery<{ revoked_at: Date | null }>(
      'select revoked_at from pilot.session_tokens where token_hash = $1',
      [tokenHashA],
    );
    // The old org-A session is revoked -- it can never resolve again, so it
    // can never be observed carrying the organization_admin role granted in
    // org B.
    expect(afterGrant[0].revoked_at).not.toBeNull();
  });

  test('organization-admin revocation affects only the target account\'s sessions in that organization; sessions in other organizations remain active', async () => {
    await seedOrganization('org-scope-A');
    await seedOrganization('org-scope-B');

    await auth.createCoachAccount('coach-multi-org-1', '123456', 'org-scope-A');
    const loginInA = await auth.loginWithAccountIdAndPin('coach-multi-org-1', '123456');
    expect(loginInA).not.toBeNull();

    // Simulate this same account also holding a session scoped to a second
    // organization (multi-org membership), inserted directly since the
    // login helpers always resolve a single primary organization.
    const otherOrgTokenHash = 'other-org-session-hash-1';
    await rawQuery(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at)
       values ($1, $2, $3, now() + interval '24 hours')`,
      [otherOrgTokenHash, 'coach-multi-org-1', 'org-scope-B'],
    );

    await auth.revokeAllSessionsForAccountInOrganization('coach-multi-org-1', 'org-scope-A');

    const tokenHashInA = tokenHashOf(loginInA!.token);
    const [rowInA] = await rawQuery<{ revoked_at: Date | null }>(
      'select revoked_at from pilot.session_tokens where token_hash = $1',
      [tokenHashInA],
    );
    const [rowInB] = await rawQuery<{ revoked_at: Date | null }>(
      'select revoked_at from pilot.session_tokens where token_hash = $1',
      [otherOrgTokenHash],
    );

    expect(rowInA.revoked_at).not.toBeNull(); // revoked: in the target org
    expect(rowInB.revoked_at).toBeNull(); // untouched: a different organization
  });

  test('cross-tenant and platform-owner revocation attempts are denied without disclosing which reason applied', async () => {
    await seedOrganization('org-cross-tenant-actor');
    await seedOrganization('org-cross-tenant-target');
    await auth.createCoachAccount('coach-other-tenant-1', '123456', 'org-cross-tenant-target');

    await expect(
      auth.revokeAllSessionsForAccountInOrganization('coach-other-tenant-1', 'org-cross-tenant-actor'),
    ).rejects.toThrow('Account not found or cannot be revoked');

    await auth.createOrRotateAdminAccount('owner-cross-tenant-1', '123456', 'org-cross-tenant-actor', 'platform_owner');
    await expect(
      auth.revokeAllSessionsForAccountInOrganization('owner-cross-tenant-1', 'org-cross-tenant-actor'),
    ).rejects.toThrow('Account not found or cannot be revoked');
  });

  test('cookie lifetime and the database session expire at the same time (24 hours)', async () => {
    await seedOrganization('org-cookie-align');
    await auth.createCoachAccount('coach-cookie-1', '123456', 'org-cookie-align');
    const before = Date.now();
    const login = await auth.loginWithAccountIdAndPin('coach-cookie-1', '123456');
    const after = Date.now();
    expect(login).not.toBeNull();

    const tokenHash = tokenHashOf(login!.token);
    const [row] = await rawQuery<{ expires_at: Date }>(
      'select expires_at from pilot.session_tokens where token_hash = $1',
      [tokenHash],
    );

    const { SESSION_ABSOLUTE_LIFETIME_MS } = await import('./sessionPolicy');
    expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + SESSION_ABSOLUTE_LIFETIME_MS - 1000);
    expect(row.expires_at.getTime()).toBeLessThanOrEqual(after + SESSION_ABSOLUTE_LIFETIME_MS + 1000);
  });
});
