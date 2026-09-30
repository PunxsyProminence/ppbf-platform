// created_by_role on seeded reference content is the VERIFIED actor's role:
// the role pilot.accounts holds for the account the load runs as, after the
// content-import core has checked that account may seed this gym
// (contentImport/actor.ts). Never a value carried in a seed CSV, and never an
// account the rule refuses.
//
// WHY. Until 2026-09-28 the drill and template CSVs said platform_owner on all
// 119 + 12 rows and the loaders wrote it as given, so a gym seed run as an
// organization_admin stamped every row with a role its creator never held;
// then the loaders read the account's role (lib/seed-account-role.mjs) but
// recorded ANY role, the platform owner's included. The standing ruling is
// that gym content is seeded as organization_admin, never platform_owner. The
// loaders and that helper are retired (IMP-10); the one loader left is the
// core, and this pins the rule on it.
//
// Run the way the seed workflow runs it -- runApply over the COMMITTED files,
// dataset 'all' -- against the full migrated schema, and read back EVERY table
// the load wrote, so a dataset that forgot to stamp the actor (or stamped
// something else) shows up without being named here.
//
// Replaces seedCreatedByRole.test.ts, which drove the old loaders' seedAll
// against a fake client.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

import {
  committedRows,
  createSeedingGym,
  loadReferenceContent,
  loadResearchClaimsIntoPlatformLibrary,
  openFullSchemaDatabase,
} from '../../testing/referenceContentFixture';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'seed_created_by_role';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-seed-created-by-role-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
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

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });
  serverProcess.stdout.resume();

  client = await openFullSchemaDatabase(Client, connectionStringFor, DATABASE);
  await loadResearchClaimsIntoPlatformLibrary(client);
});

afterAll(async () => {
  await client?.end().catch(() => {});
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

/** Every pilot table with an organization_id column, and whether it carries the two stamps. */
async function organizationTables(): Promise<{ table: string; account: boolean; role: boolean }[]> {
  const { rows } = await client.query<{ table_name: string; account: boolean; role: boolean }>(
    `select c.table_name,
            bool_or(c2.column_name = 'created_by_account_id') as account,
            bool_or(c2.column_name = 'created_by_role') as role
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
       join information_schema.columns c2
         on c2.table_schema = c.table_schema and c2.table_name = c.table_name
      where c.table_schema = 'pilot' and c.column_name = 'organization_id'
      group by c.table_name
      order by c.table_name`,
  );
  return rows.map((row) => ({ table: row.table_name, account: row.account, role: row.role }));
}

async function rowCounts(organizationId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { table } of await organizationTables()) {
    const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from pilot.${table} where organization_id = $1`, [organizationId]);
    counts[table] = rows[0].n;
  }
  return counts;
}

/** The distinct stamps on every row of every table this organization's load wrote. */
async function stampsOfWrittenTables(organizationId: string, before: Record<string, number>) {
  const out: Record<string, { accounts: (string | null)[]; roles: (string | null)[] }> = {};
  for (const { table, account, role } of await organizationTables()) {
    if (!account && !role) continue;
    const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from pilot.${table} where organization_id = $1`, [organizationId]);
    if (rows[0].n === (before[table] ?? 0)) continue;
    const accounts = account
      ? (await client.query<{ v: string | null }>(`select distinct created_by_account_id as v from pilot.${table} where organization_id = $1`, [organizationId])).rows.map((r) => r.v)
      : [];
    const roles = role
      ? (await client.query<{ v: string | null }>(`select distinct created_by_role as v from pilot.${table} where organization_id = $1`, [organizationId])).rows.map((r) => r.v)
      : [];
    out[table] = { accounts, roles };
  }
  return out;
}

async function historyAndAuditStamps(organizationId: string) {
  const ledger = await client.query<{ account: string; role: string }>(
    'select distinct recorded_by_account_id as account, recorded_by_role as role from pilot.reference_content_revisions where organization_id = $1',
    [organizationId],
  );
  const audit = await client.query<{ account: string; role: string }>(
    "select distinct actor_account_id as account, actor_role as role from pilot.audit_events where organization_id = $1 and entity_type = 'content_import'",
    [organizationId],
  );
  return { ledger: ledger.rows, audit: audit.rows };
}

describe('created_by_role is the verified actor role, on every row the seed path writes', () => {
  it("an organization_admin's load of 'all' records that account and organization_admin on every stamped row", async () => {
    const organizationId = 'gym_role_org_admin';
    const admin = await createSeedingGym(client, organizationId);
    const before = await rowCounts(organizationId);

    const loaded = await loadReferenceContent(client, { organizationId, actorAccountId: admin, datasets: 'all' });
    expect({ code: loaded.code, result: loaded.lines.find((line) => line.startsWith('RESULT:')) }).toMatchObject({ code: 0 });

    const stamps = await stampsOfWrittenTables(organizationId, before);
    // Every row, not a sample, in every stamped table the load wrote: a
    // dataset that fell back to a file value or a blank would add a second
    // value here.
    for (const [table, stamp] of Object.entries(stamps)) {
      expect({ table, accounts: stamp.accounts }).toEqual({ table, accounts: stamp.accounts.length ? [admin] : [] });
      expect({ table, roles: stamp.roles }).toEqual({ table, roles: stamp.roles.length ? ['organization_admin'] : [] });
    }
    // A floor, so the loop above cannot pass by reading nothing: the three
    // stamped tables the committed files fill.
    expect(Object.keys(stamps)).toEqual(expect.arrayContaining(['drill_library', 'workout_templates', 'session_scripts']));
    expect(stamps.drill_library.roles).toEqual(['organization_admin']);
    const drills = await client.query<{ n: number }>('select count(*)::int as n from pilot.drill_library where organization_id = $1', [organizationId]);
    expect(drills.rows[0].n).toBe(committedRows('drill-library/seed_drill_library.csv').length);

    // The history ledger and the audit row carry the same actor.
    expect(await historyAndAuditStamps(organizationId)).toEqual({
      ledger: [{ account: admin, role: 'organization_admin' }],
      audit: [{ account: admin, role: 'organization_admin' }],
    });
  });

  it('follows the account: an admin -- the other role the rule accepts -- is recorded as admin', async () => {
    const organizationId = 'gym_role_admin';
    const admin = await createSeedingGym(client, organizationId, { role: 'admin' });
    const before = await rowCounts(organizationId);

    const loaded = await loadReferenceContent(client, { organizationId, actorAccountId: admin, datasets: 'disciplines,drill-library,workout-templates' });
    expect(loaded.code).toBe(0);

    const stamps = await stampsOfWrittenTables(organizationId, before);
    expect(stamps.drill_library).toEqual({ accounts: [admin], roles: ['admin'] });
    expect(stamps.workout_templates).toEqual({ accounts: [admin], roles: ['admin'] });
  });
});

describe('an account the rule refuses writes nothing, and is refused before anything else is read', () => {
  interface RefusalCase {
    label: string;
    code: string;
    dryRun: boolean;
    /** Sets up the gym and returns the account id the load is run as. */
    setUp: (organizationId: string) => Promise<string>;
  }

  const cases: RefusalCase[] = [
    {
      label: 'the platform owner, even holding an active membership in the gym',
      code: 'ACTOR_PLATFORM_OWNER',
      dryRun: false,
      setUp: async (organizationId) => {
        const account = await createSeedingGym(client, organizationId, { role: 'platform_owner' });
        await client.query('update pilot.accounts set is_platform_owner = true where account_id = $1', [account]);
        return account;
      },
    },
    {
      label: 'a coach',
      code: 'ACTOR_ROLE_NOT_ALLOWED',
      dryRun: false,
      setUp: (organizationId) => createSeedingGym(client, organizationId, { role: 'coach' }),
    },
    {
      label: 'an account id that matches no account (a different casing), in a dry run too',
      code: 'ACTOR_NOT_FOUND',
      dryRun: true,
      setUp: async (organizationId) => (await createSeedingGym(client, organizationId, { accountId: `Seed-Admin@${organizationId}` })).toLowerCase(),
    },
    {
      label: 'an inactive organization admin',
      code: 'ACTOR_INACTIVE',
      dryRun: false,
      setUp: async (organizationId) => {
        const account = await createSeedingGym(client, organizationId);
        await client.query('update pilot.accounts set active_flag = false where account_id = $1', [account]);
        return account;
      },
    },
    {
      label: 'a deleted organization admin',
      code: 'ACTOR_DELETED',
      dryRun: false,
      setUp: async (organizationId) => {
        const account = await createSeedingGym(client, organizationId);
        await client.query('update pilot.accounts set deleted_at = now() where account_id = $1', [account]);
        return account;
      },
    },
    {
      label: 'an organization admin whose membership in this gym is switched off',
      code: 'ACTOR_NOT_A_MEMBER',
      dryRun: false,
      setUp: async (organizationId) => {
        const account = await createSeedingGym(client, organizationId);
        await client.query('update pilot.organization_memberships set active_flag = false where account_id = $1', [account]);
        return account;
      },
    },
  ];

  it.each(cases.map((refusal, index) => [refusal.label, index] as const))('%s', async (_label, index) => {
    const refusal = cases[index];
    const organizationId = `gym_refused_${index}`;
    const account = await refusal.setUp(organizationId);
    const before = await rowCounts(organizationId);

    // Every statement the load issues, in order.
    const issued: string[] = [];
    const recording = {
      query: (sql: string, params?: unknown[]) => {
        issued.push(sql.trim().replace(/\s+/g, ' '));
        return client.query(sql, params);
      },
    };
    const loaded = await loadReferenceContent(recording as unknown as Client, {
      organizationId,
      actorAccountId: account,
      datasets: 'all',
      dryRun: refusal.dryRun,
    });

    expect(loaded.code).toBe(1);
    expect(loaded.lines.find((line) => line.startsWith('RESULT:'))).toMatch(new RegExp(`^RESULT: REFUSED -- CONTENT_IMPORT_${refusal.code}: `));
    // Nothing written, anywhere, for this gym -- no content, no history, no audit.
    expect(await rowCounts(organizationId)).toEqual(before);
    // Refused BEFORE anything else: inside the read-only plan transaction the
    // only tables read are the ones that decide who the account is.
    expect(issued[0]).toBe('BEGIN READ ONLY');
    const reads = issued.slice(1, issued.lastIndexOf('ROLLBACK'));
    expect(reads.length).toBeGreaterThan(0);
    for (const sql of reads) {
      expect(sql).toMatch(/from pilot\.(organizations|accounts|organization_memberships)\b/);
    }
    expect(issued.some((sql) => /^begin$/i.test(sql))).toBe(false);
  });
});
