// Real PostgreSQL-backed contract test for the drill-versioning migration
// (pilot.drills version/lineage columns, pilot.drill_change_proposals,
// pilot.drill_version_outcomes) and for drillVersioning.ts's server functions
// running against a real transaction.
//
// Seven things need proving, and none can be proven by reading SQL or by a
// mocked-query unit test:
//
// 1. Adopting a proposal produces v2, deactivates v1, and both share
//    lineage_id -- the whole point of not editing content in place.
// 2. The relaxed unique index does what its header claims: two ACTIVE drills
//    of the same name in one gym are still refused, but a superseded v1
//    coexisting with an active v2 of the same name is allowed.
// 3. resulting_drill_id's CHECK constraint holds in both directions at the
//    database level, not only in application code.
// 4. A failure partway through adoptDrillChangeProposal rolls back the WHOLE
//    transaction -- no orphan v2 row, the superseded v1 stays active, and the
//    proposal still reads 'proposed'. withTransaction is mocked here to open
//    a REAL BEGIN/COMMIT/ROLLBACK against the embedded database (mirroring
//    db.ts's own implementation) specifically so this is a real rollback,
//    not a mocked one.
// 5. getDrillLineage reads a lineage back in version order.
// 6. The runner's readiness check actually fails when the migration did not
//    land, when the partial unique index is still total, or when the
//    lineage-defaulting trigger is missing.
// 7. Two GENUINELY concurrent adopts on the same lineage -- on two separate
//    real connections, actually contending for the same row lock, not two
//    sequential calls dressed up as concurrent -- still leave exactly one
//    surviving v2 and turn the loser into a clean, catchable error rather
//    than a raw Postgres constraint violation. A prior version of this
//    module's lock comment claimed the `for update` lock on its own made
//    this a clean refusal; a review with a real two-connection reproduction
//    found Postgres's EvalPlanQual re-check can hand the second transaction
//    back the SAME (now-superseded) row instead of a re-selected one,
//    surfacing the conflict one statement later, at the v2 INSERT, as
//    `duplicate key value violates unique constraint
//    "pilot_drills_lineage_version_uq"` -- not the intended
//    DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION. Fixed by catching that
//    specific violation and translating it, matching drills.ts's own
//    pattern for turning a unique-constraint violation into a domain error.
//    This is why withTransaction is mocked to open a FRESH connection per
//    call rather than reusing one shared client -- see the mock's own
//    comment below.
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
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

// Routes drillVersioning.ts's query/queryOne into whichever embedded
// database the current test opened. withTransaction is different: it opens
// its OWN fresh connection per call (mirroring db.ts's real
// pool.connect()-per-call behavior), not activeClient, specifically so two
// concurrent adoptDrillChangeProposal calls in the same test genuinely race
// for the same row lock on two independent connections, the way two
// concurrent requests would in production -- reusing one shared connection
// would serialize them through Node's single-threaded query queue and could
// never reproduce the lock-contention behavior this file tests for.
let activeClient: Client | null = null;
let activeConnectionString: string | null = null;

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
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeConnectionString) throw new Error('test bug: no active embedded database');
    const client = new Client({ connectionString: activeConnectionString });
    await client.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally {
      await client.end();
    }
  }),
}));

import {
  adoptDrillChangeProposal,
  declineDrillChangeProposal,
  getDrillLineage,
  listDrillChangeProposals,
  proposeDrillChange,
} from './drillVersioning';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-versioning-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const PROGRESSION_MIGRATION_FILE = 'pilot_slice_postgres_progression_migration.sql';
const DRILLS_MIGRATION_FILE = 'pilot_slice_postgres_drills_migration.sql';
const VERSIONING_MIGRATION_FILE = 'pilot_slice_postgres_drill_versioning_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-drill-versioning-migration.mjs',
);

const ORG_A = 'org-drillver-a';
const ORG_B = 'org-drillver-b';
const COACH_A = 'acct-drillver-coach-a';
const ADMIN_A = 'acct-drillver-admin-a';

// ts-jest downlevels a plain `await import(...)` into require(), which cannot
// load an ESM-only .mjs file. Building the import() call inside `new Function`
// hides it from that transform, so Node's own ESM loader executes it.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let versioningMigrationSql: string;
let baseSchemaSql: string;
let progressionMigrationSql: string;
let drillsMigrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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

/**
 * Fresh database with the base schema, pilot.drill_assignments (the drills
 * migration ALTERs it, so progression has to land first), pilot.drills (this
 * migration ALTERs it), and two organizations with a coach and an org admin
 * on ORG_A. The drill-versioning migration itself is NOT applied here --
 * each test decides when to apply it.
 */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(progressionMigrationSql);
  await client.query(drillsMigrationSql);

  for (const organizationId of [ORG_A, ORG_B]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_A, ORG_A],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_A, ORG_A],
  );

  activeConnectionString = connectionStringFor(name);
  return client;
}

async function insertDrill(
  client: Client,
  values: {
    organizationId?: string;
    drillId: string;
    name: string;
    category?: string;
    focus?: string;
    active?: boolean;
    lineageId?: string;
    version?: number;
  },
): Promise<void> {
  await client.query(
    `insert into pilot.drills
       (organization_id, drill_id, name, category, focus, active, lineage_id, version)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      values.organizationId ?? ORG_A,
      values.drillId,
      values.name,
      values.category ?? 'Striking',
      values.focus ?? 'Quick fist return to protect chin and guard stance.',
      values.active ?? true,
      values.lineageId ?? values.drillId,
      values.version ?? 1,
    ],
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


/* PRODUCTION HAS THIS MIGRATION, so the fixture does too. It adds
   pilot.athletes.deleted_at, which the authorization queries in access.ts now
   require. deploy-production's schema check asserts every migration's
   `add column` exists in the live database and it passed on the 2026-08-27
   release, so a fixture without it is not a smaller production -- it is a
   schema nobody runs. Concatenated onto the base schema rather than applied
   separately so that every site which applies baseSchemaSql gets it. */
  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8')
    + '\n'
    + await fs.readFile(
      path.join(INFRA_DIR, 'pilot_slice_postgres_data_retention_deletion_migration.sql'), 'utf8',
    );
  progressionMigrationSql = await fs.readFile(path.join(INFRA_DIR, PROGRESSION_MIGRATION_FILE), 'utf8');
  drillsMigrationSql = await fs.readFile(path.join(INFRA_DIR, DRILLS_MIGRATION_FILE), 'utf8');
  versioningMigrationSql = await fs.readFile(path.join(INFRA_DIR, VERSIONING_MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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
});

describe('drill versioning migration readiness against real Postgres', () => {
  // NEGATIVE CONTROL. If readiness passed here, every other assertion in this
  // file would be worthless: the runner would commit an environment where the
  // migration silently did nothing.
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_drillver_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILL_VERSIONING_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.drill_change_proposals') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      await client.end();
    }
  });

  // The whole point of this migration is to replace the TOTAL unique index
  // with a PARTIAL one. A readiness check that only looked for "an index of
  // this name" would pass on an environment still carrying the OLD total
  // index, which refuses every refinement outright.
  test('the readiness check REFUSES a database whose name-uniqueness index is still total', async () => {
    const client = await freshDatabase('ppbf_test_drillver_readiness_total_index');
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await client.query('drop index pilot.pilot_drills_one_name_per_org');
      await client.query(
        'create unique index pilot_drills_one_name_per_org on pilot.drills(organization_id, name)',
      );

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILL_VERSIONING_NOT_READY/,
      );

      // Re-running restores the partial index.
      await applyMigrationTransaction(client, versioningMigrationSql);
      const { rows } = await client.query(
        `select indisunique, indpred is not null as is_partial
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
         where c.relname = 'pilot_drills_one_name_per_org'`,
      );
      expect(rows).toEqual([{ indisunique: true, is_partial: true }]);
    } finally {
      await client.end();
    }
  });

  // A lineage_id column with no trigger would refuse every insert that does
  // not name a lineage explicitly -- breaking drills.ts#createDrill's
  // unmodified INSERT.
  test('the readiness check REFUSES a database whose lineage-defaulting trigger is missing', async () => {
    const client = await freshDatabase('ppbf_test_drillver_readiness_trigger');
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await client.query('drop trigger pilot_drills_default_lineage_id on pilot.drills');

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /DRILL_VERSIONING_NOT_READY/,
      );

      await applyMigrationTransaction(client, versioningMigrationSql);
      const { rows } = await client.query(
        `select 1 from pg_trigger where tgname = 'pilot_drills_default_lineage_id'`,
      );
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints or indexes', async () => {
    const client = await freshDatabase('ppbf_test_drillver_idempotent');
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-idem', name: 'Idempotent Drill' });

      await applyMigrationTransaction(client, versioningMigrationSql);
      await applyMigrationTransaction(client, versioningMigrationSql);

      const drills = await client.query(
        `select drill_id from pilot.drills where organization_id = $1`,
        [ORG_A],
      );
      expect(drills.rows).toHaveLength(1);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in (
           'pilot_drills_version_positive_check', 'pilot_drills_supersedes_not_self_check',
           'pilot_drills_supersedes_fk', 'pilot_drills_superseded_by_fk',
           'pilot_drill_change_proposals_review_state_check',
           'pilot_drill_change_proposals_resulting_pairing_check',
           'pilot_drill_version_outcomes_completion_rate_check',
           'pilot_drill_version_outcomes_window_order_check',
           'pilot_drill_version_outcomes_computed_by_check'
         )`,
      );
      expect(constraints.rows[0].n).toBe(9);
    } finally {
      await client.end();
    }
  });
});

describe('a fresh drill defaults its own lineage_id', () => {
  test('createDrill-style insert (no lineage_id named) becomes its own lineage v1', async () => {
    const client = await freshDatabase('ppbf_test_drillver_default_lineage');
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);

      await client.query(
        `insert into pilot.drills (organization_id, drill_id, name, category, focus)
         values ($1, 'drill-fresh', 'Fresh Drill', 'Striking', 'A brand new drill.')`,
        [ORG_A],
      );

      const { rows } = await client.query(
        `select lineage_id, version, supersedes_drill_id from pilot.drills where drill_id = 'drill-fresh'`,
      );
      expect(rows).toEqual([{ lineage_id: 'drill-fresh', version: 1, supersedes_drill_id: null }]);
    } finally {
      await client.end();
    }
  });
});

describe('the relaxed unique-name index', () => {
  test('still refuses two ACTIVE drills of the same name in one gym', async () => {
    const client = await freshDatabase('ppbf_test_drillver_active_name_conflict');
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-jab-1', name: 'Straight Jab Retraction Snap' });

      await expect(
        insertDrill(client, { drillId: 'drill-jab-2', name: 'Straight Jab Retraction Snap' }),
      ).rejects.toThrow(/pilot_drills_one_name_per_org|duplicate key/);
    } finally {
      await client.end();
    }
  });

  test('allows a superseded v1 and an active v2 to share a name', async () => {
    const client = await freshDatabase('ppbf_test_drillver_superseded_name_ok');
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-jab-v1', name: 'Straight Jab Retraction Snap', active: false });
      await insertDrill(client, {
        drillId: 'drill-jab-v2',
        name: 'Straight Jab Retraction Snap',
        lineageId: 'drill-jab-v1',
        version: 2,
        active: true,
      });

      const { rows } = await client.query(
        `select drill_id, active from pilot.drills where lineage_id = 'drill-jab-v1' order by version`,
      );
      expect(rows).toEqual([
        { drill_id: 'drill-jab-v1', active: false },
        { drill_id: 'drill-jab-v2', active: true },
      ]);
    } finally {
      await client.end();
    }
  });
});

describe('the resulting_drill_id pairing CHECK constraint', () => {
  test('refuses resulting_drill_id on a proposal that is not adopted', async () => {
    const client = await freshDatabase('ppbf_test_drillver_pairing_check_a');
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-base', name: 'Base Drill' });

      await expect(
        client.query(
          `insert into pilot.drill_change_proposals
             (proposal_id, organization_id, lineage_id, based_on_drill_id, proposed_by_account_id,
              proposed_by_role, rationale, review_state, resulting_drill_id)
           values ('prop-bad-1', $1, 'drill-base', 'drill-base', $2, 'coach', 'A rationale.', 'proposed', 'drill-base')`,
          [ORG_A, COACH_A],
        ),
      ).rejects.toThrow(/pilot_drill_change_proposals_resulting_pairing_check/);
    } finally {
      await client.end();
    }
  });

  test('refuses an adopted proposal with no resulting_drill_id', async () => {
    const client = await freshDatabase('ppbf_test_drillver_pairing_check_b');
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-base', name: 'Base Drill' });

      await expect(
        client.query(
          `insert into pilot.drill_change_proposals
             (proposal_id, organization_id, lineage_id, based_on_drill_id, proposed_by_account_id,
              proposed_by_role, rationale, review_state)
           values ('prop-bad-2', $1, 'drill-base', 'drill-base', $2, 'coach', 'A rationale.', 'adopted')`,
          [ORG_A, COACH_A],
        ),
      ).rejects.toThrow(/pilot_drill_change_proposals_resulting_pairing_check/);
    } finally {
      await client.end();
    }
  });
});

describe('drillVersioning.ts against real Postgres', () => {
  test('adopting a proposal produces v2, deactivates v1, and both share lineage_id', async () => {
    const client = await freshDatabase('ppbf_test_drillver_adopt_happy');
    activeClient = client;
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await client.query(
        `insert into pilot.drills (organization_id, drill_id, name, category, focus, cues)
         values ($1, 'drill-jab', 'Straight Jab Retraction Snap', 'Striking', 'Quick fist return.', $2)`,
        [ORG_A, ['Elbow tucked']],
      );

      const proposal = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'Athletes keep dropping the guard on the retraction.',
        proposedChange: { cues: ['Elbow tucked', 'Snap on contact'] },
      });
      expect(proposal.lineage_id).toBe('drill-jab');
      expect(proposal.review_state).toBe('proposed');

      const { proposal: adopted, newDrillVersion } = await adoptDrillChangeProposal({
        organizationId: ORG_A,
        proposalId: proposal.proposal_id,
        reviewedByAccountId: ADMIN_A,
        reviewedByRole: 'organization_admin',
        reviewNote: 'Good catch, adopting.',
      });

      expect(adopted.review_state).toBe('adopted');
      expect(adopted.resulting_drill_id).toBe(newDrillVersion.drill_id);
      expect(newDrillVersion.version).toBe(2);
      expect(newDrillVersion.lineage_id).toBe('drill-jab');
      expect(newDrillVersion.cues).toEqual(['Elbow tucked', 'Snap on contact']);
      expect(newDrillVersion.active).toBe(true);

      const v1 = await client.query(
        `select active, superseded_at is not null as superseded, superseded_by_drill_id
         from pilot.drills where drill_id = 'drill-jab'`,
      );
      expect(v1.rows[0]).toEqual({
        active: false,
        superseded: true,
        superseded_by_drill_id: newDrillVersion.drill_id,
      });

      const lineage = await getDrillLineage(ORG_A, 'drill-jab');
      expect(lineage.map((row) => [row.version, row.drill_id])).toEqual([
        [1, 'drill-jab'],
        [2, newDrillVersion.drill_id],
      ]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a non-reviewer role cannot adopt or decline', async () => {
    const client = await freshDatabase('ppbf_test_drillver_role_gate');
    activeClient = client;
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const proposal = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'A rationale.',
      });

      await expect(
        adoptDrillChangeProposal({
          organizationId: ORG_A,
          proposalId: proposal.proposal_id,
          reviewedByAccountId: COACH_A,
          reviewedByRole: 'coach',
        }),
      ).rejects.toThrow(/Forbidden/);

      await expect(
        declineDrillChangeProposal({
          organizationId: ORG_A,
          proposalId: proposal.proposal_id,
          reviewedByAccountId: COACH_A,
          reviewedByRole: 'coach',
          reviewNote: 'No.',
        }),
      ).rejects.toThrow(/Forbidden/);

      const stillProposed = await client.query(
        `select review_state from pilot.drill_change_proposals where proposal_id = $1`,
        [proposal.proposal_id],
      );
      expect(stillProposed.rows[0].review_state).toBe('proposed');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('refuses a proposal whose base version was superseded by another adopted proposal first', async () => {
    const client = await freshDatabase('ppbf_test_drillver_stale_base');
    activeClient = client;
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const proposalOne = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'First rationale.',
        proposedChange: { focus: 'Updated focus one.' },
      });
      const proposalTwo = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'Second rationale, written against the same v1.',
        proposedChange: { focus: 'Updated focus two.' },
      });

      await adoptDrillChangeProposal({
        organizationId: ORG_A,
        proposalId: proposalOne.proposal_id,
        reviewedByAccountId: ADMIN_A,
        reviewedByRole: 'organization_admin',
      });

      await expect(
        adoptDrillChangeProposal({
          organizationId: ORG_A,
          proposalId: proposalTwo.proposal_id,
          reviewedByAccountId: ADMIN_A,
          reviewedByRole: 'organization_admin',
        }),
      ).rejects.toThrow('DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION');

      const lineage = await getDrillLineage(ORG_A, 'drill-jab');
      expect(lineage).toHaveLength(2);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // GENUINE concurrency, not two sequential calls: both adopts are launched
  // together via Promise.allSettled, each on its own real connection (see
  // the withTransaction mock above), so they actually contend for the same
  // `for update` row lock on drill-jab's current-latest-version row --
  // exactly the scenario this file's header describes. Regardless of which
  // one wins the lock race, or whether the loser's staleness check trips
  // before or after its own INSERT, exactly one adoption must survive and
  // the other must fail with the clean DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION
  // error -- never a raw Postgres constraint-violation message reaching the
  // caller, and never two v2 rows.
  test('two genuinely concurrent adopts on the same lineage: exactly one survives, the other fails cleanly', async () => {
    const client = await freshDatabase('ppbf_test_drillver_real_race');
    activeClient = client;
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const proposalOne = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'First coach noticed guard drop.',
        proposedChange: { focus: 'Updated focus from coach one.' },
      });
      const proposalTwo = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'Second coach noticed the same thing independently.',
        proposedChange: { focus: 'Updated focus from coach two.' },
      });

      const [resultOne, resultTwo] = await Promise.allSettled([
        adoptDrillChangeProposal({
          organizationId: ORG_A,
          proposalId: proposalOne.proposal_id,
          reviewedByAccountId: ADMIN_A,
          reviewedByRole: 'organization_admin',
        }),
        adoptDrillChangeProposal({
          organizationId: ORG_A,
          proposalId: proposalTwo.proposal_id,
          reviewedByAccountId: ADMIN_A,
          reviewedByRole: 'organization_admin',
        }),
      ]);

      const outcomes = [resultOne, resultTwo];
      const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
      const rejected = outcomes.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // Never the raw Postgres constraint-violation message -- always the
      // same clean, catchable error the sequential staleness test above
      // asserts on.
      const rejectedReason = (rejected[0] as PromiseRejectedResult).reason as Error;
      expect(rejectedReason.message).toBe('DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION');

      const lineage = await getDrillLineage(ORG_A, 'drill-jab');
      expect(lineage).toHaveLength(2);
      expect(lineage.filter((row) => row.version === 2)).toHaveLength(1);
      expect(lineage.find((row) => row.version === 1)?.active).toBe(false);

      const proposals = await listDrillChangeProposals(ORG_A, { lineageId: 'drill-jab' });
      const adopted = proposals.filter((row) => row.review_state === 'adopted');
      const stillProposed = proposals.filter((row) => row.review_state === 'proposed');
      expect(adopted).toHaveLength(1);
      expect(stillProposed).toHaveLength(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // A failure after the v2 INSERT and the v1 deactivation UPDATE, but before
  // the transaction commits, must roll back BOTH of those, not merely fail to
  // finish. reviewedByAccountId names an account that does not exist, so the
  // FINAL statement (stamping the proposal reviewed_by_account_id) trips the
  // foreign key -- proving the whole transaction is one atomic unit rather
  // than a sequence of independently-committed statements.
  test('a failure partway through adopt rolls back the whole transaction', async () => {
    const client = await freshDatabase('ppbf_test_drillver_rollback');
    activeClient = client;
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const proposal = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'A rationale.',
        proposedChange: { focus: 'A new focus that would become v2.' },
      });

      await expect(
        adoptDrillChangeProposal({
          organizationId: ORG_A,
          proposalId: proposal.proposal_id,
          reviewedByAccountId: 'acct-does-not-exist',
          reviewedByRole: 'organization_admin',
        }),
      ).rejects.toThrow(/foreign key/);

      const drills = await client.query(
        `select drill_id, active from pilot.drills where lineage_id = 'drill-jab' order by drill_id`,
      );
      // No orphan v2: exactly the original v1, still active.
      expect(drills.rows).toEqual([{ drill_id: 'drill-jab', active: true }]);

      const stillProposed = await client.query(
        `select review_state, resulting_drill_id from pilot.drill_change_proposals
         where proposal_id = $1`,
        [proposal.proposal_id],
      );
      expect(stillProposed.rows[0]).toEqual({ review_state: 'proposed', resulting_drill_id: null });
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('declining requires a review note and leaves no resulting version', async () => {
    const client = await freshDatabase('ppbf_test_drillver_decline');
    activeClient = client;
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const proposal = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'A rationale.',
      });

      const declined = await declineDrillChangeProposal({
        organizationId: ORG_A,
        proposalId: proposal.proposal_id,
        reviewedByAccountId: ADMIN_A,
        reviewedByRole: 'organization_admin',
        reviewNote: 'Not the direction we want.',
      });
      expect(declined.review_state).toBe('declined');
      expect(declined.resulting_drill_id).toBeNull();

      const drills = await client.query(
        `select drill_id from pilot.drills where lineage_id = 'drill-jab'`,
      );
      expect(drills.rows).toEqual([{ drill_id: 'drill-jab' }]);

      // A proposal already decided cannot be decided again.
      await expect(
        declineDrillChangeProposal({
          organizationId: ORG_A,
          proposalId: proposal.proposal_id,
          reviewedByAccountId: ADMIN_A,
          reviewedByRole: 'organization_admin',
          reviewNote: 'Again.',
        }),
      ).rejects.toThrow('DRILL_CHANGE_PROPOSAL_NOT_FOUND_OR_ALREADY_DECIDED');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('the queue says which siblings adopting one proposal just made un-adoptable', async () => {
    // THE REVIEWER'S PROBLEM. Three coaches propose changes to the same drill,
    // all against v1. Adopting any one advances the lineage and leaves the
    // other two based on a version that no longer exists as current -- so they
    // are correctly refused, and before this the ONLY way to find that out was
    // to attempt each adopt and collect identical errors.
    const client = await freshDatabase('ppbf_test_drillver_stale_visible');
    activeClient = client;
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const proposals = [];
      for (const rationale of ['First reading.', 'Second reading.', 'Third reading.']) {
        proposals.push(await proposeDrillChange({
          organizationId: ORG_A,
          basedOnDrillId: 'drill-jab',
          proposedByAccountId: COACH_A,
          proposedByRole: 'coach',
          rationale,
        }));
      }

      // Before any adopt: all three are actionable, and say so.
      const before = await listDrillChangeProposals(ORG_A, { reviewState: 'proposed' });
      expect(before).toHaveLength(3);
      expect(before.every((row) => row.base_is_current)).toBe(true);
      expect(before.every((row) => row.current_drill_id === 'drill-jab')).toBe(true);

      const { newDrillVersion } = await adoptDrillChangeProposal({
        organizationId: ORG_A,
        proposalId: proposals[0].proposal_id,
        reviewedByAccountId: ADMIN_A,
        reviewedByRole: 'organization_admin',
      });

      const after = await listDrillChangeProposals(ORG_A, { reviewState: 'proposed' });
      expect(after).toHaveLength(2);
      // Both survivors now report themselves stale, and name what superseded
      // them -- which is the thing a reviewer needs in order to tell the coach
      // anything useful.
      expect(after.every((row) => row.base_is_current)).toBe(false);
      expect(after.every((row) => row.current_drill_id === newDrillVersion.drill_id)).toBe(true);
      expect(after.every((row) => row.based_on_drill_id === 'drill-jab')).toBe(true);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('base_is_current PREDICTS the adopt: true adopts, false throws', async () => {
    // The property that makes the flag worth trusting. The read computes the
    // lineage's current version with the same `order by version desc limit 1`
    // the adopt path locks on; if the two ever diverged, the queue would
    // confidently mislabel exactly the rows a reviewer relies on it for.
    //
    // Asserted as a round trip rather than by comparing the two SQL strings:
    // matching text would pass while both were wrong together.
    const client = await freshDatabase('ppbf_test_drillver_flag_predicts');
    activeClient = client;
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const first = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'First reading.',
      });
      const second = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'Second reading.',
      });

      const flagFor = async (proposalId: string): Promise<boolean> => {
        const rows = await listDrillChangeProposals(ORG_A, { reviewState: 'proposed' });
        const row = rows.find((entry) => entry.proposal_id === proposalId);
        expect(row).toBeDefined();
        return (row as { base_is_current: boolean }).base_is_current;
      };

      // Flag true -> the adopt succeeds.
      expect(await flagFor(first.proposal_id)).toBe(true);
      await expect(adoptDrillChangeProposal({
        organizationId: ORG_A,
        proposalId: first.proposal_id,
        reviewedByAccountId: ADMIN_A,
        reviewedByRole: 'organization_admin',
      })).resolves.toBeDefined();

      // Flag false -> the adopt throws, with the error the flag was warning about.
      expect(await flagFor(second.proposal_id)).toBe(false);
      await expect(adoptDrillChangeProposal({
        organizationId: ORG_A,
        proposalId: second.proposal_id,
        reviewedByAccountId: ADMIN_A,
        reviewedByRole: 'organization_admin',
      })).rejects.toThrow('DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a stale proposal can still be declined -- the queue has an exit', async () => {
    // Staleness closes the adopt path and nothing else. If it closed decline
    // too, the proposal would be stuck in the queue forever -- the no-exit
    // defect the feedback review queue had (#122) and the Film Study proposals
    // migration was written to avoid repeating. Asserted so a future
    // "tidy up: refuse decisions on stale proposals" cannot reintroduce it.
    const client = await freshDatabase('ppbf_test_drillver_stale_exit');
    activeClient = client;
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const first = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'First reading.',
      });
      const stranded = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'Second reading.',
      });

      await adoptDrillChangeProposal({
        organizationId: ORG_A,
        proposalId: first.proposal_id,
        reviewedByAccountId: ADMIN_A,
        reviewedByRole: 'organization_admin',
      });

      const declined = await declineDrillChangeProposal({
        organizationId: ORG_A,
        proposalId: stranded.proposal_id,
        reviewedByAccountId: ADMIN_A,
        reviewedByRole: 'organization_admin',
        reviewNote: 'Superseded by another change; please re-propose against v2.',
      });
      expect(declined.review_state).toBe('declined');

      // And it is gone from the working queue rather than lingering.
      const remaining = await listDrillChangeProposals(ORG_A, { reviewState: 'proposed' });
      expect(remaining).toEqual([]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('listDrillChangeProposals is scoped by organization and filterable by state', async () => {
    const client = await freshDatabase('ppbf_test_drillver_list_scope');
    activeClient = client;
    try {
      await applyMigrationTransaction(client, versioningMigrationSql);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });
      await insertDrill(client, { organizationId: ORG_B, drillId: 'drill-b', name: 'Org B Drill' });
      await client.query(
        `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
         values ('acct-drillver-coach-b', 'coach', $1, 'microsoft') on conflict do nothing`,
        [ORG_B],
      );

      const proposalA = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'Org A rationale.',
      });
      await proposeDrillChange({
        organizationId: ORG_B,
        basedOnDrillId: 'drill-b',
        proposedByAccountId: 'acct-drillver-coach-b',
        proposedByRole: 'coach',
        rationale: 'Org B rationale.',
      });
      await declineDrillChangeProposal({
        organizationId: ORG_A,
        proposalId: proposalA.proposal_id,
        reviewedByAccountId: ADMIN_A,
        reviewedByRole: 'organization_admin',
        reviewNote: 'Not now.',
      });

      const orgAAll = await listDrillChangeProposals(ORG_A);
      expect(orgAAll.map((row) => row.proposal_id)).toEqual([proposalA.proposal_id]);

      const orgAProposed = await listDrillChangeProposals(ORG_A, { reviewState: 'proposed' });
      expect(orgAProposed).toEqual([]);

      const orgADeclined = await listDrillChangeProposals(ORG_A, { reviewState: 'declined' });
      expect(orgADeclined.map((row) => row.proposal_id)).toEqual([proposalA.proposal_id]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
