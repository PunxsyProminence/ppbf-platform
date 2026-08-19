// Real PostgreSQL-backed contract test for the capability-network audit
// finding's pilot_slice_postgres_research_requirement_subject_migration.sql.
//
// pilot.shadow_research_requirements had no column naming which athlete (if
// any) a row was about. listShadowResearchRequirements and
// resolveShadowResearchRequirement instead scoped a parent's read to a
// 3-field OR heuristic (source_entity_id / evidence_label /
// metadata->>'subject_id'), which only ever matched by accident -- most
// writers' source_entity_id/evidence_label hold a different kind of value
// entirely (an intake-case id, a document-classification label, a capability
// key, a learning-loop message id). This migration adds a dedicated
// subject_id column, mirroring pilot.shadow_library_documents.subject_id
// exactly (text, nullable, no foreign key).
//
// What needs proving that reading the SQL cannot prove:
//   * the gap is real: without this migration the column does not exist at
//     all
//   * a legacy row's subject_id is backfilled ONLY when a candidate value
//     (metadata.subject_id, evidence_label, or source_entity_id, checked in
//     that priority order) is an id that actually exists as an athlete in
//     the row's own organization -- a blind coalesce would carry the old
//     heuristic's unreliability forward under a new column name
//   * a row whose candidate fields are not athlete ids (a capability-gap row,
//     an upload-classification row) backfills to NULL, not to garbage
//   * re-running is a no-op, since `all` re-applies every increment on every
//     dispatch, and it must not clobber a value the application has since
//     written through the new column
//   * the table's existing idempotency key (source_entity_id staying NOT
//     NULL, backing the unique (organization_id, source_event_name,
//     source_entity_type, source_entity_id) constraint) is untouched -- this
//     migration adds a column, it does not loosen or drop one
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-research-requirement-subject-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_research_requirement_subject_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-research-requirement-subject-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-rrs';
const OTHER_ORG_ID = 'org-rrs-other';
const COACH_ID = 'acct-rrs-coach';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
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

/**
 * Fresh database at the pre-migration state, with the orgs/coach/athletes the
 * FK-free backfill join needs.
 *
 * The base schema now declares subject_id directly (mirroring
 * shadow_library_documents, which has always carried it), the same way an
 * environment stood up from scratch today would. An already-running
 * database predates that and only gains the column when this migration's own
 * ALTER runs -- so the column is dropped right back off here to reproduce
 * that real "before" state for every test below. The migration's `add column
 * if not exists` is exercised identically either way: it does not care
 * whether the schema *file* mentions the column, only whether the live
 * database has it.
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
  await client.query('alter table pilot.shadow_research_requirements drop column if exists subject_id');
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  return client;
}

/**
 * A database in the state a dispatch against a stale environment actually
 * meets: the base schema exactly as it ships, nothing dropped.
 *
 * `freshDatabase` above drops subject_id back off to reproduce a database
 * that predates the column. That is the right fixture for testing the ALTER,
 * but it is NOT the state the readiness assertion was failing to detect --
 * pilot_slice_postgres.sql declares subject_id, so on any database built from
 * it the column is present whether or not this migration ever ran, and the
 * column-shape clauses reported READY on a database the migration never
 * reached. This helper is what makes that state testable.
 */
async function baseSchemaOnlyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  return client;
}

async function insertAthlete(client: Client, organizationId: string, athleteId: string): Promise<void> {
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'RRS Athlete', '2011-05-06', 'fly', 'active', 'Guardian 555-0100', true, $3, now(), now())`,
    [organizationId, athleteId, COACH_ID],
  );
}

/** A research requirement of the shape the app wrote before this migration existed. */
async function insertLegacyRequirement(
  client: Client,
  overrides: {
    sourceEntityId: string;
    evidenceLabel?: string | null;
    metadata?: Record<string, unknown>;
    organizationId?: string;
  },
): Promise<number> {
  const row = await client.query<{ research_requirement_id: number }>(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement, knowledge_gap, evidence_label, source_status, source_confidence_tier, source_verification_state, created_by_account_id, created_by_role, metadata)
     values ($1, 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED', 'shadow_library_claim', $2, 'Strengthen evidence', 'Evidence is thin', $3, 'weak', 'INSUFFICIENT', 'unknown', $4, 'coach', $5::jsonb)
     returning research_requirement_id`,
    [
      overrides.organizationId ?? ORG_ID,
      overrides.sourceEntityId,
      overrides.evidenceLabel ?? null,
      COACH_ID,
      JSON.stringify(overrides.metadata ?? {}),
    ],
  );
  return row.rows[0].research_requirement_id;
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
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

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

describe('research requirement subject migration against real Postgres', () => {
  test('the gap is real: without the migration the column does not exist', async () => {
    const client = await freshDatabase('ppbf_test_rrs_absent');
    try {
      await expect(
        client.query('select subject_id from pilot.shadow_research_requirements'),
      ).rejects.toThrow(/column .* does not exist/i);
    } finally {
      await client.end();
    }
  });

  test('the migration adds the column, nullable text with no foreign key', async () => {
    const client = await freshDatabase('ppbf_test_rrs_fresh');
    try {
      await client.query(migrationSql);

      const columns = await client.query(
        `select column_name, data_type, is_nullable
         from information_schema.columns
         where table_schema = 'pilot'
           and table_name = 'shadow_research_requirements'
           and column_name = 'subject_id'`,
      );
      expect(columns.rows).toEqual([
        { column_name: 'subject_id', data_type: 'text', is_nullable: 'YES' },
      ]);

      // Mirrors shadow_library_documents.subject_id exactly: unlike
      // shadow_jobs.subject_id / shadow_evidence_bundles.subject_id, there is
      // deliberately no foreign key, so an athlete removed from the roster
      // later does not orphan or block deletion of the requirement row.
      const fks = await client.query(
        `select conname from pg_constraint
         where conrelid = 'pilot.shadow_research_requirements'::regclass
           and contype = 'f'
           and pg_get_constraintdef(oid) like '%subject_id%'`,
      );
      expect(fks.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a legacy row is backfilled from metadata.subject_id when it names a real athlete in the same org', async () => {
    const client = await freshDatabase('ppbf_test_rrs_meta');
    try {
      await insertAthlete(client, ORG_ID, 'ath-meta');
      const id = await insertLegacyRequirement(client, {
        sourceEntityId: 'subject:ath-meta:12345',
        metadata: { subject_id: 'ath-meta' },
      });

      await client.query(migrationSql);

      const row = await client.query(
        'select subject_id from pilot.shadow_research_requirements where research_requirement_id = $1',
        [id],
      );
      expect(row.rows[0]).toEqual({ subject_id: 'ath-meta' });
    } finally {
      await client.end();
    }
  });

  test('a legacy row with no metadata.subject_id is backfilled from evidence_label when it names a real athlete', async () => {
    const client = await freshDatabase('ppbf_test_rrs_label');
    try {
      await insertAthlete(client, ORG_ID, 'ath-label');
      const id = await insertLegacyRequirement(client, {
        sourceEntityId: 'subject:ath-label:12345',
        evidenceLabel: 'ath-label',
      });

      await client.query(migrationSql);

      const row = await client.query(
        'select subject_id from pilot.shadow_research_requirements where research_requirement_id = $1',
        [id],
      );
      expect(row.rows[0]).toEqual({ subject_id: 'ath-label' });
    } finally {
      await client.end();
    }
  });

  test('a legacy row with no matching metadata or evidence_label is backfilled from source_entity_id when it names a real athlete', async () => {
    const client = await freshDatabase('ppbf_test_rrs_entity');
    try {
      await insertAthlete(client, ORG_ID, 'ath-entity');
      const id = await insertLegacyRequirement(client, { sourceEntityId: 'ath-entity' });

      await client.query(migrationSql);

      const row = await client.query(
        'select subject_id from pilot.shadow_research_requirements where research_requirement_id = $1',
        [id],
      );
      expect(row.rows[0]).toEqual({ subject_id: 'ath-entity' });
    } finally {
      await client.end();
    }
  });

  // The property the priority order exists for: metadata.subject_id is the
  // one field the SHADOW Library claim flow actually populates with intent,
  // so it must win over a coincidental match on the older, less trustworthy
  // fields when more than one candidate happens to name a real athlete.
  test('metadata.subject_id wins over evidence_label when both name different real athletes', async () => {
    const client = await freshDatabase('ppbf_test_rrs_priority');
    try {
      await insertAthlete(client, ORG_ID, 'ath-priority-meta');
      await insertAthlete(client, ORG_ID, 'ath-priority-label');
      const id = await insertLegacyRequirement(client, {
        sourceEntityId: 'subject:ath-priority-meta:12345',
        evidenceLabel: 'ath-priority-label',
        metadata: { subject_id: 'ath-priority-meta' },
      });

      await client.query(migrationSql);

      const row = await client.query(
        'select subject_id from pilot.shadow_research_requirements where research_requirement_id = $1',
        [id],
      );
      expect(row.rows[0]).toEqual({ subject_id: 'ath-priority-meta' });
    } finally {
      await client.end();
    }
  });

  // The property this migration exists for. A blind coalesce of the three
  // legacy fields would tag an org-wide capability-gap row, an
  // upload-classification row, or a learning-loop row with a bogus
  // "subject", carrying the old heuristic's unreliability forward under a
  // new column name.
  test('a legacy row whose fields are not athlete ids backfills to null, not to garbage', async () => {
    const client = await freshDatabase('ppbf_test_rrs_nonathlete');
    try {
      const id = await insertLegacyRequirement(client, {
        sourceEntityId: 'contact_technique',
        evidenceLabel: 'contact_technique',
        metadata: { capability_key: 'contact_technique', coverage_state: 'uncovered' },
      });

      await client.query(migrationSql);

      const row = await client.query(
        'select subject_id from pilot.shadow_research_requirements where research_requirement_id = $1',
        [id],
      );
      expect(row.rows[0]).toEqual({ subject_id: null });
    } finally {
      await client.end();
    }
  });

  // An id that is a real athlete, but in a DIFFERENT organization, must not
  // backfill -- pilot.shadow_research_requirements has no cross-org
  // visibility, and the join is scoped to the row's own organization_id for
  // exactly this reason.
  test('an id that matches an athlete only in another organization does not backfill', async () => {
    const client = await freshDatabase('ppbf_test_rrs_crossorg');
    try {
      await insertAthlete(client, OTHER_ORG_ID, 'ath-cross-org');
      const id = await insertLegacyRequirement(client, {
        sourceEntityId: 'subject:ath-cross-org:12345',
        metadata: { subject_id: 'ath-cross-org' },
      });

      await client.query(migrationSql);

      const row = await client.query(
        'select subject_id from pilot.shadow_research_requirements where research_requirement_id = $1',
        [id],
      );
      expect(row.rows[0]).toEqual({ subject_id: null });
    } finally {
      await client.end();
    }
  });

  // `all` re-applies every increment on every dispatch, so this is the
  // property that makes dispatching it safe rather than merely convenient. A
  // value the application has since written directly through the new column
  // must not be clobbered by a second run re-deriving it from the legacy
  // fields.
  test('re-running is a no-op and does not overwrite a subject_id already written through the new column', async () => {
    const client = await freshDatabase('ppbf_test_rrs_rerun');
    try {
      await insertAthlete(client, ORG_ID, 'ath-rerun-old');
      await insertAthlete(client, ORG_ID, 'ath-rerun-new');
      const id = await insertLegacyRequirement(client, {
        sourceEntityId: 'subject:ath-rerun-old:12345',
        metadata: { subject_id: 'ath-rerun-old' },
      });

      await client.query(migrationSql);

      // Simulates the application writing a corrected subject_id through the
      // new column after the migration first ran.
      await client.query(
        'update pilot.shadow_research_requirements set subject_id = $1 where research_requirement_id = $2',
        ['ath-rerun-new', id],
      );

      await client.query(migrationSql);

      const row = await client.query(
        'select subject_id from pilot.shadow_research_requirements where research_requirement_id = $1',
        [id],
      );
      expect(row.rows[0]).toEqual({ subject_id: 'ath-rerun-new' });
    } finally {
      await client.end();
    }
  });

  // This table's idempotency key -- unique (organization_id,
  // source_event_name, source_entity_type, source_entity_id), backed by
  // source_entity_id staying NOT NULL -- is what createShadowResearchRequirement's
  // ON CONFLICT target resolves to. This migration adds a column; it must not
  // loosen or drop that constraint.
  test('source_entity_id is still not null and the idempotency key still rejects a duplicate tuple', async () => {
    const client = await freshDatabase('ppbf_test_rrs_constraint');
    try {
      await client.query(migrationSql);

      await expect(
        client.query(
          `insert into pilot.shadow_research_requirements
             (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement, knowledge_gap, evidence_label, source_status, source_confidence_tier, source_verification_state, created_by_account_id, created_by_role)
           values ($1, 'evt', 'type', null, 'req', 'gap', null, 'observed', 'LIMITED', 'unknown', $2, 'coach')`,
          [ORG_ID, COACH_ID],
        ),
      ).rejects.toThrow(/null value .* violates not-null constraint/i);

      await insertLegacyRequirement(client, { sourceEntityId: 'dup-entity' });
      await expect(insertLegacyRequirement(client, { sourceEntityId: 'dup-entity' })).rejects.toThrow(
        /duplicate key value violates unique constraint/i,
      );
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-research-requirement-subject-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('research requirement subject runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('resreq_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /RESEARCH_REQUIREMENT_SUBJECT_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  // THE HOLE THIS BRANCH CLOSED. The test above reaches its refusal by
  // dropping subject_id, which no database built from today's base schema
  // can be in. On a REAL base-schema-only database the column is present, the
  // three column-shape clauses were all satisfied, and the runner committed a
  // green attestation for an environment whose backfill had never run --
  // every legacy row still scoped by the old heuristic, and the parent-facing
  // athlete filter still returning nothing for them. Confirmed against the
  // pre-change runner: this state returned ACCEPT.
  test('the real runner REFUSES a base-schema-only database whose backfill never ran', async () => {
    const client = await baseSchemaOnlyDatabase('resreq_rdy_base_only');
    try {
      await insertAthlete(client, ORG_ID, 'ath-unbackfilled');
      await insertLegacyRequirement(client, {
        sourceEntityId: 'ath-unbackfilled',
        evidenceLabel: 'ath-unbackfilled',
      });

      // The column is there. That is the whole point -- presence of the
      // column is what the old assertion mistook for the migration.
      const column = await client.query(
        `select 1 from information_schema.columns
         where table_schema = 'pilot' and table_name = 'shadow_research_requirements'
           and column_name = 'subject_id'`,
      );
      expect(column.rowCount).toBe(1);

      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /RESEARCH_REQUIREMENT_SUBJECT_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  // A backfill assertion must not fire on a row the backfill deliberately
  // leaves alone. An org-wide capability-gap row names no athlete in any of
  // the three legacy fields, so subject_id staying null is the correct
  // outcome, not a missing migration.
  test('a row with no athlete-shaped candidate does not make a base-schema-only database look unmigrated', async () => {
    const client = await baseSchemaOnlyDatabase('resreq_rdy_base_only_nonathlete');
    try {
      await insertLegacyRequirement(client, {
        sourceEntityId: 'capability-38',
        evidenceLabel: 'video-scan-classification',
        metadata: { subject_id: 'not-an-athlete' },
      });

      await expect(applyMigrationTransaction(client, 'select 1')).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS the same database once the migration has run, twice over', async () => {
    const client = await baseSchemaOnlyDatabase('resreq_rdy_base_only_fixed');
    try {
      await insertAthlete(client, ORG_ID, 'ath-backfilled');
      const id = await insertLegacyRequirement(client, {
        sourceEntityId: 'ath-backfilled',
        evidenceLabel: 'ath-backfilled',
      });

      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);

      const row = await client.query(
        'select subject_id from pilot.shadow_research_requirements where research_requirement_id = $1',
        [id],
      );
      expect(row.rows[0]).toEqual({ subject_id: 'ath-backfilled' });
    } finally {
      await client.end();
    }
  });

  // A missing column must reach assertReadiness() rather than raising out of
  // the query itself: the backfill clause reads subject_id through
  // to_jsonb(rr) precisely so the operator gets the sentinel instead of a raw
  // Postgres 'column does not exist' error. This is the profile-identity
  // failure mode (documented in unexercisedMigrationRunners.pg.test.ts) not
  // being reintroduced here.
  test('a database missing the column still fails with the sentinel, not a raw Postgres error', async () => {
    const client = await freshDatabase('resreq_rdy_no_column_sentinel');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /RESEARCH_REQUIREMENT_SUBJECT_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('resreq_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
