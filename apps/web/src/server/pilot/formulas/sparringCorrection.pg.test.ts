// Real PostgreSQL proof for "Fix a number" on the sparring page (lane L50).
//
// WHAT IT PROVES. A sparring entry's punch numbers flow into MVP-03 (accuracy)
// and MVP-04 (connect differential) the way a normal coaching action produces
// them -- observations stored, the context auto-calculated -- and a correction
// of TWO numbers of one entry, one after the other, ends with the coach reader
// showing values computed from both corrected numbers.
//
// THE DEFECT IT PINS. findFormulaResultsUsingObservation returned every result
// an observation ever fed, including one an earlier correction had already
// replaced. The second fix then re-ran that stale result with an id that was
// already superseded, getActiveFormulaObservationsByIds refused it, and the
// route answered 404 for a fix it had already stored. Both claims live in SQL
// predicates, so they are measured against Postgres rather than a mock.
//
// Spins up the same disposable, local-only embedded Postgres the other suites
// use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

import type { ObservationKind } from './types';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-sparring-correction-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../../scripts/test-embedded-pg-server.mjs');
const BASE_SQL_PATH = path.resolve(__dirname, '../../../../../../infra/azure/pilot_slice_postgres.sql');
const TEST_DB_NAME = 'ppbf_test_sparring_correction';

const ORG_ID = 'org-sparring-fix';
const OTHER_ORG_ID = 'org-sparring-fix-elsewhere';
const ACCOUNT_ID = 'acct-sparring-fix-athlete';
const ATHLETE_ID = 'ATH-FIX-1';
const OTHER_ATHLETE_ID = 'ATH-FIX-2';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let repository: typeof import('./repository');
let runner: typeof import('./runner');
let autoCalculation: typeof import('./autoCalculation');

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

async function seed(client: Client): Promise<void> {
  for (const organizationId of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'athlete', $2, 'microsoft') on conflict do nothing`,
    [ACCOUNT_ID, ORG_ID],
  );
  for (const [organizationId, athleteId] of [
    [ORG_ID, ATHLETE_ID],
    [ORG_ID, OTHER_ATHLETE_ID],
    [OTHER_ORG_ID, ATHLETE_ID],
  ]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
                                   emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $2, '2011-05-06', 'fly', 'active', 'contact', true, null, now(), now())
       on conflict do nothing`,
      [organizationId, athleteId],
    );
  }
}

async function truncateAll(): Promise<void> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  try {
    await client.query('truncate pilot.shadow_formula_results, pilot.shadow_formula_observations');
  } finally {
    await client.end();
  }
}

/** One observation as the sparring page posts it. */
async function observe(input: {
  contextId: string;
  kind: ObservationKind;
  value: number;
  observedAt: string;
  dimensions?: Record<string, string>;
  organizationId?: string;
  athleteId?: string;
  supersedes?: string;
}) {
  const idempotencyKey = input.supersedes
    ? `${input.contextId}-${input.kind}-fix-${input.supersedes}`
    : `${input.contextId}-${input.kind}`;
  return repository.saveFormulaObservation({
    organizationId: input.organizationId ?? ORG_ID,
    athleteId: input.athleteId ?? ATHLETE_ID,
    contextId: input.contextId,
    kind: input.kind,
    value: input.value,
    unit: 'count',
    dimensions: input.dimensions ?? {},
    observedAt: input.observedAt,
    source: { type: 'manual', quality: 'moderate', referenceId: `ref-${idempotencyKey}` },
    idempotencyKey,
    supersedesObservationId: input.supersedes ?? null,
    createdByAccountId: input.organizationId && input.organizationId !== ORG_ID ? null : ACCOUNT_ID,
  });
}

/** What the observations route does after storing a correction. */
async function correct(original: { observationId: string; kind: ObservationKind; contextId: string; observedAt: string; dimensions?: unknown }, value: number) {
  const replacement = await observe({
    contextId: original.contextId,
    kind: original.kind,
    value,
    observedAt: original.observedAt,
    dimensions: (original.dimensions ?? {}) as Record<string, string>,
    supersedes: original.observationId,
  });
  return runner.recalculateForSupersededObservation({
    organizationId: ORG_ID,
    athleteId: ATHLETE_ID,
    supersededObservationId: original.observationId,
    replacementObservationId: replacement.observationId,
  });
}

async function logEntry(contextId: string, observedAt: string, numbers: { thrown: number; landed: number; taken: number }) {
  const thrown = await observe({ contextId, kind: 'punch_attempted', value: numbers.thrown, observedAt, dimensions: { punchType: 'Jab' } });
  const landed = await observe({ contextId, kind: 'punch_landed', value: numbers.landed, observedAt, dimensions: { punchType: 'Jab' } });
  const taken = await observe({ contextId, kind: 'punch_absorbed', value: numbers.taken, observedAt, dimensions: { opponentStance: 'Orthodox' } });
  await autoCalculation.autoCalculateForObservationContext({ organizationId: ORG_ID, athleteId: ATHLETE_ID, contextId });
  return { thrown, landed, taken };
}

async function latestValues(): Promise<Record<string, number | null>> {
  const results = await repository.listLatestFormulaResultsPerOutput({ organizationId: ORG_ID, athleteId: ATHLETE_ID });
  return Object.fromEntries(results.map((result) => [`${result.formulaId}:${result.outputKey}`, result.value]));
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  await migrateClient.query(await fs.readFile(BASE_SQL_PATH, 'utf8'));
  await seed(migrateClient);
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it).
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  repository = await import('./repository');
  runner = await import('./runner');
  autoCalculation = await import('./autoCalculation');
});

afterAll(async () => {
  const { closePool } = await import('../db');
  await closePool();
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
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

beforeEach(truncateAll);

describe('fixing two numbers of one sparring entry', () => {
  test('logging an entry calculates accuracy and connect differential with no ids chosen by anyone', async () => {
    await logEntry('sparring_1000', '2026-10-17T15:00:00.000Z', { thrown: 10, landed: 5, taken: 3 });
    expect(await latestValues()).toEqual({
      'MVP-03:accuracy_jab': 50,
      'MVP-04:value': 2,
    });
  });

  test('the second fix re-runs only current results and the reader shows both corrections', async () => {
    const entry = await logEntry('sparring_1000', '2026-10-17T15:00:00.000Z', { thrown: 10, landed: 5, taken: 3 });

    const afterLanded = await correct(entry.landed, 4);
    expect(afterLanded.map((result) => result.formulaId).sort()).toEqual(['MVP-03', 'MVP-04']);

    // On main this throws OBSERVATION_NOT_FOUND: the ORIGINAL MVP-03 result
    // still lists the landed observation the first fix replaced.
    const afterThrown = await correct(entry.thrown, 8);
    expect(afterThrown.map((result) => result.formulaId)).toEqual(['MVP-03']);

    expect(await latestValues()).toEqual({
      'MVP-03:accuracy_jab': 50,
      'MVP-04:value': 1,
    });
    const accuracy = (await repository.listLatestFormulaResultsPerOutput({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      formulaId: 'MVP-03',
    }))[0];
    // 4 of 8, not the original 5 of 10 that also reads 50: the inputs prove it.
    const inputs = await repository.getActiveFormulaObservationsByIds({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      observationIds: accuracy.inputObservationIds,
    });
    expect(inputs.map((observation) => [observation.kind, observation.value]).sort()).toEqual([
      ['punch_attempted', 8],
      ['punch_landed', 4],
    ]);
  });
});

describe('listRecentSparringEntries', () => {
  test('newest first, punch numbers only, current values only, this athlete and gym only', async () => {
    const older = await logEntry('sparring_1000', '2026-10-15T15:00:00.000Z', { thrown: 10, landed: 5, taken: 3 });
    await logEntry('sparring_2000', '2026-10-17T15:00:00.000Z', { thrown: 20, landed: 6, taken: 1 });
    await correct(older.taken, 4);
    // Same context, but not a punch number: never leaves the database here.
    await repository.saveFormulaObservation({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      contextId: 'sparring_2000',
      kind: 'body_weight',
      value: 60,
      unit: 'kilograms',
      observedAt: '2026-10-17T15:00:00.000Z',
      source: { type: 'manual', quality: 'moderate', referenceId: 'ref-weight' },
      idempotencyKey: 'sparring_2000-body_weight',
      createdByAccountId: ACCOUNT_ID,
    });
    // A check-in context: not a sparring-page entry.
    await observe({ contextId: 'check-in:abc', kind: 'punch_landed', value: 1, observedAt: '2026-10-17T16:00:00.000Z' });
    // A context whose name only LOOKS like the prefix under LIKE ('_' matches any character).
    await observe({ contextId: 'sparringX3000', kind: 'punch_landed', value: 1, observedAt: '2026-10-17T16:00:00.000Z' });
    // Someone else, and the same athlete id in another gym.
    await observe({ contextId: 'sparring_4000', kind: 'punch_landed', value: 9, observedAt: '2026-10-17T17:00:00.000Z', athleteId: OTHER_ATHLETE_ID });
    await observe({ contextId: 'sparring_5000', kind: 'punch_landed', value: 9, observedAt: '2026-10-17T17:00:00.000Z', organizationId: OTHER_ORG_ID });

    const entries = await repository.listRecentSparringEntries({ organizationId: ORG_ID, athleteId: ATHLETE_ID });

    expect(entries.map((entry) => entry.contextId)).toEqual(['sparring_2000', 'sparring_1000']);
    expect(entries.map((entry) => entry.observations.map((observation) => [observation.kind, observation.value]))).toEqual([
      [['punch_absorbed', 1], ['punch_attempted', 20], ['punch_landed', 6]],
      [['punch_absorbed', 4], ['punch_attempted', 10], ['punch_landed', 5]],
    ]);
    expect(await repository.listRecentSparringEntries({ organizationId: ORG_ID, athleteId: ATHLETE_ID, limit: 1 }))
      .toHaveLength(1);
  });
});
