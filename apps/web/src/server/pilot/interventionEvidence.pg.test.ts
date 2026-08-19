// Real PostgreSQL-backed contract test for the intervention-evidence
// migration (module 026 slice 3: typed evidence links + outcome reviews).
//
// What needs proving that reading SQL cannot prove: the migration stacks
// on the whole intervention chain and is a no-op on re-apply; duplicate
// active evidence links are refused; removal requires a stated reason;
// the failure-learning rules are DATABASE facts (a miss cannot carry a
// supported hypothesis; confounded/insufficient evidence cannot
// strengthen a belief) while a miss CAN carry a reviewed learning signal;
// one active review per execution is a partial index; and the module's
// per-source validation queries really do refuse cross-athlete and
// cross-org evidence against the real source tables.
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

import { EVIDENCE_SOURCES } from './interventionEvidence';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intervention-evidence-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_intervention_evidence_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-intervention-evidence-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const LAYERED_MIGRATIONS = [
  'pilot_slice_postgres_shadow_decision_loop_migration.sql',
  'pilot_slice_postgres_drill_library_v3_migration.sql',
  'pilot_slice_postgres_session_scripts_migration.sql',
  'pilot_slice_postgres_intervention_protocols_migration.sql',
  'pilot_slice_postgres_intervention_executions_migration.sql',
  'pilot_slice_postgres_training_attempts_migration.sql',
];

const ORG_ID = 'org-evidence';
const OTHER_ORG_ID = 'org-elsewhere';
const ADMIN_ID = 'acct-evidence-admin';
const COACH_ID = 'acct-evidence-coach';
const OTHER_ADMIN_ID = 'acct-elsewhere-admin';
const ATHLETE_ID = 'ath-evidence-1';
const TEAMMATE_ID = 'ath-evidence-2';
const OTHER_ATHLETE_ID = 'ath-elsewhere-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let layeredSql: string[];
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
  for (const sql of layeredSql) {
    await client.query(sql);
  }
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft'), ($3, 'coach', $2, 'microsoft'),
            ($4, 'organization_admin', $5, 'microsoft')
     on conflict do nothing`,
    [ADMIN_ID, ORG_ID, COACH_ID, OTHER_ADMIN_ID, OTHER_ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Evidence Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now()),
            ($1, $4, 'Evidence Teammate', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now()),
            ($5, $6, 'Elsewhere Athlete', '2012-01-01', '100', 'active', 'contact', true, $7, now(), now())
     on conflict do nothing`,
    [ORG_ID, ATHLETE_ID, COACH_ID, TEAMMATE_ID, OTHER_ORG_ID, OTHER_ATHLETE_ID, OTHER_ADMIN_ID],
  );
  await client.query(
    `insert into pilot.intervention_protocols
       (organization_id, protocol_id, lineage_id, version, title, target_problem, hypothesis,
        intervention_description, expected_outcome, created_by_account_id)
     values ($1, 'proto-1', 'proto-1', 1, 'Round-3 endurance block', 'fades in round 3',
             'aerobic capacity limits round 3 output', 'constrained 3-round intervals',
             'round-3 work rate holds', $2)`,
    [ORG_ID, ADMIN_ID],
  );
  await client.query(
    `insert into pilot.intervention_executions
       (organization_id, execution_id, lineage_id, version, athlete_id, protocol_id,
        protocol_version, recorded_by_account_id, status)
     values ($1, 'exec-1', 'exec-1', 1, $2, 'proto-1', 1, $3, 'completed')`,
    [ORG_ID, ATHLETE_ID, ADMIN_ID],
  );
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  layeredSql = await Promise.all(
    LAYERED_MIGRATIONS.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

function insertLink(client: Client, linkId: string, overrides: Record<string, string | null> = {}) {
  return client.query(
    `insert into pilot.intervention_evidence_links
       (organization_id, link_id, execution_id, evidence_role, source_kind, source_id, status, removed_reason, linked_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      overrides.organization_id ?? ORG_ID,
      linkId,
      overrides.execution_id ?? 'exec-1',
      overrides.evidence_role ?? 'immediate_post',
      overrides.source_kind ?? 'training_attempt',
      overrides.source_id ?? 'att-1',
      overrides.status ?? 'active',
      overrides.removed_reason ?? '',
      ADMIN_ID,
    ],
  );
}

function insertReview(client: Client, reviewId: string, overrides: Record<string, string | null> = {}) {
  return client.query(
    `insert into pilot.intervention_outcome_reviews
       (organization_id, review_id, execution_id, performance_result, performance_notes,
        hypothesis_result, learning_signal, status, reviewed_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      ORG_ID,
      reviewId,
      overrides.execution_id ?? 'exec-1',
      overrides.performance_result ?? 'improved',
      overrides.performance_notes ?? 'round-3 output held within 8% of round 1',
      overrides.hypothesis_result ?? 'supported',
      overrides.learning_signal ?? 'prior_belief_strengthened',
      overrides.status ?? 'active',
      ADMIN_ID,
    ],
  );
}

describe('intervention evidence migration', () => {
  test('stacks on the full intervention chain, re-applies as a no-op, and refuses duplicate or silently-removed links', async () => {
    const client = await freshDatabase('evidence_fresh');
    try {
      await client.query(migrationSql);
      await insertLink(client, 'link-1');
      await client.query(migrationSql);

      // The same source in the same role on the same execution is noise.
      await expect(insertLink(client, 'link-dup')).rejects.toMatchObject({ code: '23505' });
      // Removal must be explained.
      await expect(insertLink(client, 'link-silent', { status: 'removed' }))
        .rejects.toMatchObject({ code: '23514' });
      // An invented role is refused.
      await expect(insertLink(client, 'link-role', { evidence_role: 'proof_it_worked' }))
        .rejects.toMatchObject({ code: '23514' });

      const rows = await client.query(
        `select link_id, evidence_role, source_kind from pilot.intervention_evidence_links where organization_id = $1`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([{ link_id: 'link-1', evidence_role: 'immediate_post', source_kind: 'training_attempt' }]);
    } finally {
      await client.end();
    }
  });

  test('a miss cannot validate success -- and can still produce reviewed learning', async () => {
    const client = await freshDatabase('evidence_miss');
    try {
      await client.query(migrationSql);

      // Declined performance dressed up as a supported hypothesis: refused.
      await expect(insertReview(client, 'rev-dressed', {
        performance_result: 'declined', hypothesis_result: 'supported',
      })).rejects.toMatchObject({ code: '23514' });
      // Unchanged performance cannot even be partially supported.
      await expect(insertReview(client, 'rev-partial', {
        performance_result: 'unchanged', hypothesis_result: 'partially_supported',
        learning_signal: 'unresolved',
      })).rejects.toMatchObject({ code: '23514' });
      // The honest version of the same episode is welcome: contradicted
      // belief, non-response discovered. The miss taught something.
      await insertReview(client, 'rev-honest', {
        performance_result: 'declined',
        performance_notes: 'round-3 output fell further despite full delivery',
        hypothesis_result: 'contradicted',
        learning_signal: 'intervention_non_response',
      });
    } finally {
      await client.end();
    }
  });

  test('confounded or insufficient evidence cannot strengthen a belief', async () => {
    const client = await freshDatabase('evidence_confound');
    try {
      await client.query(migrationSql);

      await expect(insertReview(client, 'rev-confound', {
        hypothesis_result: 'confounded', learning_signal: 'prior_belief_strengthened',
      })).rejects.toMatchObject({ code: '23514' });
      await expect(insertReview(client, 'rev-thin', {
        hypothesis_result: 'insufficient_evidence', learning_signal: 'prior_belief_strengthened',
      })).rejects.toMatchObject({ code: '23514' });
      // Confounded episodes still teach -- attribution changed is legal.
      await insertReview(client, 'rev-attr', {
        hypothesis_result: 'confounded', learning_signal: 'attribution_changed',
      });
    } finally {
      await client.end();
    }
  });

  test('one active review per execution; re-review supersedes rather than accumulating verdicts', async () => {
    const client = await freshDatabase('evidence_one_active');
    try {
      await client.query(migrationSql);
      await insertReview(client, 'rev-1');

      await expect(insertReview(client, 'rev-2')).rejects.toMatchObject({ code: '23505' });

      // The legal supersession path: new verdict born superseded, old
      // stamped, new activated.
      await insertReview(client, 'rev-2', { status: 'superseded' });
      await client.query(
        `update pilot.intervention_outcome_reviews set status = 'superseded' where organization_id = $1 and review_id = 'rev-1'`,
        [ORG_ID],
      );
      await client.query(
        `update pilot.intervention_outcome_reviews set status = 'active' where organization_id = $1 and review_id = 'rev-2'`,
        [ORG_ID],
      );

      const rows = await client.query(
        `select review_id from pilot.intervention_outcome_reviews where organization_id = $1 and status = 'active'`,
        [ORG_ID],
      );
      expect(rows.rows).toEqual([{ review_id: 'rev-2' }]);
    } finally {
      await client.end();
    }
  });

  test("the module's source-validation queries refuse cross-athlete and cross-org evidence against real tables", async () => {
    const client = await freshDatabase('evidence_sources');
    try {
      await client.query(migrationSql);
      await client.query(
        `insert into pilot.training_attempts
           (organization_id, attempt_id, athlete_id, recorded_by_account_id, context_type,
            metric_kind, direction, achieved_value)
         values ($1, 'att-1', $2, $3, 'session', 'reps', 'at_least', 12)`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      );
      const readiness = await client.query(
        `insert into pilot.readiness (organization_id, readiness_id, athlete_id, score, category, measured_at)
         values ($1, gen_random_uuid(), $2, 3, 'energy', now()) returning readiness_id`,
        [ORG_ID, ATHLETE_ID],
      );

      // The right athlete's evidence is found.
      const attemptHit = await client.query(EVIDENCE_SOURCES.training_attempt, [ORG_ID, 'att-1', ATHLETE_ID]);
      expect(attemptHit.rowCount).toBe(1);
      const readinessHit = await client.query(EVIDENCE_SOURCES.readiness, [ORG_ID, String(readiness.rows[0].readiness_id), ATHLETE_ID]);
      expect(readinessHit.rowCount).toBe(1);

      // A teammate's attempt cannot evidence this athlete's execution.
      const crossAthlete = await client.query(EVIDENCE_SOURCES.training_attempt, [ORG_ID, 'att-1', TEAMMATE_ID]);
      expect(crossAthlete.rowCount).toBe(0);
      // Another organization cannot see the attempt at all.
      const crossOrg = await client.query(EVIDENCE_SOURCES.training_attempt, [OTHER_ORG_ID, 'att-1', OTHER_ATHLETE_ID]);
      expect(crossOrg.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-intervention-evidence-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('intervention evidence runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('intev_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /INTERVENTION_EVIDENCE_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('intev_rdy_ok');
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
