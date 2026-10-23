// Real PostgreSQL proof for SHADOW F2 (coach-requested draft, explicit save):
// the REAL previewCoachDraft, saveCoachDraft and getCoachDraftOrigins over the
// full schema, with only the model reply stubbed (no model call is made).
//
//   - a preview writes no recommendation, audit entry, evidence bundle or item;
//   - two saves of the same preview racing each other store ONE provisional
//     recommendation and ONE audit entry (athlete-row lock + stored draft id);
//   - the screen's read of a saved draft carries no account id;
//   - a newer result for the same output makes the preview stale;
//   - a deleted athlete gets nothing saved.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-coach-draft-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_shadow_coach_draft';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('Could not determine a free port')));
    });
  });
}

const ORG = 'org-f2-1';
const COACH = 'acct-f2-coach';
const ATHLETE = 'ath-f2-1';
const GONE_ATHLETE = 'ath-f2-gone';
const NO_LIMITS_ATHLETE = 'ath-f2-no-limits';
// A test-only stand-in for the deployment's server-only secret (HKDF input).
const TEST_IKM = 'test-only-ikm-not-a-real-secret';
const QUESTION = 'southpaw footwork pivot';
const SESSION = 'session-token-f2';

const coach = { accountId: COACH, organizationId: ORG, athleteId: null, role: 'coach' as const };

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let f2: typeof import('./shadowCoachRecommendation');

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function formulaResult(athleteId: string, computedAt: string): Promise<string> {
  const resultId = `res-${athleteId}-${computedAt}`;
  await db.query(
    `insert into pilot.shadow_formula_results
       (result_id, calculation_key, formula_id, formula_version, output_key, policy_version,
        parameters, organization_id, athlete_id, context_id, numeric_value, unit, computed_at,
        input_observation_ids, provenance, validation_state, hard_blocks, warnings,
        confidence, completeness, worst_source_quality, unavailable_reason, human_review_required)
     values ($1, $1, 'MVP-03', '1.0.0', 'accuracy', 'policy-1', '{}'::jsonb, $2, $3, 'ctx-1', 45, 'percent', $4,
             array['obs-1'], '[]'::jsonb, 'valid', '{}', '{}', 'MODERATE', 1, 'moderate', null, false)`,
    [resultId, ORG, athleteId, computedAt],
  );
  return resultId;
}

async function count(table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return rows[0].n;
}

async function writeCounts() {
  return {
    recommendations: await count('pilot.shadow_recommendations'),
    audit: await count('pilot.shadow_audit_entries'),
    bundles: await count('pilot.shadow_evidence_bundles'),
    items: await count('pilot.shadow_evidence_items'),
    decisions: await count('pilot.shadow_decisions'),
  };
}

const stubModel = async () => ({
  recommendationText: 'Repeat the pivot drill with coach feedback after each round.',
  expectedOutcome: 'The coach sees the pivot finish on balance in the next recorded round.',
  citedChunkIds: ['chunk-f2-pivot'],
  modelUsed: 'stub-model',
});

async function preview(athleteId: string, resultId: string) {
  const result = await f2.previewCoachDraft({
    actor: coach, athleteId, resultId, question: QUESTION, sessionToken: SESSION, generate: stubModel,
  });
  if (result.kind !== 'draft') throw new Error(`Expected a draft, got ${result.reason}`);
  return result.preview;
}

beforeAll(async () => {
  PG_PORT = await freePort();

  serverProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(db, {
    infraDir: INFRA_DIR,
  });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, 'Punxsy Prominence', 'active')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
    [COACH, ORG],
  );
  // The coach's staff membership: the limits modules read limits only for
  // active staff of this gym.
  await db.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
    [COACH, ORG],
  );
  // All three are minors (born 2012). The first two have every coach-set
  // limit set; NO_LIMITS_ATHLETE has none.
  for (const athleteId of [ATHLETE, GONE_ATHLETE, NO_LIMITS_ATHLETE]) {
    await db.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Test Athlete', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $3, now(), now())`,
      [ORG, athleteId, COACH],
    );
  }
  for (const athleteId of [ATHLETE, GONE_ATHLETE]) {
    for (const [type, valueNumber, valueText, unit] of [
      ['heat_exposure_minutes_per_session', 20, null, 'minutes'],
      ['weight_cut_max_percent_body_weight', 2, null, 'percent_body_weight'],
      ['supervision', null, 'Coach on the floor', 'text'],
    ] as const) {
      await db.query(
        `insert into pilot.athlete_minor_limits
           (organization_id, limit_id, athlete_id, limit_type, value_number, value_text, unit, note, set_by_account_id, set_by_role)
         values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, '', $7, 'coach')`,
        [ORG, athleteId, type, valueNumber, valueText, unit, COACH],
      );
    }
    await db.query(
      `insert into pilot.athlete_contact_caps
         (organization_id, cap_id, athlete_id, highest_allowed_stage, max_hard_open_sessions_per_7_days, note, set_by_account_id, set_by_role)
       values ($1, gen_random_uuid(), $2, 'light_technical', null, '', $3, 'coach')`,
      [ORG, athleteId, COACH],
    );
  }

  await db.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status, rights_status,
        approval_state, verification_state, approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ('src-f2', $1, 'Footwork study', 'peer_reviewed', 1, 'active', 'ppbf_owned', 'approved', 'verified', $2, now(), $2, now())`,
    [ORG, COACH],
  );
  await db.query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, document_name, ingest_state, index_completed_at, subject_id,
        approval_state, verification_state, approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ('doc-f2', 'src-f2', $1, 'Footwork chapter', 'indexed', now(), null, 'approved', 'verified', $2, now(), $2, now())`,
    [ORG, COACH],
  );
  await db.query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, ordinal, text_content, text_kind, excerpt_locator, subject_id)
     values ('chunk-f2-pivot', 'doc-f2', 'src-f2', $1, 1, 'Southpaw footwork pivot: finish each pivot on balance.', 'full_text', null, null)`,
    [ORG],
  );

  // Keyword path only: no embedding deployment, so no embedding call either.
  delete process.env.AZURE_AI_ENDPOINT;
  delete process.env.AZURE_AI_KEY;
  process.env.PPBF_MS_CLIENT_SECRET = TEST_IKM;
  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  f2 = await import('./shadowCoachRecommendation');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool().catch(() => {});
  await db?.end().catch(() => {});

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

describe('SHADOW F2 against a real database', () => {
  test('a preview writes no recommendation, audit entry, evidence or decision', async () => {
    const resultId = await formulaResult(ATHLETE, '2026-10-20T10:00:00.000Z');
    const before = await writeCounts();
    const telemetryBefore = await count('pilot.shadow_telemetry_events');
    const draft = await preview(ATHLETE, resultId);
    expect(draft.citations.map((citation) => citation.chunkId)).toEqual(['chunk-f2-pivot']);
    expect(await writeCounts()).toEqual(before);
    // The Library search's own log line, as on every search; it holds no question text.
    const { rows } = await db.query<{ metric_name: string; dimensions: unknown }>(
      `select metric_name, dimensions from pilot.shadow_telemetry_events order by created_at desc limit $1`,
      [(await count('pilot.shadow_telemetry_events')) - telemetryBefore],
    );
    expect(rows.map((row) => row.metric_name)).toEqual(['shadow.library.search']);
    expect(JSON.stringify(rows[0].dimensions)).not.toContain('southpaw');
  });

  test('two saves of the same preview racing each other store one provisional recommendation', async () => {
    const resultId = (await db.query<{ result_id: string }>(
      `select result_id from pilot.shadow_formula_results where athlete_id = $1`, [ATHLETE],
    )).rows[0].result_id;
    const draft = await preview(ATHLETE, resultId);
    const before = await writeCounts();

    const save = () => f2.saveCoachDraft({
      actor: coach, athleteId: ATHLETE, previewToken: draft.previewToken, sessionToken: SESSION,
    });
    // Force the race. A third connection holds the athlete row; both saves
    // must then be waiting on the save's own row lock at the same moment, so
    // they truly overlap. Released only once both wait. (Measured with the
    // lock removed: neither save waits, so `waiting` stays 0 and this fails.)
    const holder = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
    await holder.connect();
    await holder.query('begin');
    await holder.query(
      'select 1 from pilot.athletes where organization_id = $1 and athlete_id = $2 for update', [ORG, ATHLETE],
    );
    const racing = Promise.all([save(), save()]);
    let waiting = 0;
    for (let attempt = 0; attempt < 400 && waiting < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      waiting = (await db.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      )).rows[0].n;
    }
    await holder.query('commit');
    await holder.end();
    const [first, second] = await racing;
    expect(waiting).toBe(2);
    expect(first?.recommendation_id).toBeTruthy();
    expect(second?.recommendation_id).toBe(first?.recommendation_id);

    const after = await writeCounts();
    expect(after.recommendations).toBe(before.recommendations + 1);
    expect(after.audit).toBe(before.audit + 1);

    const { rows: [stored] } = await db.query(
      `select status, source_formula_result_id, created_by_account_id from pilot.shadow_recommendations
        where recommendation_id = $1`, [first!.recommendation_id],
    );
    expect(stored).toEqual({ status: 'provisional', source_formula_result_id: resultId, created_by_account_id: COACH });

    const { rows: [audit] } = await db.query<{ action: string; f2: Record<string, unknown> }>(
      `select action, after_state->'f2' as f2 from pilot.shadow_audit_entries
        where entity_type = 'recommendation' and entity_id = $1`, [first!.recommendation_id],
    );
    expect(audit.action).toBe('created_provisional');
    expect(audit.f2).toEqual(expect.objectContaining({
      draftId: draft.draftId, generatedBy: 'SHADOW', modelUsed: 'stub-model',
      requestedByAccountId: COACH, sourceFormulaResultId: resultId, semanticSupportVerified: false,
    }));

    // The screen's read of it: provenance, no account id, no passage hash.
    const origins = await f2.getCoachDraftOrigins(ORG, ATHLETE);
    expect(origins[first!.recommendation_id]).toEqual({
      generatedBy: 'SHADOW', modelUsed: 'stub-model', sourceFormulaResultId: resultId,
      citations: [{ chunkId: 'chunk-f2-pivot', sourceTitle: 'Footwork study', documentName: 'Footwork chapter' }],
      semanticSupportVerified: false,
    });
    expect(JSON.stringify(origins)).not.toContain(COACH);
  });

  test('a newer result for the same output makes the preview stale; nothing is saved', async () => {
    const resultId = (await db.query<{ result_id: string }>(
      `select result_id from pilot.shadow_formula_results where athlete_id = $1`, [ATHLETE],
    )).rows[0].result_id;
    const draft = await preview(ATHLETE, resultId);
    await formulaResult(ATHLETE, '2026-10-21T10:00:00.000Z');
    const before = await writeCounts();
    await expect(f2.saveCoachDraft({
      actor: coach, athleteId: ATHLETE, previewToken: draft.previewToken, sessionToken: SESSION,
    })).rejects.toBeInstanceOf(f2.StaleCoachDraftError);
    expect(await writeCounts()).toEqual(before);
  });

  test('a minor with no coach-set limits gets no draft: nothing searched, nothing written', async () => {
    const resultId = await formulaResult(NO_LIMITS_ATHLETE, '2026-10-20T10:00:00.000Z');
    const before = await writeCounts();
    const telemetryBefore = await count('pilot.shadow_telemetry_events');
    let modelCalled = false;
    const result = await f2.previewCoachDraft({
      actor: coach, athleteId: NO_LIMITS_ATHLETE, resultId, question: QUESTION, sessionToken: SESSION,
      generate: async () => { modelCalled = true; return stubModel(); },
    });
    expect(result).toEqual({ kind: 'abstain', reason: 'limits_not_set' });
    expect(modelCalled).toBe(false);
    expect(await writeCounts()).toEqual(before);
    // No Library search ran (its telemetry row would be here).
    expect(await count('pilot.shadow_telemetry_events')).toBe(telemetryBefore);
  });

  test('an athlete deleted after the preview gets nothing saved', async () => {
    const resultId = await formulaResult(GONE_ATHLETE, '2026-10-20T10:00:00.000Z');
    const draft = await preview(GONE_ATHLETE, resultId);
    await db.query(`update pilot.athletes set deleted_at = now() where athlete_id = $1`, [GONE_ATHLETE]);
    const before = await writeCounts();
    // The evidence recheck re-asserts access and is refused: not found, nothing written.
    expect(await f2.saveCoachDraft({
      actor: coach, athleteId: GONE_ATHLETE, previewToken: draft.previewToken, sessionToken: SESSION,
    })).toBeNull();
    expect(await writeCounts()).toEqual(before);
  });
});
