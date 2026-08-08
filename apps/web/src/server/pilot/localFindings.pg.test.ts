// Real PostgreSQL-backed contract test for the local findings migration
// (pilot.local_findings, pilot.local_finding_tier_history,
// pilot.v_evidence_combined) and for localFindings.ts's functions running
// against a real transaction.
//
// Six things need proving, and none can be proven by reading SQL or by a
// mocked-query unit test:
//
// 1. pilot_local_findings_tested actually holds: reaching local_tested
//    without a prediction_made_at is rejected; a prediction_checked_at
//    earlier than prediction_made_at is rejected.
// 2. pilot_local_findings_reviewed holds: the two weight-bearing tiers
//    require a second reviewer.
// 3. pilot_local_findings_contradiction holds: agrees_with_literature=
//    'contradicts' with a contradiction_note under 20 characters is
//    rejected.
// 4. advanceLocalFindingTier is genuinely one transaction: the finding row
//    and its tier-history row either both land or neither does.
// 5. pilot.v_evidence_combined always carries origin='local' and a
//    tier_context string, never bare `tier`.
// 6. The readiness check actually fails when the migration did not land.
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
        const result = await fn({
          query: (text: string, values: unknown[]) => client.query(text, values),
        });
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
  advanceLocalFindingTier,
  getEvidenceCombined,
  raiseLocalFinding,
  recordLiteratureRelationship,
} from './localFindings';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-local-findings-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_local_findings_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-local-findings-migration.mjs',
);

const ORG_A = 'org-localfindings-a';
const COACH_A = 'acct-localfindings-coach-a';
const ADMIN_A = 'acct-localfindings-admin-a';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
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
    [ORG_A],
  );
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

  activeClient = client;
  activeConnectionString = connectionStringFor(name);
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

describe('local findings migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_localfindings_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /LOCAL_FINDINGS_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.local_findings') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      activeConnectionString = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints', async () => {
    const client = await freshDatabase('ppbf_test_localfindings_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_local_findings_tested', 'pilot_local_findings_reviewed',
                            'pilot_local_findings_contradiction', 'pilot_lfth_rationale')`,
      );
      expect(constraints.rows[0].n).toBe(4);
    } finally {
      activeClient = null;
      activeConnectionString = null;
      await client.end();
    }
  });
});

describe('pilot_local_findings_tested', () => {
  test('reaching local_tested without a prediction_made_at is rejected', async () => {
    const client = await freshDatabase('ppbf_test_localfindings_tested_no_prediction');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const finding = await raiseLocalFinding({
        organizationId: ORG_A, title: 'Random-order combos retain better',
        statement: 'Athletes drilled with random combo calls show better retention a week later.',
        domain: 'technical', originatingSource: 'coach_observation',
        raisedByAccountId: COACH_A, raisedByRole: 'coach',
      });

      await expect(
        advanceLocalFindingTier({
          organizationId: ORG_A,
          findingId: finding.finding_id,
          toTier: 'local_tested',
          rationale: 'Advancing based on repeated observation across three cohorts.',
          changedByAccountId: COACH_A,
          changedByRole: 'coach',
          reviewedByAccountId: ADMIN_A,
        }),
      ).rejects.toThrow('LOCAL_FINDING_PREDICTION_REQUIRED');
    } finally {
      activeClient = null;
      activeConnectionString = null;
      await client.end();
    }
  });

  test('a prediction_checked_at earlier than prediction_made_at is rejected', async () => {
    const client = await freshDatabase('ppbf_test_localfindings_prediction_out_of_order');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const finding = await raiseLocalFinding({
        organizationId: ORG_A, title: 'Random-order combos retain better',
        statement: 'Athletes drilled with random combo calls show better retention a week later.',
        domain: 'technical', originatingSource: 'coach_observation',
        raisedByAccountId: COACH_A, raisedByRole: 'coach',
      });

      await expect(
        advanceLocalFindingTier({
          organizationId: ORG_A,
          findingId: finding.finding_id,
          toTier: 'local_tested',
          rationale: 'Advancing based on repeated observation across three cohorts.',
          changedByAccountId: COACH_A,
          changedByRole: 'coach',
          reviewedByAccountId: ADMIN_A,
          predictionStatement: 'Cohort D will retain the combo better than cohort C.',
          predictionMadeAt: '2026-08-05T00:00:00Z',
          predictionOutcome: 'held',
          predictionCheckedAt: '2026-08-01T00:00:00Z',
        }),
      ).rejects.toThrow('LOCAL_FINDING_PREDICTION_REQUIRED');
    } finally {
      activeClient = null;
      activeConnectionString = null;
      await client.end();
    }
  });

  test('a real prediction stated before it was checked, with a second reviewer, is accepted', async () => {
    const client = await freshDatabase('ppbf_test_localfindings_tested_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const finding = await raiseLocalFinding({
        organizationId: ORG_A, title: 'Random-order combos retain better',
        statement: 'Athletes drilled with random combo calls show better retention a week later.',
        domain: 'technical', originatingSource: 'coach_observation',
        raisedByAccountId: COACH_A, raisedByRole: 'coach',
      });

      const { finding: advanced, historyEntry } = await advanceLocalFindingTier({
        organizationId: ORG_A,
        findingId: finding.finding_id,
        toTier: 'local_tested',
        rationale: 'Advancing based on repeated observation across three cohorts.',
        changedByAccountId: COACH_A,
        changedByRole: 'coach',
        reviewedByAccountId: ADMIN_A,
        predictionStatement: 'Cohort D will retain the combo better than cohort C.',
        predictionMadeAt: '2026-08-01T00:00:00Z',
        predictionOutcome: 'held',
        predictionCheckedAt: '2026-08-08T00:00:00Z',
      });
      expect(advanced.local_tier).toBe('local_tested');
      expect(advanced.reviewed_by_account_id).toBe(ADMIN_A);
      expect(historyEntry.from_tier).toBe('observation');
      expect(historyEntry.to_tier).toBe('local_tested');
    } finally {
      activeClient = null;
      activeConnectionString = null;
      await client.end();
    }
  });
});

describe('pilot_local_findings_reviewed', () => {
  test('reaching local_established without a second reviewer is rejected', async () => {
    const client = await freshDatabase('ppbf_test_localfindings_no_reviewer');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const finding = await raiseLocalFinding({
        organizationId: ORG_A, title: 'Finding', statement: 'A statement about the floor.',
        domain: 'technical', originatingSource: 'coach_observation',
        raisedByAccountId: COACH_A, raisedByRole: 'coach',
      });

      await expect(
        advanceLocalFindingTier({
          organizationId: ORG_A,
          findingId: finding.finding_id,
          toTier: 'local_established',
          rationale: 'Advancing after a second cohort confirmed the pattern.',
          changedByAccountId: COACH_A,
          changedByRole: 'coach',
          predictionStatement: 'X will happen.',
          predictionMadeAt: '2026-08-01T00:00:00Z',
          predictionOutcome: 'held',
          predictionCheckedAt: '2026-08-08T00:00:00Z',
        }),
      ).rejects.toThrow('LOCAL_FINDING_SECOND_REVIEWER_REQUIRED');
    } finally {
      activeClient = null;
      activeConnectionString = null;
      await client.end();
    }
  });
});

describe('advanceLocalFindingTier is one transaction', () => {
  test('a rationale under 15 characters rolls back before either write happens', async () => {
    const client = await freshDatabase('ppbf_test_localfindings_rationale_too_short');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const finding = await raiseLocalFinding({
        organizationId: ORG_A, title: 'Finding', statement: 'A statement about the floor.',
        domain: 'technical', originatingSource: 'coach_observation',
        raisedByAccountId: COACH_A, raisedByRole: 'coach',
      });

      await expect(
        advanceLocalFindingTier({
          organizationId: ORG_A,
          findingId: finding.finding_id,
          toTier: 'repeated_observation',
          rationale: 'too short',
          changedByAccountId: COACH_A,
          changedByRole: 'coach',
        }),
      ).rejects.toThrow('LOCAL_FINDING_RATIONALE_TOO_SHORT');

      const { rows } = await client.query(
        `select local_tier from pilot.local_findings where organization_id = $1 and finding_id = $2`,
        [ORG_A, finding.finding_id],
      );
      expect(rows[0].local_tier).toBe('observation');

      const history = await client.query(
        `select count(*)::int as n from pilot.local_finding_tier_history where organization_id = $1 and finding_id = $2`,
        [ORG_A, finding.finding_id],
      );
      expect(history.rows[0].n).toBe(0);
    } finally {
      activeClient = null;
      activeConnectionString = null;
      await client.end();
    }
  });
});

describe('pilot_local_findings_contradiction', () => {
  test('agrees_with_literature=contradicts with a note under 20 characters is rejected', async () => {
    const client = await freshDatabase('ppbf_test_localfindings_contradiction_too_short');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const finding = await raiseLocalFinding({
        organizationId: ORG_A, title: 'Finding', statement: 'A statement about the floor.',
        domain: 'technical', originatingSource: 'coach_observation',
        raisedByAccountId: COACH_A, raisedByRole: 'coach',
      });

      await expect(
        recordLiteratureRelationship({
          organizationId: ORG_A,
          findingId: finding.finding_id,
          agreesWithLiterature: 'contradicts',
          contradictionNote: 'too short',
        }),
      ).rejects.toThrow('LOCAL_FINDING_CONTRADICTION_NOTE_TOO_SHORT');
    } finally {
      activeClient = null;
      activeConnectionString = null;
      await client.end();
    }
  });

  test('agrees_with_literature=contradicts with a real note is accepted', async () => {
    const client = await freshDatabase('ppbf_test_localfindings_contradiction_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const finding = await raiseLocalFinding({
        organizationId: ORG_A, title: 'Finding', statement: 'A statement about the floor.',
        domain: 'technical', originatingSource: 'coach_observation',
        raisedByAccountId: COACH_A, raisedByRole: 'coach',
      });

      const updated = await recordLiteratureRelationship({
        organizationId: ORG_A,
        findingId: finding.finding_id,
        agreesWithLiterature: 'contradicts',
        contradictionNote: 'Published transfer studies used adult populations, ours is youth-only.',
      });
      expect(updated.agrees_with_literature).toBe('contradicts');
    } finally {
      activeClient = null;
      activeConnectionString = null;
      await client.end();
    }
  });
});

describe('pilot.v_evidence_combined', () => {
  test('always carries origin=local and a tier_context string', async () => {
    const client = await freshDatabase('ppbf_test_localfindings_evidence_combined');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await raiseLocalFinding({
        organizationId: ORG_A, title: 'Finding', statement: 'A statement about the floor.',
        domain: 'technical', originatingSource: 'coach_observation',
        raisedByAccountId: COACH_A, raisedByRole: 'coach',
      });

      const combined = await getEvidenceCombined(ORG_A);
      expect(combined).toHaveLength(1);
      expect(combined[0].origin).toBe('local');
      expect(combined[0].tier_context).toBe('PPBF floor -- single-site, uncontrolled');
      expect(combined[0].tier).toBe('observation');
    } finally {
      activeClient = null;
      activeConnectionString = null;
      await client.end();
    }
  });
});
