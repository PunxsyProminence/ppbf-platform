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

import { SESSION_TOTAL_DIMENSIONS, type FormulaResult, type ObservationKind } from './formulas/types';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-sparring-correction-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const BASE_SQL_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');
const TEST_DB_NAME = 'ppbf_test_sparring_correction';

const ORG_ID = 'org-sparring-fix';
const OTHER_ORG_ID = 'org-sparring-fix-elsewhere';
const ACCOUNT_ID = 'acct-sparring-fix-athlete';
const COACH_ID = 'acct-sparring-fix-coach';
const OTHER_COACH_ID = 'acct-sparring-fix-other-coach';
const ATHLETE_ID = 'ATH-FIX-1';
const OTHER_ATHLETE_ID = 'ATH-FIX-2';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let repository: typeof import('./formulas/repository');
let runner: typeof import('./formulas/runner');
let autoCalculation: typeof import('./formulas/autoCalculation');
let checkInBaseline: typeof import('./formulas/checkInBaseline');

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
  for (const [accountId, role, organizationId] of [
    [ACCOUNT_ID, 'athlete', ORG_ID],
    [COACH_ID, 'coach', ORG_ID],
    [OTHER_COACH_ID, 'coach', OTHER_ORG_ID],
  ]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, organizationId],
    );
  }
  // pilot.athletes.coach_id is NOT NULL with a foreign key to pilot.accounts.
  for (const [organizationId, athleteId, coachId] of [
    [ORG_ID, ATHLETE_ID, COACH_ID],
    [ORG_ID, OTHER_ATHLETE_ID, COACH_ID],
    [OTHER_ORG_ID, ATHLETE_ID, OTHER_COACH_ID],
  ]) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
                                   emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $2, '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [organizationId, athleteId, coachId],
    );
  }
}

async function truncateAll(): Promise<void> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  try {
    await client.query(
      'truncate pilot.shadow_formula_baseline_snapshots, pilot.shadow_formula_results, pilot.shadow_formula_observations',
    );
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
  unit?: 'count' | 'boolean_0_1' | 'minutes';
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
    unit: input.unit ?? 'count',
    dimensions: input.dimensions ?? {},
    observedAt: input.observedAt,
    source: { type: 'manual', quality: 'moderate', referenceId: `ref-${idempotencyKey}` },
    idempotencyKey,
    supersedesObservationId: input.supersedes ?? null,
    createdByAccountId: input.organizationId && input.organizationId !== ORG_ID ? null : ACCOUNT_ID,
  });
}

/** What the observations route does after storing a correction. */
async function correct(original: { observationId: string; kind: ObservationKind; contextId: string; observedAt: string; dimensions?: unknown; unit?: string }, value: number) {
  const replacement = await observe({
    contextId: original.contextId,
    kind: original.kind,
    value,
    unit: original.unit as 'count' | 'boolean_0_1' | 'minutes' | undefined,
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

async function logEntry(
  contextId: string,
  observedAt: string,
  numbers: { thrown: number; landed: number; taken: number; allLanded?: number },
) {
  const thrown = await observe({ contextId, kind: 'punch_attempted', value: numbers.thrown, observedAt, dimensions: { punchType: 'Jab' } });
  const landed = await observe({ contextId, kind: 'punch_landed', value: numbers.landed, observedAt, dimensions: { punchType: 'Jab' } });
  const taken = await observe({ contextId, kind: 'punch_absorbed', value: numbers.taken, observedAt, dimensions: { opponentStance: 'Orthodox' } });
  // The "All punches landed" box, which MVP-04 reads (and only when filled in).
  const allLanded = numbers.allLanded === undefined
    ? null
    : await repository.saveFormulaObservation({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      contextId,
      kind: 'punch_landed',
      value: numbers.allLanded,
      unit: 'count',
      dimensions: { ...SESSION_TOTAL_DIMENSIONS },
      observedAt,
      source: { type: 'manual', quality: 'moderate', referenceId: `ref-${contextId}-all-landed` },
      idempotencyKey: `${contextId}-punch_landed-session_total`,
      createdByAccountId: ACCOUNT_ID,
    });
  await autoCalculation.autoCalculateForObservationContext({ organizationId: ORG_ID, athleteId: ATHLETE_ID, contextId });
  return { thrown, landed, taken, allLanded };
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

  repository = await import('./formulas/repository');
  runner = await import('./formulas/runner');
  autoCalculation = await import('./formulas/autoCalculation');
  checkInBaseline = await import('./formulas/checkInBaseline');
});

afterAll(async () => {
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
    await logEntry('sparring_1000', '2026-10-17T15:00:00.000Z', { thrown: 10, landed: 5, taken: 3, allLanded: 12 });
    expect(await latestValues()).toEqual({
      'MVP-03:accuracy_jab': 50,
      // All punches landed minus punches taken, never the jab count minus them.
      'MVP-04:value': 9,
    });
  });

  test('the second fix re-runs only current results and the reader shows both corrections', async () => {
    const entry = await logEntry('sparring_1000', '2026-10-17T15:00:00.000Z', { thrown: 10, landed: 5, taken: 3, allLanded: 12 });

    const afterLanded = await correct(entry.landed, 4);
    expect(afterLanded.map((result) => result.formulaId)).toEqual(['MVP-03']);

    // On main this throws OBSERVATION_NOT_FOUND: the ORIGINAL MVP-03 result
    // still lists the landed observation the first fix replaced.
    const afterThrown = await correct(entry.thrown, 8);
    expect(afterThrown.map((result) => result.formulaId)).toEqual(['MVP-03']);

    // A third fix, on the number MVP-04 reads.
    const afterTaken = await correct(entry.taken, 2);
    expect(afterTaken.map((result) => result.formulaId)).toEqual(['MVP-04']);

    expect(await latestValues()).toEqual({
      'MVP-03:accuracy_jab': 50,
      'MVP-04:value': 10,
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

describe('focus attainment (MVP-11) over the last 28 days', () => {
  // Jason 2026-10-17: "A: Last 28 days (Recommended)".
  test('a sparring session runs MVP-11 over the sessions in the 28 days up to it, and no older ones', async () => {
    const focus = async (contextId: string, value: number, observedAt: string) => {
      await observe({ contextId, kind: 'focus_achieved', value, unit: 'boolean_0_1', observedAt });
    };
    await focus('sparring_1000', 1, '2026-09-07T15:00:00.000Z'); // 40 days before: outside
    await focus('sparring_2000', 0, '2026-10-07T15:00:00.000Z'); // 10 days before: inside
    await focus('sparring_3000', 1, '2026-10-17T15:00:00.000Z'); // the session that ends the window
    // Another athlete's session inside the window never counts.
    await observe({
      contextId: 'sparring_4000', kind: 'focus_achieved', value: 0, unit: 'boolean_0_1',
      observedAt: '2026-10-16T15:00:00.000Z', athleteId: OTHER_ATHLETE_ID,
    });

    const results = await autoCalculation.autoCalculateForObservationContext({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      contextId: 'sparring_3000',
    });

    expect(results.map((result) => [result.formulaId, result.value])).toEqual([['MVP-11', 50]]);
    const inputs = await repository.getActiveFormulaObservationsByIds({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      observationIds: results[0].inputObservationIds,
    });
    expect(inputs.map((observation) => observation.contextId).sort()).toEqual(['sparring_2000', 'sparring_3000']);
    expect((await latestValues())['MVP-11:value']).toBe(50);
  });

  test('recomputing the same window is a no-op even when completeness is 2/3', async () => {
    // A focus answer of null (possible through the API, not the page) makes
    // MVP-11 insufficient with completeness 2/3, which numeric(6,5) cannot hold
    // exactly. Every observation of one submission recomputes the same window;
    // the second computation must find its own row, not a conflict.
    await observe({ contextId: 'sparring_1000', kind: 'focus_achieved', value: 1, unit: 'boolean_0_1', observedAt: '2026-10-10T15:00:00.000Z' });
    await repository.saveFormulaObservation({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      contextId: 'sparring_2000',
      kind: 'focus_achieved',
      value: null,
      unit: 'boolean_0_1',
      observedAt: '2026-10-12T15:00:00.000Z',
      source: { type: 'manual', quality: 'moderate', referenceId: 'ref-null-focus' },
      idempotencyKey: 'sparring_2000-focus_achieved',
      createdByAccountId: ACCOUNT_ID,
    });
    await observe({ contextId: 'sparring_3000', kind: 'focus_achieved', value: 1, unit: 'boolean_0_1', observedAt: '2026-10-17T15:00:00.000Z' });
    const scope = { organizationId: ORG_ID, athleteId: ATHLETE_ID, contextId: 'sparring_3000' };

    const first = await autoCalculation.autoCalculateForObservationContext(scope);
    const second = await autoCalculation.autoCalculateForObservationContext(scope);

    expect(first.map((result) => result.quality.completeness)).toEqual([0.66667]);
    expect(second.map((result) => result.resultId)).toEqual(first.map((result) => result.resultId));
  });
});

describe('the whole-session boxes (Jason 2026-10-17, "B: Longer sparring form")', () => {
  test('all thrown, all landed and minutes worked run MVP-02, MVP-04 and MVP-05; a fix re-runs them', async () => {
    const contextId = 'sparring_1000';
    const observedAt = '2026-10-17T15:00:00.000Z';
    const total = async (kind: ObservationKind, value: number, unit: 'count' | 'minutes', key = kind) => repository.saveFormulaObservation({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      contextId,
      kind,
      value,
      unit,
      dimensions: { ...SESSION_TOTAL_DIMENSIONS },
      observedAt,
      source: { type: 'manual', quality: 'moderate', referenceId: `ref-${contextId}-${key}` },
      idempotencyKey: `${contextId}-${key}`,
      createdByAccountId: ACCOUNT_ID,
    });
    await total('punch_count', 90, 'count');
    await total('round_count', 6, 'count');
    const minutes = await total('active_time', 12, 'minutes');
    await logEntry(contextId, observedAt, { thrown: 40, landed: 18, taken: 3, allLanded: 30 });

    expect(await latestValues()).toEqual({
      'MVP-02:punches_per_round': 15,
      'MVP-02:punches_per_active_minute': 7.5,
      'MVP-03:accuracy_jab': 45,
      'MVP-04:value': 27,
      'MVP-05:value': 2.5,
    });

    await correct(minutes, 10);
    const after = await latestValues();
    expect(after['MVP-02:punches_per_active_minute']).toBe(9);
    expect(after['MVP-05:value']).toBe(3);
  });
});

describe('personal baseline from the daily check-in (MVP-09; OD-2026-10-17-020)', () => {
  const checkInOn = (day: number, values: { sleep_hours?: number; energy?: number; soreness?: number }) => (
    checkInBaseline.recordCheckInBaselines({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      checkInId: `ci-${day}`,
      observedAt: new Date(Date.parse('2026-10-01T12:00:00.000Z') + day * 24 * 60 * 60 * 1_000).toISOString(),
      accountId: ACCOUNT_ID,
      values,
    })
  );

  test('from the eighth daily check-in each item has a provisional value, kept apart on the coach read', async () => {
    for (let day = 0; day < 7; day += 1) {
      await checkInOn(day, { sleep_hours: 8, energy: day % 2 === 0 ? 3 : 4, soreness: 2 });
    }
    // The seventh check-in had six before it: no value yet.
    const seventh = await repository.listLatestFormulaResultsPerOutput({ organizationId: ORG_ID, athleteId: ATHLETE_ID, formulaId: 'MVP-09' });
    expect(seventh.every((result) => result.value === null)).toBe(true);

    const eighth = await checkInOn(7, { sleep_hours: 6, energy: 2, soreness: 4 });
    const raw: Record<string, FormulaResult> = Object.fromEntries(eighth
      .filter((result) => result.outputKey === 'raw_change')
      .map((result) => [String(result.parameters.metricKey), result]));
    expect(raw.sleep_hours.value).toBe(-2);
    // Always 8 hours before: the 0.5 h floor, not a divide-by-zero.
    const sleepStandardized = eighth.find((result) => result.outputKey === 'standardized_change' && result.parameters.metricKey === 'sleep_hours');
    expect(sleepStandardized?.value).toBe(-4);
    for (const result of Object.values(raw)) {
      expect(result.validation.warnings).toContain('SHORT_BASELINE');
      expect(result.inputObservationIds).toHaveLength(8);
    }

    const latest = await repository.listLatestFormulaResultsPerOutput({ organizationId: ORG_ID, athleteId: ATHLETE_ID, formulaId: 'MVP-09' });
    expect(latest
      .filter((result) => result.outputKey === 'raw_change')
      .map((result) => [result.parameters.metricKey, result.value])
      .sort()).toEqual([['energy', expect.any(Number)], ['sleep_hours', -2], ['soreness', 2]]);

    // A parent's read (results route) excludes MVP-09 in SQL.
    const forParent = await repository.listActiveFormulaResults({
      organizationId: ORG_ID, athleteId: ATHLETE_ID, excludeFormulaIds: ['MVP-09'],
    });
    expect(forParent.some((result) => result.formulaId === 'MVP-09')).toBe(false);

    // The snapshot is stored with the day window (window_size 28, building).
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      const snapshots = await client.query(
        `select metric_key, window_size, history_status from pilot.shadow_formula_baseline_snapshots
         where organization_id = $1 and athlete_id = $2 and history_status = 'building' order by metric_key`,
        [ORG_ID, ATHLETE_ID],
      );
      expect(snapshots.rows).toEqual([
        { metric_key: 'energy', window_size: 28, history_status: 'building' },
        { metric_key: 'sleep_hours', window_size: 28, history_status: 'building' },
        { metric_key: 'soreness', window_size: 28, history_status: 'building' },
      ]);
    } finally {
      await client.end();
    }
  });

  test('a repeated check-in writes nothing new', async () => {
    await checkInOn(0, { energy: 3 });
    await checkInOn(0, { energy: 3 });
    const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await client.connect();
    try {
      const count = await client.query(
        `select count(*)::int as n from pilot.shadow_formula_observations where organization_id = $1 and observation_kind = 'numeric'`,
        [ORG_ID],
      );
      expect(count.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });
});
