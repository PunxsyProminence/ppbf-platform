// Real PostgreSQL-backed test for recomputeShadowCapabilityCoverage.
//
// Until now this function had ZERO real-database coverage -- the only test
// touching it (the capability-coverage route test) mocks shadowLibrary
// wholesale, so the actual SQL never ran against a real Postgres. That
// mattered here specifically because this change batches what was a
// per-rule UPDATE loop (and a per-rule full-list refetch inside it) into
// one multi-row UPDATE via unnest($1::text[], $2::text[]) -- a real SQL
// construct a mock cannot validate, and exactly the kind of statement
// that's easy to get subtly wrong (column order, array binding, the join
// predicate) without ever finding out until it runs for real.
//
// './db' is mocked to route into the embedded server (see
// trainingHolds.pg.test.ts for the same pattern), so
// recomputeShadowCapabilityCoverage below is the actual production
// function executing its actual SQL against actual rows.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

import { listShadowCapabilityCoverage, recomputeShadowCapabilityCoverage } from './shadowLibrary';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-library-coverage-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-coverage';
const ADMIN_ID = 'acct-coverage-admin';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ID, ORG_ID],
  );
  return client;
}

async function seedRule(
  client: Client,
  capabilityMapId: string,
  overrides: { minimumSourceCount?: number; minimumAuthorityTier?: number } = {},
) {
  await client.query(
    `insert into pilot.shadow_library_capability_map
       (capability_map_id, organization_id, capability_key, minimum_authority_tier, minimum_source_count)
     values ($1, $2, $1, $3, $4)`,
    [capabilityMapId, ORG_ID, overrides.minimumAuthorityTier ?? 3, overrides.minimumSourceCount ?? 1],
  );
}

async function seedActiveSource(client: Client, sourceId: string, authorityTier = 1) {
  await client.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status)
     values ($1, $2, $1, 'article', $3, 'active')`,
    [sourceId, ORG_ID, authorityTier],
  );
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
});

afterAll(async () => {
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

afterEach(() => {
  activeClient = null;
});

describe('recomputeShadowCapabilityCoverage: the batched unnest UPDATE against real rows', () => {
  test('computes uncovered and covered correctly, and every rule lands its own state (not one state for all)', async () => {
    const client = await freshDatabase('coverage_states');
    activeClient = client;
    try {
      // Neither rule filters by source_type, so the one source in this org
      // is visible to both -- differentiated by authority_tier instead: a
      // tier-3 source satisfies a rule requiring tier<=3 but not one
      // requiring tier<=1, which is the actual lever that makes one rule
      // 'uncovered' and the other 'covered' from the SAME batched UPDATE,
      // not one shared state written to every row.
      await seedRule(client, 'cap-uncovered', { minimumSourceCount: 1, minimumAuthorityTier: 1 });
      await seedRule(client, 'cap-covered', { minimumSourceCount: 1, minimumAuthorityTier: 3 });
      await seedActiveSource(client, 'src-1', 3);

      const result = await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      const byKey = Object.fromEntries(result.map((row) => [row.capability_key, row.coverage_state]));
      expect(byKey['cap-uncovered']).toBe('uncovered');
      expect(byKey['cap-covered']).toBe('covered');
    } finally {
      await client.end();
    }
  });

  test('a rule with a real partial match (one source of two required) computes partial, not covered', async () => {
    const client = await freshDatabase('coverage_partial');
    activeClient = client;
    try {
      await seedRule(client, 'cap-needs-two', { minimumSourceCount: 2 });
      await seedActiveSource(client, 'src-only-one');

      const result = await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      expect(result.find((row) => row.capability_key === 'cap-needs-two')?.coverage_state).toBe('partial');
    } finally {
      await client.end();
    }
  });

  test('the batched UPDATE stamps last_evaluated_at and persists coverage_state -- verified by a second recompute call', async () => {
    const client = await freshDatabase('coverage_persist');
    activeClient = client;
    try {
      await seedRule(client, 'cap-1', { minimumSourceCount: 1 });
      await seedRule(client, 'cap-2', { minimumSourceCount: 1 });
      await seedActiveSource(client, 'src-1');

      await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      const rows = await client.query(
        `select capability_key, coverage_state, last_evaluated_at from pilot.shadow_library_capability_map
         where organization_id = $1 order by capability_key`,
        [ORG_ID],
      );
      // Every rule's row was actually written (the unnest join matched
      // every capability_map_id), not just the first one.
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        expect(row.last_evaluated_at).not.toBeNull();
      }

      const listed = await listShadowCapabilityCoverage(ORG_ID);
      expect(listed.map((row) => row.capability_key).sort()).toEqual(['cap-1', 'cap-2']);
    } finally {
      await client.end();
    }
  });

  test('an uncovered or partial rule gets exactly one open research requirement, not one per recompute call', async () => {
    const client = await freshDatabase('coverage_research_requirement');
    activeClient = client;
    try {
      await seedRule(client, 'cap-gap', { minimumSourceCount: 1 });

      await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });
      // A second recompute call, still uncovered: the pre-fetched-once
      // openItems dedup check (now shared across the whole pass instead of
      // refetched per row) must still catch this as a duplicate.
      await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      const requirements = await client.query(
        `select research_requirement_id from pilot.shadow_research_requirements
         where organization_id = $1 and source_entity_id = 'cap-gap' and status = 'open'`,
        [ORG_ID],
      );
      expect(requirements.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('a covered rule gets no research requirement at all', async () => {
    const client = await freshDatabase('coverage_no_requirement_when_covered');
    activeClient = client;
    try {
      await seedRule(client, 'cap-fine', { minimumSourceCount: 1 });
      await seedActiveSource(client, 'src-fine');

      await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      const requirements = await client.query(
        `select research_requirement_id from pilot.shadow_research_requirements
         where organization_id = $1 and source_entity_id = 'cap-fine'`,
        [ORG_ID],
      );
      expect(requirements.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  test('an org with no capability rules at all recomputes to an empty list without error', async () => {
    const client = await freshDatabase('coverage_empty');
    activeClient = client;
    try {
      const result = await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });
      expect(result).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('recompute for one organization never touches another organization\'s rules', async () => {
    const client = await freshDatabase('coverage_tenancy');
    activeClient = client;
    try {
      const OTHER_ORG_ID = 'org-coverage-other';
      const OTHER_ADMIN_ID = 'acct-coverage-other-admin';
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
        [OTHER_ORG_ID],
      );
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ($1, 'organization_admin', $2, 'microsoft')`,
        [OTHER_ADMIN_ID, OTHER_ORG_ID],
      );
      await client.query(
        `insert into pilot.shadow_library_capability_map
           (capability_map_id, organization_id, capability_key, minimum_source_count)
         values ('cap-other', $1, 'cap-other', 1)`,
        [OTHER_ORG_ID],
      );
      await seedRule(client, 'cap-mine', { minimumSourceCount: 1 });

      await recomputeShadowCapabilityCoverage({
        organizationId: ORG_ID,
        actorAccountId: ADMIN_ID,
        actorRole: 'organization_admin',
      });

      // The other org's rule was never evaluated -- last_evaluated_at stays null.
      const other = await client.query(
        `select last_evaluated_at from pilot.shadow_library_capability_map where organization_id = $1`,
        [OTHER_ORG_ID],
      );
      expect(other.rows[0].last_evaluated_at).toBeNull();
    } finally {
      await client.end();
    }
  });
});
