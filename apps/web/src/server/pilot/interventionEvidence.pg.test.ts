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

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import type { PilotPrincipal } from './auth';
import { closePool } from './db';
import { requirePrincipal } from './http';
import {
  EVIDENCE_SOURCES,
  getEvidenceLinkOwner,
  linkEvidence,
  listEvidence,
  removeEvidence,
} from './interventionEvidence';

// Lane N3-02's route-level block (bottom of this file) drives the real
// routes. They take their principal from here; everything else in the module
// -- and every other module, access.ts included -- stays real.
jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

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
  // The film-study admissibility gate had no Postgres-level proof while this
  // migration was absent here (the module header used to record that gap).
  'pilot_slice_postgres_film_study_proposals_migration.sql',
  // listEvidence LEFT JOINs pilot.readiness for method/reliability/validity, and
  // those three columns are added by this migration rather than by the base
  // schema -- pilot.readiness exists without them. Absent here, the admissibility
  // case died on `column r.method does not exist` while every other case passed,
  // because only that one calls the shipped listEvidence against a real database.
  // It alters pilot.readiness and pilot.accounts, both in the base schema; its
  // several mentions of pilot.assessment_protocols are all comments and column
  // COMMENT text, so it pulls in no further migration.
  'pilot_slice_postgres_readiness_provenance_migration.sql',
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
      // `method` is stated rather than defaulted: the provenance migration drops
      // the column default on purpose, so an insert that omits it fails instead
      // of quietly claiming 'UNKNOWN'. 'staff_entered_intake' is what the only
      // real writer (intake.ts#createReadiness) stamps. The three measurement
      // properties keep their unvalidated defaults, which is how a real row
      // arrives -- this case proves lookup scoping, not admissibility.
      const readiness = await client.query(
        `insert into pilot.readiness (organization_id, readiness_id, athlete_id, score, category, measured_at, method)
         values ($1, gen_random_uuid(), $2, 3, 'energy', now(), 'staff_entered_intake') returning readiness_id`,
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

  // The read-time half of the admissibility rule, against the real schema.
  // Runs the SHIPPED linkEvidence/listEvidence through the module's own pool
  // (pointed at this test's database), not a restatement of their SQL.
  test('a link whose accepted proposal is later rejected reads back annotated inadmissible -- and is never filtered', async () => {
    const client = await freshDatabase('evidence_admissibility');
    try {
      await client.query(migrationSql);
      await client.query(
        `insert into pilot.training_attempts
           (organization_id, attempt_id, athlete_id, recorded_by_account_id, context_type,
            metric_kind, direction, achieved_value)
         values ($1, 'att-adm', $2, $3, 'session', 'reps', 'at_least', 12)`,
        [ORG_ID, ATHLETE_ID, ADMIN_ID],
      );
      const proposal = await client.query(
        `insert into pilot.shadow_film_study_proposals
           (proposal_id, organization_id, athlete_id, video_session_id, observation_text,
            evidence_id, model_deployment, frames_analyzed, review_state,
            reviewed_by_account_id, reviewed_by_role, reviewed_at)
         values (gen_random_uuid(), $1, $2, 'vs-adm', 'guard drops in round 3', 'ev-adm',
                 'vision-test', 30, 'accepted', $3, 'coach', now())
         returning proposal_id::text as proposal_id`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );
      const proposalId = proposal.rows[0].proposal_id as string;

      process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor('evidence_admissibility');
      // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
      process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
      try {
        const filmLink = await linkEvidence({
          organizationId: ORG_ID,
          executionId: 'exec-1',
          evidenceRole: 'immediate_post',
          sourceKind: 'film_study',
          sourceId: proposalId,
          linkedByAccountId: COACH_ID,
        });
        expect(filmLink).not.toBeNull();
        const attemptLink = await linkEvidence({
          organizationId: ORG_ID,
          executionId: 'exec-1',
          evidenceRole: 'baseline',
          sourceKind: 'training_attempt',
          sourceId: 'att-adm',
          linkedByAccountId: COACH_ID,
        });
        expect(attemptLink).not.toBeNull();

        // While the proposal stands accepted, the link reads admissible.
        const before = await listEvidence(ORG_ID, 'exec-1');
        expect(before.find((row) => row.source_kind === 'film_study')?.source_admissible).toBe(true);

        // The coach changes the verdict: the model was wrong about this child.
        await client.query(
          `update pilot.shadow_film_study_proposals
           set review_state = 'rejected', updated_at = now()
           where organization_id = $1 and proposal_id::text = $2`,
          [ORG_ID, proposalId],
        );

        const after = await listEvidence(ORG_ID, 'exec-1');
        // Annotated, never filtered and never auto-stamped: the row is still
        // there, still active, and now says its source may not stand.
        expect(after).toHaveLength(2);
        const film = after.find((row) => row.source_kind === 'film_study');
        expect(film?.source_admissible).toBe(false);
        expect(film?.status).toBe('active');
        expect(after.find((row) => row.source_kind === 'training_attempt')?.source_admissible).toBe(true);
      } finally {
        await closePool();
      }
    } finally {
      await client.end();
    }
  });

  // The removal path's authorization depends on two statements that reading
  // SQL cannot prove: the join that says whose record a link_id belongs to,
  // and the compare-and-set that refuses to stamp a row hanging off any other
  // execution. Both run here against the real schema.
  test('a link resolves to its stored athlete, and removal refuses an execution it was not authorized against', async () => {
    const client = await freshDatabase('evidence_owner');
    try {
      await client.query(migrationSql);
      await insertLink(client, 'link-owned');

      process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor('evidence_owner');
      process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
      try {
        // The link names only itself; the athlete comes from the execution it
        // hangs off, which is the value the route authorizes against.
        const owner = await getEvidenceLinkOwner(ORG_ID, 'link-owned');
        expect(owner).toEqual({
          link_id: 'link-owned',
          execution_id: 'exec-1',
          athlete_id: ATHLETE_ID,
        });

        // A link_id from outside the organization resolves to nothing at all,
        // so the route refuses it before it can reach the gate.
        expect(await getEvidenceLinkOwner('org-somebody-else', 'link-owned')).toBeNull();

        // The compare-and-set: an execution other than the authorized one
        // stamps nothing and reports the refusal.
        expect(await removeEvidence({
          organizationId: ORG_ID,
          linkId: 'link-owned',
          removedReason: 'attempted against the wrong execution',
          expectedExecutionId: 'exec-not-this-one',
        })).toBeNull();
        const untouched = await client.query(
          `select status, removed_reason from pilot.intervention_evidence_links
           where organization_id = $1 and link_id = $2`,
          [ORG_ID, 'link-owned'],
        );
        expect(untouched.rows[0]).toEqual({ status: 'active', removed_reason: '' });

        // The authorized execution stamps the row, reason and all.
        const removed = await removeEvidence({
          organizationId: ORG_ID,
          linkId: 'link-owned',
          removedReason: 'linked the wrong attempt',
          expectedExecutionId: 'exec-1',
        });
        expect(removed?.status).toBe('removed');
        expect(removed?.removed_reason).toBe('linked the wrong attempt');
      } finally {
        await closePool();
      }
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

// Lane N3-02. The three corrections a coach can make to an intervention record
// -- revise the protocol, unlink a piece of evidence, correct the execution --
// driven through the REAL routes with the REAL access check, on a real
// database. Only the signed-in principal is supplied. Every "what the coach
// sees next" assertion is made on a fresh GET, never on a write's own reply.
describe('through the routes: revise, unlink and correct, and what the next read shows', () => {
  const mockRequirePrincipal = requirePrincipal as jest.Mock;

  const DB_NAME = 'evidence_routes';
  // pilot.athletes.deleted_at, which the real athlete-access check reads.
  const DELETION_SQL = 'pilot_slice_postgres_data_retention_deletion_migration.sql';
  // Same gym as COACH_ID, coach of record for nobody and holding no cover.
  const UNASSIGNED_COACH_ID = 'acct-evidence-coach-unassigned';
  // A coach in the other gym.
  const FOREIGN_COACH_ID = 'acct-elsewhere-coach';

  const PROTOCOLS = '/api/pilot/coach/intervention-protocols';
  const EXECUTIONS = '/api/pilot/coach/intervention-executions';
  const REVIEW = '/api/pilot/coach/intervention-review';

  const CONTENT = {
    title: 'Round three work rate',
    target_problem: 'Output falls away in the third.',
    hypothesis: 'It is conditioning.',
    intervention_description: 'Constrained live rounds with an output floor.',
    expected_outcome: 'Third-round output holds within ten percent of the first.',
  };

  interface ProtocolItem {
    protocol_id: string;
    lineage_id: string;
    version: number;
    status: string;
    athlete_id: string | null;
    hypothesis: string;
    intended_exposure: Record<string, number>;
  }
  interface ExecutionItem {
    execution_id: string;
    lineage_id: string;
    version: number;
    status: string;
    adherence: string;
    actual_exposure: Record<string, number>;
    correction_reason: string;
  }
  interface LinkItem {
    link_id: string;
    status: string;
    removed_reason: string;
    source_id: string;
  }
  interface ReviewItem {
    review_id: string;
    supersedes_review_id: string | null;
    performance_notes: string;
  }
  interface ChainItem {
    execution: ExecutionItem;
    evidence: LinkItem[];
    review: ReviewItem | null;
  }

  let db: Client;
  let protocolsRoute: typeof import('@/app/api/pilot/coach/intervention-protocols/route');
  let executionsRoute: typeof import('@/app/api/pilot/coach/intervention-executions/route');
  let reviewRoute: typeof import('@/app/api/pilot/coach/intervention-review/route');

  beforeAll(async () => {
    db = await freshDatabase(DB_NAME);
    await db.query(migrationSql);
    await db.query(await fs.readFile(path.join(INFRA_DIR, DELETION_SQL), 'utf8'));
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft'), ($3, 'coach', $4, 'microsoft')`,
      [UNASSIGNED_COACH_ID, ORG_ID, FOREIGN_COACH_ID, OTHER_ORG_ID],
    );
    // The independent evidence records: two attempts the athlete really made.
    for (const attemptId of ['att-r1', 'att-r2']) {
      await db.query(
        `insert into pilot.training_attempts
           (organization_id, attempt_id, athlete_id, recorded_by_account_id, context_type,
            metric_kind, direction, achieved_value)
         values ($1, $2, $3, $4, 'session', 'reps', 'at_least', 12)`,
        [ORG_ID, attemptId, ATHLETE_ID, COACH_ID],
      );
    }
    // What the refusal cases aim at: an athlete-specific protocol, and a link
    // and a review on the seeded execution 'exec-1'.
    await db.query(
      `insert into pilot.intervention_protocols
         (organization_id, protocol_id, lineage_id, version, athlete_id, title, target_problem,
          hypothesis, intervention_description, expected_outcome, created_by_account_id)
       values ($1, 'proto-guard', 'proto-guard', 1, $2, 'Guard recovery', 'guard drops when tired',
               'it is a habit, not fatigue', 'cue on every exit', 'guard returns unprompted', $3)`,
      [ORG_ID, ATHLETE_ID, COACH_ID],
    );
    await insertLink(db, 'link-guard', { source_id: 'att-r1' });
    await insertReview(db, 'rev-guard');

    process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(DB_NAME);
    // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
    process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

    protocolsRoute = await import('@/app/api/pilot/coach/intervention-protocols/route');
    executionsRoute = await import('@/app/api/pilot/coach/intervention-executions/route');
    reviewRoute = await import('@/app/api/pilot/coach/intervention-review/route');
  });

  afterAll(async () => {
    await closePool();
    await db.end();
  });

  function signInAs(accountId: string, organizationId: string): void {
    const principal: PilotPrincipal = {
      accountId,
      role: 'coach',
      organizationId,
      athleteId: null,
      sessionToken: `token-${accountId}`,
      authProvider: 'microsoft',
    };
    mockRequirePrincipal.mockResolvedValue(principal);
  }

  const get = (pathname: string) => new NextRequest(`http://localhost${pathname}`);
  const send = (method: 'POST' | 'PATCH', pathname: string, body: unknown) =>
    new NextRequest(`http://localhost${pathname}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function item<T>(response: Response): Promise<T> {
    expect(response.status).toBe(200);
    return ((await response.json()) as { item: T }).item;
  }

  /** The review screen's list, read fresh, narrowed to one execution. */
  async function chainFor(executionId: string): Promise<ChainItem | undefined> {
    const response = await reviewRoute.GET(get(REVIEW));
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: ChainItem[] };
    return items.find((entry) => entry.execution.execution_id === executionId);
  }

  async function stored(table: string, key: string, id: string): Promise<Record<string, unknown>> {
    const result = await db.query(
      `select * from pilot.${table} where organization_id = $1 and ${key} = $2`,
      [ORG_ID, id],
    );
    return result.rows[0] as Record<string, unknown>;
  }

  /** Every row a refused write could have touched, and every audit row. */
  async function ledger(): Promise<string> {
    const rows: Record<string, unknown[]> = {};
    for (const table of [
      'intervention_protocols', 'intervention_executions', 'intervention_evidence_links',
      'intervention_outcome_reviews', 'training_attempts', 'audit_events',
    ]) {
      rows[table] = (await db.query(`select * from pilot.${table} order by 1, 2`)).rows;
    }
    return JSON.stringify(rows);
  }

  const link = (executionId: string, sourceId: string, evidenceRole: string) =>
    reviewRoute.POST(send('POST', REVIEW, {
      action: 'link_evidence',
      execution_id: executionId,
      evidence_role: evidenceRole,
      source_kind: 'training_attempt',
      source_id: sourceId,
    }));

  const reviewOutcome = (executionId: string, performanceNotes: string) =>
    reviewRoute.POST(send('POST', REVIEW, {
      action: 'review_outcome',
      execution_id: executionId,
      performance_result: 'improved',
      performance_notes: performanceNotes,
      hypothesis_result: 'supported',
      learning_signal: 'prior_belief_strengthened',
    }));

  test('the assigned coach revises the protocol, unlinks evidence and corrects the record, and nothing is lost on the way', async () => {
    signInAs(COACH_ID, ORG_ID);

    // REVISE. A protocol is filed for this athlete, then re-stated.
    const v1 = await item<ProtocolItem>(await protocolsRoute.POST(send('POST', PROTOCOLS, {
      ...CONTENT, athlete_id: ATHLETE_ID, intended_exposure: { rounds: 6 },
    })));
    // Each write below is sent in the shape its screen sends it: every field
    // the form shows, the optional ones as empty strings.
    const v2 = await item<ProtocolItem>(await protocolsRoute.PATCH(send('PATCH', PROTOCOLS, {
      action: 'revise',
      protocol_id: v1.protocol_id,
      ...CONTENT,
      hypothesis: 'It is pacing, not conditioning.',
      intended_task_context: '',
      contradicting_evidence: '',
      alternative_explanations: '',
      evaluation_plan: '',
      intended_exposure: { rounds: 4 },
    })));
    expect(v2).toMatchObject({
      version: 2, lineage_id: v1.lineage_id, athlete_id: ATHLETE_ID, status: 'active',
      hypothesis: 'It is pacing, not conditioning.', intended_exposure: { rounds: 4 },
    });

    // The next read lists the revision and not the version it replaced...
    const protocolList = await protocolsRoute.GET(get(PROTOCOLS));
    expect(protocolList.status).toBe(200);
    const listedIds = ((await protocolList.json()) as { items: ProtocolItem[] }).items.map((p) => p.protocol_id);
    expect(listedIds).toContain(v2.protocol_id);
    expect(listedIds).not.toContain(v1.protocol_id);
    // ...which stays on record exactly as it was stated.
    expect(await stored('intervention_protocols', 'protocol_id', v1.protocol_id)).toMatchObject({
      status: 'superseded', version: 1, hypothesis: 'It is conditioning.', intended_exposure: { rounds: 6 },
    });

    // The work: started against the revision, then closed out.
    const original = await item<ExecutionItem>(await executionsRoute.POST(send('POST', EXECUTIONS, {
      athlete_id: ATHLETE_ID, protocol_id: v2.protocol_id, actual_start: '2026-09-01T22:00:00Z',
    })));
    await item<ExecutionItem>(await executionsRoute.PATCH(send('PATCH', EXECUTIONS, {
      action: 'close',
      execution_id: original.execution_id,
      outcome: 'completed',
      adherence: 'delivered_as_planned',
      trained_context: 'controlled',
      actual_exposure: { rounds: 6 },
    })));

    // Two attempts linked as evidence, and the coach's review of the outcome.
    const first = await item<LinkItem>(await link(original.execution_id, 'att-r1', 'baseline'));
    const second = await item<LinkItem>(await link(original.execution_id, 'att-r2', 'immediate_post'));
    const reviewed = await item<ReviewItem>(await reviewOutcome(original.execution_id, 'held output through the third'));

    // UNLINK. The association is struck; the attempt it pointed at is not.
    const attemptBefore = await stored('training_attempts', 'attempt_id', 'att-r2');
    const unlinked = await item<LinkItem>(await reviewRoute.PATCH(send('PATCH', REVIEW, {
      action: 'remove_evidence', link_id: second.link_id, removed_reason: 'that attempt was a different drill',
    })));
    expect(unlinked).toMatchObject({ status: 'removed', removed_reason: 'that attempt was a different drill' });
    expect(await stored('training_attempts', 'attempt_id', 'att-r2')).toEqual(attemptBefore);

    const afterUnlink = await chainFor(original.execution_id);
    expect(afterUnlink?.evidence.map((entry) => [entry.source_id, entry.status, entry.removed_reason])).toEqual([
      ['att-r1', 'active', ''],
      ['att-r2', 'removed', 'that attempt was a different drill'],
    ]);

    // A link already removed cannot be removed again, and stays as stamped.
    const again = await reviewRoute.PATCH(send('PATCH', REVIEW, {
      action: 'remove_evidence', link_id: second.link_id, removed_reason: 'a second reason',
    }));
    expect(again.status).toBe(404);
    expect(await stored('intervention_evidence_links', 'link_id', second.link_id))
      .toMatchObject({ status: 'removed', removed_reason: 'that attempt was a different drill' });

    // CORRECT. Six rounds were logged; it was four.
    const current = await item<ExecutionItem>(await executionsRoute.PATCH(send('PATCH', EXECUTIONS, {
      action: 'correct',
      execution_id: original.execution_id,
      correction_reason: 'logged six rounds; it was four',
      outcome: 'completed',
      adherence: 'under_delivered',
      trained_context: 'controlled',
      deviations: '',
      stop_change_reason: '',
      notes: '',
      actual_exposure: { rounds: 4 },
    })));
    expect(current).toMatchObject({
      version: 2, lineage_id: original.lineage_id, status: 'completed',
      adherence: 'under_delivered', actual_exposure: { rounds: 4 },
      correction_reason: 'logged six rounds; it was four',
    });
    expect(current.execution_id).not.toBe(original.execution_id);

    // The review screen now shows the corrected record -- WITH the evidence
    // and the review that were attached before the correction.
    const afterCorrection = await chainFor(current.execution_id);
    expect(afterCorrection?.execution).toMatchObject({ version: 2, adherence: 'under_delivered' });
    expect(afterCorrection?.evidence.map((entry) => [entry.link_id, entry.status])).toEqual([
      [first.link_id, 'active'],
      [second.link_id, 'removed'],
    ]);
    expect(afterCorrection?.review).toMatchObject({
      review_id: reviewed.review_id, performance_notes: 'held output through the third',
    });
    // The version it replaced is not listed, and is intact as history.
    expect(await chainFor(original.execution_id)).toBeUndefined();
    expect(await stored('intervention_executions', 'execution_id', original.execution_id)).toMatchObject({
      status: 'superseded', version: 1, adherence: 'delivered_as_planned', actual_exposure: { rounds: 6 },
    });

    // The corrected record is a working record. A re-review supersedes the
    // verdict that was carried over rather than standing beside it...
    const reReviewed = await item<ReviewItem>(await reviewOutcome(current.execution_id, 'held output, on four rounds'));
    expect(reReviewed.supersedes_review_id).toBe(reviewed.review_id);
    const activeReviews = await db.query(
      `select r.review_id from pilot.intervention_outcome_reviews r
       join pilot.intervention_executions e
         on e.organization_id = r.organization_id and e.execution_id = r.execution_id
       where r.organization_id = $1 and e.lineage_id = $2 and r.status = 'active'`,
      [ORG_ID, original.lineage_id],
    );
    expect(activeReviews.rows).toEqual([{ review_id: reReviewed.review_id }]);
    // ...and evidence that came across can still be unlinked.
    await item<LinkItem>(await reviewRoute.PATCH(send('PATCH', REVIEW, {
      action: 'remove_evidence', link_id: first.link_id, removed_reason: 'baseline was taken on the wrong day',
    })));
    const final = await chainFor(current.execution_id);
    expect(final?.evidence.map((entry) => entry.status)).toEqual(['removed', 'removed']);
    expect(final?.review?.review_id).toBe(reReviewed.review_id);

    // The verdict stands on finished work, so the work cannot be flipped back
    // to in progress underneath it. Refused whole, with the reason.
    const beforeReopen = await ledger();
    const reopen = await executionsRoute.PATCH(send('PATCH', EXECUTIONS, {
      action: 'correct',
      execution_id: current.execution_id,
      correction_reason: 'it had not actually finished',
      outcome: 'in_progress',
    }));
    expect(reopen.status).toBe(409);
    expect(((await reopen.json()) as { error: string }).error).toMatch(/outcome review/);
    expect(await ledger()).toBe(beforeReopen);
    expect((await chainFor(current.execution_id))?.execution.status).toBe('completed');

    // Both attempts are still there.
    const attempts = await db.query(
      `select attempt_id from pilot.training_attempts where organization_id = $1 order by attempt_id`,
      [ORG_ID],
    );
    expect(attempts.rows.map((row) => row.attempt_id)).toEqual(['att-r1', 'att-r2']);
  });

  describe('a coach who is not this athlete\'s coach', () => {
    /** Revise, correct and unlink, each aimed at this athlete's records. */
    async function tryEachCorrection(
      targets: { protocolId: string; executionId: string; linkId: string } =
        { protocolId: 'proto-guard', executionId: 'exec-1', linkId: 'link-guard' },
    ): Promise<Response[]> {
      return [
        await protocolsRoute.PATCH(send('PATCH', PROTOCOLS, {
          action: 'revise', protocol_id: targets.protocolId, ...CONTENT,
        })),
        await executionsRoute.PATCH(send('PATCH', EXECUTIONS, {
          action: 'correct', execution_id: targets.executionId, correction_reason: 'not my athlete, my gym',
          adherence: 'not_delivered',
        })),
        await reviewRoute.PATCH(send('PATCH', REVIEW, {
          action: 'remove_evidence', link_id: targets.linkId, removed_reason: 'not my athlete, my gym',
        })),
      ];
    }

    /** The live version of each lineage the three corrections aim at. */
    async function currentTargets(): Promise<{ protocolId: string; executionId: string }> {
      const protocol = await db.query(
        `select protocol_id from pilot.intervention_protocols
         where organization_id = $1 and lineage_id = 'proto-guard' and status <> 'superseded'`,
        [ORG_ID],
      );
      const execution = await db.query(
        `select e.execution_id from pilot.intervention_executions e
         join pilot.intervention_executions first
           on first.organization_id = e.organization_id and first.lineage_id = e.lineage_id
         where e.organization_id = $1 and first.execution_id = 'exec-1' and e.status <> 'superseded'`,
        [ORG_ID],
      );
      expect(protocol.rows).toHaveLength(1);
      expect(execution.rows).toHaveLength(1);
      return { protocolId: protocol.rows[0].protocol_id, executionId: execution.rows[0].execution_id };
    }

    async function expectNothingReturned(refusals: Response[]): Promise<void> {
      for (const response of refusals) {
        expect((await response.json()) as Record<string, unknown>).not.toHaveProperty('item');
      }
    }

    // Issue #1480 (Jason, 2026-10-12): a coach's reach is the whole gym.
    test('in the same gym: allowed on all three, and the records really change', async () => {
      signInAs(UNASSIGNED_COACH_ID, ORG_ID);

      const allowed = await tryEachCorrection();

      expect(allowed.map((response) => response.status)).toEqual([200, 200, 200]);
      expect(await stored('intervention_protocols', 'protocol_id', 'proto-guard'))
        .toMatchObject({ status: 'superseded', version: 1 });
      expect(await stored('intervention_executions', 'execution_id', 'exec-1'))
        .toMatchObject({ status: 'superseded' });
      expect(await stored('intervention_evidence_links', 'link_id', 'link-guard'))
        .toMatchObject({ status: 'removed', removed_reason: 'not my athlete, my gym' });
      const current = await currentTargets();
      expect(await stored('intervention_protocols', 'protocol_id', current.protocolId))
        .toMatchObject({ version: 2, created_by_account_id: UNASSIGNED_COACH_ID });
      expect(await stored('intervention_executions', 'execution_id', current.executionId))
        .toMatchObject({ correction_reason: 'not my athlete, my gym', adherence: 'not_delivered' });
    });

    test('in another gym: the records do not exist, and nothing is written', async () => {
      const before = await ledger();
      signInAs(FOREIGN_COACH_ID, OTHER_ORG_ID);

      const refusals = await tryEachCorrection();

      expect(refusals.map((response) => response.status)).toEqual([404, 404, 404]);
      await expectNothingReturned(refusals);
      expect(await ledger()).toBe(before);
    });

    // Issue #1480 (Jason, 2026-10-12): a coach's reach is the whole gym. The
    // gym coach above already moved the seeded records on, so the assigned
    // coach aims at the live versions and a fresh link.
    test('the assigned coach is not refused the same three', async () => {
      await insertLink(db, 'link-guard-2', { source_id: 'att-r2', evidence_role: 'baseline' });
      const current = await currentTargets();
      signInAs(COACH_ID, ORG_ID);

      const allowed = await tryEachCorrection({ ...current, linkId: 'link-guard-2' });

      expect(allowed.map((response) => response.status)).toEqual([200, 200, 200]);
    });
  });
});
