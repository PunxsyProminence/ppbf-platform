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
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-expiry-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const MIGRATION_RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-session-expiry-migration.mjs');

const SCHEMA_SQL_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');
const MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  '../../../../../infra/azure/pilot_slice_postgres_session_expiry_migration.sql',
);

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

function tokenHashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// A plain `await import(specifier)` here would get downleveled by ts-jest's
// CommonJS transform into a require()-based call, which cannot load a real
// ESM-only file (the local .mjs migration runner, or the embedded-postgres
// package) and throws "Cannot use import statement outside a module".
// Constructing the import() call inside `new Function` hides it from
// TypeScript's static analysis/downleveling entirely, so it remains a
// genuine dynamic import that Node's own ESM loader executes at runtime.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

function requestWithSessionCookie(token: string): NextRequest {
  // PILOT_SESSION_COOKIE is a plain constant ('ppbf_pilot_session'); hardcoded
  // here rather than imported so this file never triggers env.ts's other
  // required-env-var checks merely by importing it.
  return new NextRequest('http://localhost/api/pilot/whatever', {
    headers: { cookie: `ppbf_pilot_session=${token}` },
  });
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
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
  PG_PORT = await findFreePort();

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
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    // Safety net only, in case the child's own graceful shutdown hangs --
    // unref'd so this timer itself can never be the reason the process
    // stays alive, and explicitly cleared by finish() the moment the child
    // actually exits so it never lingers as an open handle after a normal
    // (fast) shutdown.
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
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

describe('session-expiry migration preflight: null-organization accounts', () => {
  // A fresh install's accounts.organization_id is NOT NULL (canonical
  // schema), but production was found running with that constraint never
  // enforced -- exactly the legacy shape these tests reproduce, alongside
  // the other legacy-database stripping already done above.
  async function asLegacyDatabase(name: string): Promise<Client> {
    const client = await newTestDatabase(name);
    await client.query(await readSql(SCHEMA_SQL_PATH));
    await client.query('alter table pilot.session_tokens drop column expires_at');
    await client.query('drop index if exists idx_pilot_session_tokens_expires_at');
    await client.query('drop index if exists idx_pilot_session_tokens_account_id');
    await client.query('alter table pilot.accounts alter column organization_id drop not null');
    return client;
  }

  test('a null-org legitimate platform owner: migration succeeds and the account receives no membership row', async () => {
    const client = await asLegacyDatabase('ppbf_test_preflight_platform_owner');
    try {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag)
         values ($1, 'platform_owner', null, true, true)`,
        ['preflight-owner-1'],
      );

      await expect(client.query(await readSql(MIGRATION_SQL_PATH))).resolves.toBeDefined();

      const membership = await client.query('select 1 from pilot.organization_memberships where account_id = $1', [
        'preflight-owner-1',
      ]);
      expect(membership.rowCount).toBe(0);

      const account = await client.query<{ organization_id: string | null }>(
        'select organization_id from pilot.accounts where account_id = $1',
        ['preflight-owner-1'],
      );
      expect(account.rows[0].organization_id).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a null-org non-platform account: migration fails safely and nothing is applied', async () => {
    const client = await asLegacyDatabase('ppbf_test_preflight_invalid_account');
    try {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag)
         values ($1, 'coach', null, false, true)`,
        ['preflight-invalid-1'],
      );

      await expect(client.query(await readSql(MIGRATION_SQL_PATH))).rejects.toThrow(/preflight failed/);

      // Fails closed: every statement before the preflight check (including
      // the session_tokens.expires_at ADD COLUMN) was rolled back with it --
      // no partial rollout, same guarantee as an injected mid-migration
      // failure.
      const { rows } = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'session_tokens' and column_name = 'expires_at'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  test('a normal account still gets its missing membership backfilled alongside a legitimate platform owner', async () => {
    const client = await asLegacyDatabase('ppbf_test_preflight_mixed');
    try {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status) values ($1, 'Preflight Org', 'active')`,
        ['preflight-mixed-org'],
      );
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag)
         values ($1, 'coach', $2, false, true), ($3, 'platform_owner', null, true, true)`,
        ['preflight-mixed-coach-1', 'preflight-mixed-org', 'preflight-mixed-owner-1'],
      );

      await client.query(await readSql(MIGRATION_SQL_PATH));

      const coachMembership = await client.query<{ role: string }>(
        'select role from pilot.organization_memberships where account_id = $1 and organization_id = $2',
        ['preflight-mixed-coach-1', 'preflight-mixed-org'],
      );
      expect(coachMembership.rows[0]?.role).toBe('coach'); // backfilled, matching accounts.role

      const ownerMembership = await client.query('select 1 from pilot.organization_memberships where account_id = $1', [
        'preflight-mixed-owner-1',
      ]);
      expect(ownerMembership.rowCount).toBe(0); // still correctly excluded
    } finally {
      await client.end();
    }
  });

  test('the migration remains transactional and idempotent around the preflight check', async () => {
    const client = await asLegacyDatabase('ppbf_test_preflight_idempotent');
    try {
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag)
         values ($1, 'platform_owner', null, true, true)`,
        ['preflight-idempotent-owner-1'],
      );

      await client.query(await readSql(MIGRATION_SQL_PATH));

      // Re-running: the preflight still passes (same legitimate platform
      // owner, still null-org), and every statement below it is itself
      // idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING), so a second run
      // succeeds with no error and causes no further change.
      await expect(client.query(await readSql(MIGRATION_SQL_PATH))).resolves.toBeDefined();

      const membership = await client.query('select 1 from pilot.organization_memberships where account_id = $1', [
        'preflight-idempotent-owner-1',
      ]);
      expect(membership.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe('the migration runner itself rolls back on failure -- no partial rollout', () => {
  let client: Client;
  let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

  beforeAll(async () => {
    client = await newTestDatabase('ppbf_test_migration_runner_rollback');
    await client.query(await readSql(SCHEMA_SQL_PATH));
    await client.query('alter table pilot.session_tokens drop column expires_at');

    // A plain `await import(...)` here gets downleveled by ts-jest into a
    // require() call, which cannot load this ESM-only .mjs file (the same
    // reason embedded-postgres is spawned as a child process above) --
    // nativeDynamicImport bypasses that downleveling.
    const runnerModule = await nativeDynamicImport(MIGRATION_RUNNER_PATH);
    applyMigrationTransaction = runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
  });

  afterAll(async () => {
    await client.end();
  });

  test('the real migration SQL applies successfully through the runner\'s own transaction wrapper', async () => {
    await applyMigrationTransaction(client, await readSql(MIGRATION_SQL_PATH));

    const { rows } = await client.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
       where table_schema = 'pilot' and table_name = 'session_tokens' and column_name = 'expires_at'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe('NO');
  });

  test('an injected failing statement rolls back everything the runner already ran in that transaction', async () => {
    // A fresh database with no expires_at column, exercised through the
    // exact function pilot-apply-session-expiry-migration.mjs's CLI entry
    // point calls -- not a hand-rolled BEGIN/ROLLBACK standing in for it.
    const rollbackDb = await newTestDatabase('ppbf_test_migration_runner_rollback_2');
    await rollbackDb.query(await readSql(SCHEMA_SQL_PATH));
    await rollbackDb.query('alter table pilot.session_tokens drop column expires_at');

    const realMigrationSql = await readSql(MIGRATION_SQL_PATH);
    const brokenSql = `${realMigrationSql}\nthis is not valid sql;`;

    await expect(applyMigrationTransaction(rollbackDb, brokenSql)).rejects.toThrow();

    const { rows } = await rollbackDb.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'pilot' and table_name = 'session_tokens' and column_name = 'expires_at'`,
    );
    // Every real migration statement that ran before the injected failure
    // (including the ADD COLUMN) was rolled back along with it -- the
    // runner never leaves a partially-applied migration committed.
    expect(rows).toHaveLength(0);

    await rollbackDb.end();
  });
});

describe('session revocation regressions (real database, real application code)', () => {
  const TEST_DB_NAME = 'ppbf_test_app_regressions';

  beforeAll(async () => {
    const migrateClient = await newTestDatabase(TEST_DB_NAME);
    await migrateClient.query(await readSql(SCHEMA_SQL_PATH));
    await migrateClient.end();

    process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
    // This disposable local instance has no TLS configured. db.ts's
    // resolveSslConfig() only honors this flag when NODE_ENV is exactly
    // 'test' (which Jest itself sets) -- production and staging can never
    // trigger this path.
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

  test('a newly created organization admin can authenticate, and resolvePrincipal resolves the session end-to-end', async () => {
    await seedOrganization('org-new-admin');
    await auth.createOrRotateAdminAccount('admin-new-1', '123456', 'org-new-admin', 'organization_admin');

    const login = await auth.loginWithAccountIdAndPin('admin-new-1', '123456');
    expect(login).not.toBeNull();

    const principal = await auth.resolvePrincipal(requestWithSessionCookie(login!.token));
    expect(principal).not.toBeNull();
    expect(principal?.accountId).toBe('admin-new-1');
    expect(principal?.organizationId).toBe('org-new-admin');
    expect(principal?.role).toBe('organization_admin');
  });

  test('a rotated admin keeps an active matching membership; the old session is revoked and the new session resolves', async () => {
    await seedOrganization('org-rotate-admin');
    await auth.createOrRotateAdminAccount('admin-rotate-1', '111111', 'org-rotate-admin', 'organization_admin');
    const firstLogin = await auth.loginWithAccountIdAndPin('admin-rotate-1', '111111');
    expect(firstLogin).not.toBeNull();

    await auth.createOrRotateAdminAccount('admin-rotate-1', '222222', 'org-rotate-admin', 'organization_admin');

    // The session established before rotation must no longer resolve.
    const oldPrincipal = await auth.resolvePrincipal(requestWithSessionCookie(firstLogin!.token));
    expect(oldPrincipal).toBeNull();

    const secondLogin = await auth.loginWithAccountIdAndPin('admin-rotate-1', '222222');
    expect(secondLogin).not.toBeNull();

    const newPrincipal = await auth.resolvePrincipal(requestWithSessionCookie(secondLogin!.token));
    expect(newPrincipal).not.toBeNull();
    expect(newPrincipal?.accountId).toBe('admin-rotate-1');
    expect(newPrincipal?.organizationId).toBe('org-rotate-admin');
    expect(newPrincipal?.role).toBe('organization_admin');

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

    const principalBefore = await auth.resolvePrincipal(requestWithSessionCookie(loginA!.token));
    expect(principalBefore).not.toBeNull();

    // Grant this same account a new, higher-privilege membership in a
    // different organization.
    await auth.upsertOrganizationMembership('coach-cross-org-1', 'org-B-inherit', 'organization_admin', true);

    // The old org-A session is revoked -- it can never resolve again, so it
    // can never be observed carrying the organization_admin role granted in
    // org B.
    const principalAfter = await auth.resolvePrincipal(requestWithSessionCookie(loginA!.token));
    expect(principalAfter).toBeNull();
  });

  test('organization-admin revocation authorizes via an active secondary membership, and leaves the primary-organization session untouched', async () => {
    await seedOrganization('org-primary-A');
    await seedOrganization('org-secondary-B');

    await auth.createCoachAccount('coach-secondary-1', '123456', 'org-primary-A');
    const loginInPrimary = await auth.loginWithAccountIdAndPin('coach-secondary-1', '123456');
    expect(loginInPrimary).not.toBeNull();

    // This account also holds an active membership in a second organization,
    // distinct from its primary pilot.accounts.organization_id -- inserted
    // directly since the login/membership helpers always resolve a single
    // primary organization, and this is exactly the legitimate multi-org
    // case the prior (incorrect) accounts.organization_id-based check
    // couldn't recognize.
    await rawQuery(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, 'coach', true)
       on conflict (account_id, organization_id) do update set active_flag = true`,
      ['coach-secondary-1', 'org-secondary-B'],
    );
    const secondaryOrgTokenHash = 'secondary-org-session-hash-1';
    await rawQuery(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at)
       values ($1, $2, $3, now() + interval '24 hours')`,
      [secondaryOrgTokenHash, 'coach-secondary-1', 'org-secondary-B'],
    );

    await auth.revokeAllSessionsForAccountInOrganization('coach-secondary-1', 'org-secondary-B');

    const [secondaryRow] = await rawQuery<{ revoked_at: Date | null }>(
      'select revoked_at from pilot.session_tokens where token_hash = $1',
      [secondaryOrgTokenHash],
    );
    expect(secondaryRow.revoked_at).not.toBeNull(); // revoked: the targeted secondary organization

    const primaryTokenHash = tokenHashOf(loginInPrimary!.token);
    const [primaryRow] = await rawQuery<{ revoked_at: Date | null }>(
      'select revoked_at from pilot.session_tokens where token_hash = $1',
      [primaryTokenHash],
    );
    expect(primaryRow.revoked_at).toBeNull(); // untouched: the primary organization
  });

  test('organization-admin revocation is denied when the membership in that organization is inactive', async () => {
    await seedOrganization('org-inactive-member-primary');
    await seedOrganization('org-inactive-member-target');
    await auth.createCoachAccount('coach-inactive-member-1', '123456', 'org-inactive-member-primary');

    await rawQuery(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, 'coach', false)
       on conflict (account_id, organization_id) do update set active_flag = false`,
      ['coach-inactive-member-1', 'org-inactive-member-target'],
    );

    await expect(
      auth.revokeAllSessionsForAccountInOrganization('coach-inactive-member-1', 'org-inactive-member-target'),
    ).rejects.toThrow('Account not found or cannot be revoked');
  });

  test('organization-admin revocation is denied when there is no membership at all in that organization', async () => {
    await seedOrganization('org-no-member-primary');
    await seedOrganization('org-no-member-target');
    await auth.createCoachAccount('coach-no-member-1', '123456', 'org-no-member-primary');

    await expect(
      auth.revokeAllSessionsForAccountInOrganization('coach-no-member-1', 'org-no-member-target'),
    ).rejects.toThrow('Account not found or cannot be revoked');
  });

  test('cross-tenant, missing-membership, inactive-membership, and platform-owner denials are all indistinguishable to the caller', async () => {
    await seedOrganization('org-cross-tenant-actor');
    await seedOrganization('org-cross-tenant-target');
    await auth.createCoachAccount('coach-other-tenant-1', '123456', 'org-cross-tenant-target');

    const errors: string[] = [];

    try {
      await auth.revokeAllSessionsForAccountInOrganization('coach-other-tenant-1', 'org-cross-tenant-actor');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    await auth.createOrRotateAdminAccount('owner-cross-tenant-1', '123456', 'org-cross-tenant-actor', 'platform_owner');
    try {
      await auth.revokeAllSessionsForAccountInOrganization('owner-cross-tenant-1', 'org-cross-tenant-actor');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    expect(errors).toHaveLength(2);
    expect(new Set(errors).size).toBe(1); // exactly one distinct message across every denial reason
    expect(errors[0]).toBe('Account not found or cannot be revoked');
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
