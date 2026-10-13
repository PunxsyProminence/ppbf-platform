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
  getDrillLineageForDrill,
  listDrillChangeProposals,
  proposeDrillChange,
  reinstateDrillVersion,
  updateDrillToReferenceVersion,
} from './drillVersioning';
import { withTransaction } from './db';
import { updateDrill } from './drills';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-drill-versioning-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const PROGRESSION_MIGRATION_FILE = 'pilot_slice_postgres_progression_migration.sql';
const DRILLS_MIGRATION_FILE = 'pilot_slice_postgres_drills_migration.sql';
const VERSIONING_MIGRATION_FILE = 'pilot_slice_postgres_drill_versioning_migration.sql';
const DRILL_LIBRARY_MIGRATION_FILE = 'pilot_slice_postgres_drill_library_v3_migration.sql';
const PROVENANCE_MIGRATION_FILE = 'pilot_slice_postgres_drill_reference_provenance_migration.sql';
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
let drillLibraryMigrationSql: string;
let provenanceMigrationSql: string;
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

/**
 * The drill-versioning migration plus the two migrations W-D1 made this module
 * depend on, in the order the workflow's `all` list runs them:
 * drills -> drill-versioning -> drill-library-v3 -> drill-reference-provenance.
 *
 * WHY THE FIXTURE GREW. Per OD-2026-09-16-001 a promoted drill's successor
 * versions inherit its reference pointer, so DRILL_VERSION_FIELDS now selects
 * pilot.drills.reference_drill_id. That column is added by the
 * drill-reference-provenance migration, and its foreign key targets
 * pilot.drill_library, which drill-library-v3 creates. A fixture that stops at
 * drill-versioning is therefore no longer a smaller production -- it is a
 * schema this module cannot run against at all, which is exactly how it failed:
 * every case in the two behavioural describes below raised
 * `column "reference_drill_id" does not exist`.
 *
 * Deliberately NOT folded into freshDatabase(), and deliberately not used by the
 * readiness describe. Those cases exist to prove the VERSIONING runner refuses a
 * database where only its own migration did or did not land, and pre-applying a
 * later migration there would be asserting something else.
 */
async function applyVersioningStack(client: Client): Promise<void> {
  await applyMigrationTransaction(client, versioningMigrationSql);
  await client.query(drillLibraryMigrationSql);
  await client.query(provenanceMigrationSql);
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
  drillLibraryMigrationSql = await fs.readFile(path.join(INFRA_DIR, DRILL_LIBRARY_MIGRATION_FILE), 'utf8');
  provenanceMigrationSql = await fs.readFile(path.join(INFRA_DIR, PROVENANCE_MIGRATION_FILE), 'utf8');

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
      await applyVersioningStack(client);

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
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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

  test('getDrillLineageForDrill reads the whole lineage from any version, in the caller gym only', async () => {
    const client = await freshDatabase('ppbf_test_drillver_lineage_for_drill');
    activeClient = client;
    try {
      await applyVersioningStack(client);
      for (const org of [ORG_A, ORG_B]) {
        await client.query(
          `insert into pilot.drills (organization_id, drill_id, name, category, focus, cues)
           values ($1, 'drill-jab', 'Straight Jab Retraction Snap', 'Striking', 'Quick fist return.', $2)`,
          [org, ['Elbow tucked']],
        );
      }
      const proposal = await proposeDrillChange({
        organizationId: ORG_A,
        basedOnDrillId: 'drill-jab',
        proposedByAccountId: COACH_A,
        proposedByRole: 'coach',
        rationale: 'Athletes keep dropping the guard on the retraction.',
        proposedChange: { cues: ['Elbow tucked', 'Snap on contact'] },
      });
      const { newDrillVersion } = await adoptDrillChangeProposal({
        organizationId: ORG_A,
        proposalId: proposal.proposal_id,
        reviewedByAccountId: ADMIN_A,
        reviewedByRole: 'organization_admin',
        reviewNote: null,
      });

      const both = [[1, 'drill-jab', ORG_A], [2, newDrillVersion.drill_id, ORG_A]];
      const shape = (rows: { version: number; drill_id: string; organization_id: string }[]) =>
        rows.map((row) => [row.version, row.drill_id, row.organization_id]);
      expect(shape(await getDrillLineageForDrill(ORG_A, 'drill-jab'))).toEqual(both);
      expect(shape(await getDrillLineageForDrill(ORG_A, newDrillVersion.drill_id))).toEqual(both);

      // Another gym holding the same drill id reads its own one version, and
      // this gym's v2 id names nothing there.
      expect(shape(await getDrillLineageForDrill(ORG_B, 'drill-jab'))).toEqual([[1, 'drill-jab', ORG_B]]);
      expect(await getDrillLineageForDrill(ORG_B, newDrillVersion.drill_id)).toEqual([]);
      expect(await getDrillLineageForDrill(ORG_A, 'no-such-drill')).toEqual([]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a non-reviewer role cannot adopt or decline', async () => {
    const client = await freshDatabase('ppbf_test_drillver_role_gate');
    activeClient = client;
    try {
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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
      await applyVersioningStack(client);
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

// OD-2026-10-08-008 D3: "Refuse back-door; keep block (Recommended)".
//
// THE BACK DOOR. Adopting a change proposal inserts the next version of the
// drill with active = true. Nothing looked at whether the drill was still in
// use, so adopting a proposal on a RETIRED drill brought it back -- without any
// of the checks Restore makes (drills.ts#updateDrill: the reference must still
// be active; the route applies the cue rule). Retire and Restore here are the
// real updateDrill, not hand-written SQL, so the gate is proven against the
// rows the coach page actually leaves behind. The one exception is the
// two-connection case, which says why it writes the retire out.
//
// "Retired" is the definition getOperationalDrillLifecycle already uses: no
// version of the lineage is active. A drill that was only REFINED (an older
// version inactive, a newer one in use) is not retired, and the last-but-one
// case below holds that line so the gate cannot quietly widen.
describe('a retired drill cannot be changed through a change proposal (OD-2026-10-08-008 D3)', () => {
  const PROPOSE_REFUSAL = 'This drill is retired, so a change cannot be proposed for it. Restore the drill first.';
  const ADOPT_REFUSAL =
    'This drill is retired, so this change cannot be adopted. Restore the drill first, or decline the proposal.';

  function propose(basedOnDrillId: string, rationale = 'The hand drops on the return.') {
    return proposeDrillChange({
      organizationId: ORG_A,
      basedOnDrillId,
      proposedByAccountId: COACH_A,
      proposedByRole: 'coach',
      rationale,
      proposedChange: { focus: 'Return the hand to the chin.' },
    });
  }

  function adopt(proposalId: string) {
    return adoptDrillChangeProposal({
      organizationId: ORG_A,
      proposalId,
      reviewedByAccountId: ADMIN_A,
      reviewedByRole: 'organization_admin',
    });
  }

  async function retire(drillId: string): Promise<void> {
    const row = await updateDrill({ organizationId: ORG_A, drillId, active: false });
    expect(row?.active).toBe(false);
  }

  async function versionsOf(client: Client, lineageId: string) {
    const result = await client.query(
      `select version, drill_id, active from pilot.drills
       where organization_id = $1 and lineage_id = $2 order by version`,
      [ORG_A, lineageId],
    );
    return result.rows.map((row) => [row.version, row.drill_id, row.active]);
  }

  async function proposalState(client: Client, proposalId: string) {
    const result = await client.query(
      `select review_state, resulting_drill_id from pilot.drill_change_proposals where proposal_id = $1`,
      [proposalId],
    );
    return result.rows[0];
  }

  test('proposing a change to a retired drill is refused in plain words, and nothing is stored', async () => {
    const client = await freshDatabase('ppbf_test_drillver_retired_propose');
    activeClient = client;
    try {
      await applyVersioningStack(client);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });
      await retire('drill-jab');

      await expect(propose('drill-jab')).rejects.toMatchObject({
        message: PROPOSE_REFUSAL,
        code: 'DRILL_RETIRED',
        status: 409,
      });

      const stored = await client.query(`select count(*)::int as n from pilot.drill_change_proposals`);
      expect(stored.rows[0].n).toBe(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('THE BACK DOOR: a proposal filed while the drill was in use cannot bring it back once it is retired', async () => {
    const client = await freshDatabase('ppbf_test_drillver_retired_adopt');
    activeClient = client;
    try {
      await applyVersioningStack(client);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      // Filed while the drill is in use: legitimate, and stored.
      const proposal = await propose('drill-jab');
      await retire('drill-jab');

      await expect(adopt(proposal.proposal_id)).rejects.toMatchObject({
        message: ADOPT_REFUSAL,
        code: 'DRILL_RETIRED',
        status: 409,
      });

      // Nothing was written: no second version, the drill is still retired, and
      // the proposal is still waiting for a decision.
      expect(await versionsOf(client, 'drill-jab')).toEqual([[1, 'drill-jab', false]]);
      expect(await proposalState(client, proposal.proposal_id)).toEqual({
        review_state: 'proposed',
        resulting_drill_id: null,
      });
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a Retire that commits while the adopt is waiting on the drill is seen: the adopt refuses', async () => {
    // The gate is only the one that cannot be bypassed if it reads the drill
    // AFTER the adopt holds its row. So the retirement here is held open on a
    // second real connection: the adopt has to wait for that row, and what it
    // decides on is what the row says once the retirement commits. A gate that
    // decided on what it read before waiting would adopt, and this would fail.
    //
    // The UPDATE is the statement updateDrill issues for a retire. It is
    // written out because updateDrill runs through the mocked query on the
    // shared connection, which cannot hold a transaction open.
    const database = 'ppbf_test_drillver_retired_race';
    const client = await freshDatabase(database);
    activeClient = client;
    const retiring = new Client({ connectionString: connectionStringFor(database) });
    await retiring.connect();
    try {
      await applyVersioningStack(client);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });
      const proposal = await propose('drill-jab');

      await retiring.query('BEGIN');
      await retiring.query(
        `update pilot.drills set active = false, updated_at = now()
         where organization_id = $1 and drill_id = $2`,
        [ORG_A, 'drill-jab'],
      );

      const adopting = adopt(proposal.proposal_id).then(
        () => ({ adopted: true, reason: null as unknown }),
        (reason: unknown) => ({ adopted: false, reason }),
      );

      // Not a sleep: the retirement commits only once the adopt is seen
      // waiting on a lock, so the two really did meet on the row.
      let waiting = 0;
      for (let attempt = 0; attempt < 400 && waiting === 0; attempt += 1) {
        const result = await client.query(
          `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'`,
        );
        waiting = result.rows[0].n;
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(1);

      await retiring.query('COMMIT');

      const outcome = await adopting;
      expect(outcome.adopted).toBe(false);
      expect(outcome.reason).toMatchObject({ message: ADOPT_REFUSAL, code: 'DRILL_RETIRED', status: 409 });
      expect(await versionsOf(client, 'drill-jab')).toEqual([[1, 'drill-jab', false]]);
      expect(await proposalState(client, proposal.proposal_id)).toEqual({
        review_state: 'proposed',
        resulting_drill_id: null,
      });
    } finally {
      await retiring.query('ROLLBACK').catch(() => {});
      await retiring.end();
      activeClient = null;
      await client.end();
    }
  });

  test('the refusal is not a dead end: decline still works, and after Restore the same proposal adopts', async () => {
    const client = await freshDatabase('ppbf_test_drillver_retired_exits');
    activeClient = client;
    try {
      await applyVersioningStack(client);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const kept = await propose('drill-jab', 'First reading.');
      const dropped = await propose('drill-jab', 'Second reading.');
      await retire('drill-jab');

      await expect(adopt(kept.proposal_id)).rejects.toMatchObject({ code: 'DRILL_RETIRED' });

      // Exit one: the reviewer can still clear it from the queue.
      const declined = await declineDrillChangeProposal({
        organizationId: ORG_A,
        proposalId: dropped.proposal_id,
        reviewedByAccountId: ADMIN_A,
        reviewedByRole: 'organization_admin',
        reviewNote: 'The drill is retired.',
      });
      expect(declined.review_state).toBe('declined');

      // Exit two: Restore is the way a retired drill comes back, and once it is
      // back the proposal is an ordinary one again.
      const restored = await updateDrill({ organizationId: ORG_A, drillId: 'drill-jab', active: true });
      expect(restored?.active).toBe(true);

      const { newDrillVersion } = await adopt(kept.proposal_id);
      expect(await versionsOf(client, 'drill-jab')).toEqual([
        [1, 'drill-jab', false],
        [2, newDrillVersion.drill_id, true],
      ]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('retired is said before stale: an old proposal on a retired drill is not told to re-propose', async () => {
    // "Written against an earlier version" invites a re-proposal against the
    // newest one -- which is refused, because the drill is retired. So the
    // retired answer comes first, for the earlier version as well as the newest.
    const client = await freshDatabase('ppbf_test_drillver_retired_stale');
    activeClient = client;
    try {
      await applyVersioningStack(client);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const first = await propose('drill-jab', 'First reading.');
      const stale = await propose('drill-jab', 'Second reading.');
      const { newDrillVersion } = await adopt(first.proposal_id);
      await retire(newDrillVersion.drill_id);

      await expect(adopt(stale.proposal_id)).rejects.toMatchObject({ code: 'DRILL_RETIRED' });
      // The earlier version belongs to the same retired drill.
      await expect(propose('drill-jab')).rejects.toMatchObject({ code: 'DRILL_RETIRED' });
      await expect(propose(newDrillVersion.drill_id)).rejects.toMatchObject({ code: 'DRILL_RETIRED' });

      expect(await versionsOf(client, 'drill-jab')).toEqual([
        [1, 'drill-jab', false],
        [2, newDrillVersion.drill_id, false],
      ]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a drill that was only refined is NOT retired: its earlier version can still be proposed against', async () => {
    // The gate is "no version in use", not "this version is inactive". An
    // earlier version of a drill the gym still runs keeps today's behaviour:
    // the proposal is stored, and adopting it is refused as stale, not retired.
    const client = await freshDatabase('ppbf_test_drillver_retired_not_refined');
    activeClient = client;
    try {
      await applyVersioningStack(client);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const first = await propose('drill-jab', 'First reading.');
      const { newDrillVersion } = await adopt(first.proposal_id);

      const onEarlier = await propose('drill-jab', 'Written against the earlier version.');
      expect(onEarlier.review_state).toBe('proposed');

      // And the queue says the same thing the adopt will: stale, not retired.
      // lineage_retired is about the drill, not about the version the
      // proposal happens to be written against.
      const listed = (await listDrillChangeProposals(ORG_A, { reviewState: 'proposed' }))
        .find((row) => row.proposal_id === onEarlier.proposal_id);
      expect(listed).toMatchObject({ base_is_current: false, lineage_retired: false });

      await expect(adopt(onEarlier.proposal_id)).rejects.toThrow('DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION');

      const onCurrent = await propose(newDrillVersion.drill_id, 'Written against the current version.');
      await expect(adopt(onCurrent.proposal_id)).resolves.toBeDefined();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test("another gym's drill under the same id does not make this gym's retired drill look in use", async () => {
    // A drill id is unique per gym, not across gyms, so two gyms can hold the
    // same id and the same lineage id. Each of the three reads asks about the
    // caller's gym only; were any of them to ask about the lineage id alone,
    // the other gym's running drill would answer for this gym's retired one.
    const client = await freshDatabase('ppbf_test_drillver_retired_org');
    activeClient = client;
    try {
      await applyVersioningStack(client);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });
      await insertDrill(client, { organizationId: ORG_B, drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });

      const proposal = await propose('drill-jab');
      await retire('drill-jab');

      await expect(propose('drill-jab')).rejects.toMatchObject({ code: 'DRILL_RETIRED' });

      const listed = (await listDrillChangeProposals(ORG_A, { reviewState: 'proposed' }))
        .find((row) => row.proposal_id === proposal.proposal_id);
      expect(listed).toMatchObject({ base_is_current: true, lineage_retired: true });

      await expect(adopt(proposal.proposal_id)).rejects.toMatchObject({ code: 'DRILL_RETIRED' });
      expect(await versionsOf(client, 'drill-jab')).toEqual([[1, 'drill-jab', false]]);

      // The other gym's drill was never touched.
      const other = await client.query(
        `select version, active from pilot.drills where organization_id = $1 and drill_id = 'drill-jab'`,
        [ORG_B],
      );
      expect(other.rows).toEqual([{ version: 1, active: true }]);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('lineage_retired PREDICTS the refusal, so the queue does not offer an adopt the server will refuse', async () => {
    // base_is_current alone would read true here: the proposal IS written
    // against the newest version. The newest version is just not in use.
    const client = await freshDatabase('ppbf_test_drillver_retired_flag');
    activeClient = client;
    try {
      await applyVersioningStack(client);
      await insertDrill(client, { drillId: 'drill-jab', name: 'Straight Jab Retraction Snap' });
      await insertDrill(client, { drillId: 'drill-slip', name: 'Slip Line' });

      const onRetired = await propose('drill-jab');
      const onLive = await propose('drill-slip');
      await retire('drill-jab');

      const flagsFor = async (proposalId: string) => {
        const rows = await listDrillChangeProposals(ORG_A, { reviewState: 'proposed' });
        const row = rows.find((entry) => entry.proposal_id === proposalId);
        expect(row).toBeDefined();
        const { base_is_current, lineage_retired } = row as { base_is_current: boolean; lineage_retired: boolean };
        return { base_is_current, lineage_retired };
      };

      expect(await flagsFor(onRetired.proposal_id)).toEqual({ base_is_current: true, lineage_retired: true });
      await expect(adopt(onRetired.proposal_id)).rejects.toMatchObject({ code: 'DRILL_RETIRED' });

      expect(await flagsFor(onLive.proposal_id)).toEqual({ base_is_current: true, lineage_retired: false });
      await expect(adopt(onLive.proposal_id)).resolves.toBeDefined();
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('reinstating an earlier version of a drill (#1470), real database', () => {
  const RETIRED_REFUSAL = 'This drill is retired, so an earlier version cannot be reinstated. Restore the drill first.';
  const HEAD_REFUSAL = 'This is already the newest version.';

  async function insertReferenceVersion(
    client: Client,
    organizationId: string,
    drillId: string,
    version: number,
  ): Promise<void> {
    await client.query(
      `insert into pilot.drill_library
         (organization_id, drill_id, lineage_id, version, name, category, target_behavior, purpose,
          standard_setup, execution, what_good_looks_like, what_bad_looks_like)
       values ($1, $2, 'lin-jab', $3, $2, 'footwork', 't', 'p', 's', 'e', 'g', 'b')`,
      [organizationId, drillId, version],
    );
  }

  /**
   * One gym drill at v3: v1 (ref-v1), v2 (ref-v2, its own content) and v3
   * (ref-v3, active), each stamped superseded by the next, plus work issued on
   * v2 and on v3. The same ids are reused for every gym on purpose.
   */
  async function seedLineage(client: Client, organizationId = ORG_A): Promise<void> {
    for (const [index, ref] of ['ref-v1', 'ref-v2', 'ref-v3'].entries()) {
      await insertReferenceVersion(client, organizationId, ref, index + 1);
    }
    const versions = [
      { id: 'drill-v1', name: 'Jab Return', focus: 'v1 focus.', cues: ['Hand home'], difficulty: 'beginner', ref: 'ref-v1' },
      { id: 'drill-v2', name: 'Jab Return Snap', focus: 'v2 focus.', cues: ['Snap back', 'Chin down'], difficulty: 'advanced', ref: 'ref-v2' },
      { id: 'drill-v3', name: 'Jab Return', focus: 'v3 focus.', cues: ['Hand home first'], difficulty: 'intermediate', ref: 'ref-v3' },
    ];
    for (const [index, v] of versions.entries()) {
      const last = index === versions.length - 1;
      await client.query(
        `insert into pilot.drills
           (organization_id, drill_id, name, category, focus, cues, difficulty, active, version, lineage_id,
            supersedes_drill_id, superseded_at, reference_drill_id)
         values ($1, $2, $3, 'Striking', $4, $5::text[], $6, $7, $8, 'drill-v1', $9, $10, $11)`,
        [
          organizationId, v.id, v.name, v.focus, v.cues, v.difficulty, last, index + 1,
          index === 0 ? null : versions[index - 1].id, last ? null : '2026-10-01T00:00:00Z', v.ref,
        ],
      );
      if (index > 0) {
        await client.query(
          `update pilot.drills set superseded_by_drill_id = $3 where organization_id = $1 and drill_id = $2`,
          [organizationId, versions[index - 1].id, v.id],
        );
      }
    }

    const coach = organizationId === ORG_A ? COACH_A : `acct-drillver-coach-${organizationId}`;
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
      [coach, organizationId],
    );
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, 'ath-1', 'Athlete One', '2011-05-06', 'fly', 'active', 'contact', true, $2, now(), now())`,
      [organizationId, coach],
    );
    await client.query(
      `insert into pilot.progression_gaps
         (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description, detected_from)
       values ($1, $2, 'ath-1', $3, 'technique', 'Drops the hand.', 'coach')`,
      [`gap-${organizationId}`, organizationId, coach],
    );
    for (const drillId of ['drill-v2', 'drill-v3']) {
      await client.query(
        `insert into pilot.drill_assignments
           (assignment_id, organization_id, gap_id, athlete_id, assigned_by_account_id, drill_id,
            drill_name, drill_description)
         values ($1, $2, $3, 'ath-1', $4, $5, $6, $7)`,
        [
          `asg-${organizationId}-${drillId}`, organizationId, `gap-${organizationId}`, coach, drillId,
          `Name on ${drillId}`, `Instruction issued on ${drillId}.`,
        ],
      );
    }
  }

  async function lineageRows(client: Client, organizationId = ORG_A) {
    const { rows } = await client.query(
      `select drill_id, name, category, focus, cues, difficulty, active, version, lineage_id,
              supersedes_drill_id, superseded_at, superseded_by_drill_id, reference_drill_id, created_at, updated_at
       from pilot.drills where organization_id = $1 and lineage_id = 'drill-v1' order by version`,
      [organizationId],
    );
    return rows;
  }

  async function assignmentRows(client: Client, organizationId = ORG_A) {
    const { rows } = await client.query(
      `select assignment_id, drill_id, drill_name, drill_description
       from pilot.drill_assignments where organization_id = $1 order by assignment_id`,
      [organizationId],
    );
    return rows;
  }

  async function auditRows(client: Client, organizationId = ORG_A) {
    const { rows } = await client.query(
      `select event_type, actor_account_id, actor_role, entity_type, entity_id, details
       from pilot.audit_events where organization_id = $1 and entity_type = 'drill' order by audit_id`,
      [organizationId],
    );
    return rows;
  }

  function reinstate(drillId: string, organizationId = ORG_A) {
    return reinstateDrillVersion({ organizationId, drillId, actorAccountId: COACH_A, actorRole: 'coach' });
  }

  async function withSeededGym(name: string, run: (client: Client) => Promise<void>): Promise<void> {
    const client = await freshDatabase(name);
    activeClient = client;
    try {
      await applyVersioningStack(client);
      await seedLineage(client);
      await run(client);
    } finally {
      activeClient = null;
      await client.end();
    }
  }

  test("v2 of a v3 drill comes back as v4: v2's content and reference, v1..v3 kept, one version runs, work untouched", async () => {
    await withSeededGym('ppbf_test_drillver_reinstate', async (client) => {
      const before = await lineageRows(client);
      const assignmentsBefore = await assignmentRows(client);

      const { drill, previous, source } = await reinstate('drill-v2');

      expect(source.drill_id).toBe('drill-v2');
      expect(previous.drill_id).toBe('drill-v3');
      expect(drill).toMatchObject({
        organization_id: ORG_A,
        name: 'Jab Return Snap',
        category: 'Striking',
        focus: 'v2 focus.',
        cues: ['Snap back', 'Chin down'],
        difficulty: 'advanced',
        active: true,
        version: 4,
        lineage_id: 'drill-v1',
        supersedes_drill_id: 'drill-v3',
        superseded_at: null,
        superseded_by_drill_id: null,
        reference_drill_id: 'ref-v2',
      });

      const after = await lineageRows(client);
      expect(after).toHaveLength(4);
      // v1 and v2 are exactly as they were.
      expect(after[0]).toEqual(before[0]);
      expect(after[1]).toEqual(before[1]);
      // v3 is changed only by the head stamps.
      const stamped = new Set(['active', 'superseded_at', 'superseded_by_drill_id', 'updated_at']);
      const pick = (row: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => !stamped.has(key)));
      expect(pick(after[2])).toEqual(pick(before[2]));
      expect(after[2].active).toBe(false);
      expect(after[2].superseded_at).not.toBeNull();
      expect(after[2].superseded_by_drill_id).toBe(drill.drill_id);
      expect(after.filter((row) => row.active).map((row) => row.drill_id)).toEqual([drill.drill_id]);

      // Work issued on v2 and v3 keeps the version and the instruction it pinned.
      expect(await assignmentRows(client)).toEqual(assignmentsBefore);

      expect(await auditRows(client)).toEqual([
        {
          event_type: 'update',
          actor_account_id: COACH_A,
          actor_role: 'coach',
          entity_type: 'drill',
          entity_id: drill.drill_id,
          details: {
            action: 'reinstate_version',
            reinstated_from_drill_id: 'drill-v2',
            reinstated_from_version: 2,
            from_drill_id: 'drill-v3',
            version: 4,
            lineage_id: 'drill-v1',
            reference_drill_id: 'ref-v2',
            name: 'Jab Return Snap',
            category: 'Striking',
            difficulty: 'advanced',
          },
        },
      ]);
    });
  });

  test('a legacy lineage with an earlier version still running ends with exactly one active version', async () => {
    await withSeededGym('ppbf_test_drillver_reinstate_legacy', async (client) => {
      // v1 also running beside v3 (different names, so the name index allows it).
      await client.query(
        `update pilot.drills set name = 'Jab Return Old', active = true where organization_id = $1 and drill_id = 'drill-v1'`,
        [ORG_A],
      );

      const { drill } = await reinstate('drill-v2');

      const rows = await lineageRows(client);
      expect(rows.filter((row) => row.active).map((row) => row.drill_id)).toEqual([drill.drill_id]);
    });
  });

  test('a retired drill is refused, DRILL_RETIRED, and nothing is written', async () => {
    await withSeededGym('ppbf_test_drillver_reinstate_retired', async (client) => {
      await updateDrill({ organizationId: ORG_A, drillId: 'drill-v3', active: false });
      const before = await lineageRows(client);

      await expect(reinstate('drill-v2')).rejects.toMatchObject({
        message: RETIRED_REFUSAL,
        code: 'DRILL_RETIRED',
        status: 409,
      });
      expect(await lineageRows(client)).toEqual(before);
      expect(await auditRows(client)).toEqual([]);
    });
  });

  test('the newest version is refused, and nothing is written', async () => {
    await withSeededGym('ppbf_test_drillver_reinstate_head', async (client) => {
      const before = await lineageRows(client);

      await expect(reinstate('drill-v3')).rejects.toMatchObject({ message: HEAD_REFUSAL, status: 409 });
      expect(await lineageRows(client)).toEqual(before);
      expect(await auditRows(client)).toEqual([]);
    });
  });

  test("an earlier version whose reference was withdrawn is refused with Restore's rule and code, and nothing is written", async () => {
    await withSeededGym('ppbf_test_drillver_reinstate_withdrawn', async (client) => {
      await client.query(`update pilot.drill_library set active = false where organization_id = $1 and drill_id = 'ref-v2'`, [ORG_A]);
      const before = await lineageRows(client);

      await expect(reinstate('drill-v2')).rejects.toMatchObject({ status: 409, code: 'reference_withdrawn' });
      expect(await lineageRows(client)).toEqual(before);
      expect(await auditRows(client)).toEqual([]);
    });
  });

  test('two reinstates at once on two connections serialize on the lineage: v4 and v5, no duplicate, one runs', async () => {
    const database = 'ppbf_test_drillver_reinstate_race';
    await withSeededGym(database, async (client) => {
      // The lineage is held on a third connection, so both reinstates are
      // seen waiting before either can read the head.
      const holder = new Client({ connectionString: connectionStringFor(database) });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`select 1 from pilot.drills where organization_id = $1 and lineage_id = 'drill-v1' for update`, [ORG_A]);

        const both = Promise.allSettled([reinstate('drill-v1'), reinstate('drill-v2')]);

        let waiting = 0;
        for (let attempt = 0; attempt < 400 && waiting < 2; attempt += 1) {
          const result = await client.query(
            `select count(*)::int as n from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock'`,
          );
          waiting = result.rows[0].n;
          if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(waiting).toBe(2);
        await holder.query('COMMIT');

        const outcomes = await both;
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        await holder.end();
      }

      const rows = await lineageRows(client);
      expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
      expect(rows.filter((row) => row.active).map((row) => row.version)).toEqual([5]);
      expect(rows[3].supersedes_drill_id).toBe('drill-v3');
      expect(rows[4].supersedes_drill_id).toBe(rows[3].drill_id);
      expect(rows[3].superseded_by_drill_id).toBe(rows[4].drill_id);
      expect((await auditRows(client)).map((row) => row.details.version)).toEqual([4, 5]);
    });
  });

  test('another gym holding the very same ids is untouched, and its drill id names nothing here', async () => {
    await withSeededGym('ppbf_test_drillver_reinstate_gyms', async (client) => {
      await seedLineage(client, ORG_B);
      // The other gym is a version ahead on the same lineage id, so a head read
      // that strayed across gyms would number this gym's new version wrongly.
      await reinstate('drill-v1', ORG_B);
      const otherBefore = await lineageRows(client, ORG_B);
      const otherAssignments = await assignmentRows(client, ORG_B);
      const otherAudit = await auditRows(client, ORG_B);

      const { drill } = await reinstate('drill-v2');

      expect(drill).toMatchObject({ version: 4, supersedes_drill_id: 'drill-v3', reference_drill_id: 'ref-v2' });
      expect((await lineageRows(client)).map((row) => [row.version, row.active])).toEqual([
        [1, false], [2, false], [3, false], [4, true],
      ]);
      expect(await lineageRows(client, ORG_B)).toEqual(otherBefore);
      expect(await assignmentRows(client, ORG_B)).toEqual(otherAssignments);
      expect(await auditRows(client, ORG_B)).toEqual(otherAudit);

      // A drill that exists only in the other gym is not found from this one.
      await client.query(
        `insert into pilot.drills (organization_id, drill_id, name, category, focus)
         values ($1, 'drill-only-b', 'Only B', 'Striking', 'B focus.')`,
        [ORG_B],
      );
      await expect(reinstate('drill-only-b')).rejects.toThrow('DRILL_NOT_FOUND');
      expect((await lineageRows(client)).length).toBe(4);
    });
  });

  test('the audit row is on the same transaction: a failure after it leaves no audit row and no new version', async () => {
    await withSeededGym('ppbf_test_drillver_reinstate_rollback', async (client) => {
      const before = await lineageRows(client);

      await expect(
        withTransaction(async (tx) => {
          await reinstateDrillVersion(
            { organizationId: ORG_A, drillId: 'drill-v2', actorAccountId: COACH_A, actorRole: 'coach' },
            tx,
          );
          const seen = await tx.query(`select count(*)::int as n from pilot.audit_events where organization_id = $1`, [ORG_A]);
          expect(seen.rows[0].n).toBe(1);
          throw new Error('forced failure after the reinstate');
        }),
      ).rejects.toThrow('forced failure after the reinstate');

      expect(await lineageRows(client)).toEqual(before);
      expect(await auditRows(client)).toEqual([]);
    });
  });

  test('the D1 update to a newer reference still works after a reinstatement', async () => {
    await withSeededGym('ppbf_test_drillver_reinstate_then_d1', async (client) => {
      const { drill: v4 } = await reinstate('drill-v2');
      expect(v4.reference_drill_id).toBe('ref-v2');

      const { drill: v5, previous } = await updateDrillToReferenceVersion({
        organizationId: ORG_A,
        drillId: 'drill-v1',
        referenceDrillId: 'ref-v3',
        content: { name: 'Jab Return', category: 'Striking', focus: 'ref-v3 purpose.', cues: ['Hand home first'], difficulty: 'intermediate' },
        actorAccountId: COACH_A,
        actorRole: 'coach',
      });

      expect(previous.drill_id).toBe(v4.drill_id);
      expect(v5).toMatchObject({ version: 5, active: true, reference_drill_id: 'ref-v3', supersedes_drill_id: v4.drill_id });
      const rows = await lineageRows(client);
      expect(rows.filter((row) => row.active).map((row) => row.version)).toEqual([5]);
    });
  });
});
