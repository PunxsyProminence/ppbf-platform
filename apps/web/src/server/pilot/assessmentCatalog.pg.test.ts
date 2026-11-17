// The assessment catalog (lane CAT-a; SCHEMA_PROPOSAL P5, P6; OD-2026-11-15-006
// ruling 1, OD-2026-11-16-001, OD-2026-11-16-003), DATABASE half: the
// assessment_catalog migration applies and re-applies; its seven protocol
// columns are nullable with no default and leave existing protocol and
// assessment rows exactly as they were; every shape the frozen
// design_catalogs.json holds is admitted, and anything else is refused by name;
// catalog rows are retired, never deleted, except with their organization.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'assessment_catalog';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-assessment-catalog-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.join(WEB_DIR, 'scripts/pilot-apply-assessment-catalog-migration.mjs');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_assessment_catalog_migration.sql');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let applyMigrationTransaction: (c: Client, sql: string) => Promise<void>;
let CATALOG_TABLES: string[];
let PROTOCOL_COLUMNS: string[];
let migrationSql: string;

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

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });
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
  serverProcess.stdout.resume();

  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (c: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE}`);
  await admin.query(`create database ${DATABASE}`);
  await admin.end();
  client = new Client({ connectionString: connectionStringFor(DATABASE) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyMigrationTransaction = runner.applyMigrationTransaction as (c: Client, sql: string) => Promise<void>;
  CATALOG_TABLES = runner.CATALOG_TABLES as string[];
  PROTOCOL_COLUMNS = runner.PROTOCOL_COLUMNS as string[];
  migrationSql = await fs.readFile(MIGRATION_PATH, 'utf8');
});

afterAll(async () => {
  await client?.end().catch(() => {});
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

// ---------------------------------------------------------------------------
// Fixtures

const hex = (n: number) => n.toString(16).padStart(14, '0');
const PGT = (n: number) => `pgt_${hex(n)}`;
const PGC = (n: number) => `pgc_${hex(n)}`;
const SCI = (n: number) => `sci_${hex(n)}`;
const ACS = (n: number) => `acs_${hex(n)}`;
const KPI = (n: number) => `kpi_${hex(n)}`;

/** A gym, an organization admin of it, and the four stages the fixtures use. */
async function createGym(org: string): Promise<string> {
  const account = `admin@${org}`;
  await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [org]);
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag) values ($1, 'organization_admin', $2, false, true)`,
    [account, org],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'organization_admin', true)`,
    [account, org],
  );
  await client.query(
    `insert into pilot.pathway_stages (organization_id, stage_key, segment, ordinal, name, contact_default)
     values ($1, 'Y1', 'youth', 1, 'Introduction', 'none'), ($1, 'Y2', 'youth', 2, 'Foundations', 'none'),
            ($1, 'T1', 'trunk', 6, 'Trunk 1', 'light_technical'), ($1, 'T2', 'trunk', 7, 'Trunk 2', 'controlled_sparring')`,
    [org],
  );
  return account;
}

const EVIDENCE = JSON.stringify([
  { evidence_category: 'unassigned', evidence_label: 'UNTIERED', check_state: 'unchecked', evidence_item_ids: [], registry_claim_ids: [] },
]);

async function insertScale(org: string, key = 'live_long_road') {
  await client.query(
    `insert into pilot.scorecard_scales (organization_id, scale_key, min_level, max_level, level_anchors, status)
     values ($1, $2, 1, 5, $3::jsonb, 'REPORTED')`,
    [org, key, JSON.stringify({ 1: 'Absent or actively wrong', 5: 'Reliable under pressure against better opposition' })],
  );
}

async function insertGate(org: string, n: number, stage: string, kind: string) {
  await client.query(
    `insert into pilot.pathway_gates (organization_id, gate_id, stage_key, gate_kind, status, sources, evidence)
     values ($1, $2, $3, $4, 'REPORTED', array['LR-201'], $5::jsonb)`,
    [org, PGT(n), stage, kind, EVIDENCE],
  );
}

async function insertItem(org: string, n: number, itemNumber: number | null, scaleKey: string | null = 'live_long_road') {
  await client.query(
    `insert into pilot.scorecard_items (organization_id, scorecard_item_id, protocol_id, item_number, item_group, name, definition, scale, scale_key,
                                        scorable_contexts, status, sources)
     values ($1, $2, case when $3::int is null then null else 'PP-T01' end, $3, 'foundations', 'Stance integrity under movement',
             'Stance integrity under movement, base width', '1-5 (Long Road Part 2 section 3.1)', $4,
             array['drill','shadow','partner','constrained_live','live'], 'REPORTED', array['LR-P2§3.2'])`,
    [org, SCI(n), itemNumber, scaleKey],
  );
}

/** Runs one statement in its own transaction (kept on success); returns the SQLSTATE and constraint, or 'ok'. */
async function attempt(sql: string, params: unknown[] = []): Promise<string> {
  await client.query('BEGIN');
  try {
    await client.query(sql, params);
    await client.query('COMMIT');
    return 'ok';
  } catch (error) {
    await client.query('ROLLBACK');
    const e = error as { code?: string; constraint?: string; message?: string };
    return `${e.code} ${e.constraint ?? e.message?.split('\n')[0] ?? ''}`.trim();
  }
}

async function columnFacts() {
  return (await client.query(
    `select column_name, is_nullable, column_default from information_schema.columns
      where table_schema = 'pilot' and table_name = 'assessment_protocols' and column_name = any($1::text[])
      order by column_name`,
    [PROTOCOL_COLUMNS],
  )).rows;
}

// ---------------------------------------------------------------------------

describe('the assessment_catalog migration', () => {
  it('is in the schema, and its runner re-applies it and passes its own readiness check', async () => {
    await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
    await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
    const { rows } = await client.query(
      `select count(*)::int as n from unnest($1::text[]) t where to_regclass('pilot.' || t) is not null`,
      [CATALOG_TABLES],
    );
    expect(rows[0].n).toBe(8);
  });

  it('its readiness check refuses a database missing any guarantee', async () => {
    // Pieces the migration re-creates on a re-run (trigger, guarded protocol checks, the protocol columns' shape).
    const restoredByRerun = [
      'drop trigger pilot_behavior_kpis_no_delete on pilot.behavior_kpis',
      'alter table pilot.assessment_protocols drop constraint pilot_assessment_protocols_status_check',
    ];
    for (const sql of restoredByRerun) {
      await client.query(sql);
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(/ASSESSMENT_CATALOG_NOT_READY/);
      await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
    }
    // A default on a new protocol column would write a value into existing rows.
    await client.query("alter table pilot.assessment_protocols alter column status set default 'REPORTED'");
    await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(/ASSESSMENT_CATALOG_NOT_READY: protocol_columns_ready/);
    await client.query('alter table pilot.assessment_protocols alter column status drop default');
    // Pieces written inside a table body: `create table if not exists` cannot restore them (the header
    // says to change these tables by a new migration), so each is put back by hand after the refusal.
    const restoredByHand: [string, string, RegExp][] = [
      [
        'alter table pilot.pathway_gate_criteria drop constraint pilot_pathway_gate_criteria_ref_gate_match_fkey',
        `alter table pilot.pathway_gate_criteria add constraint pilot_pathway_gate_criteria_ref_gate_match_fkey
           foreign key (organization_id, ref_gate_id, ref_stage_key, ref_gate_kind)
           references pilot.pathway_gates(organization_id, gate_id, stage_key, gate_kind)`,
        /catalog_keys_ready/,
      ],
      [
        'alter table pilot.pathway_gate_criteria drop constraint pilot_pathway_gate_criteria_kind_check',
        `alter table pilot.pathway_gate_criteria add constraint pilot_pathway_gate_criteria_kind_check
           check (kind in ('text', 'scorecard_min', 'stage_completed', 'gate_met', 'bout_count'))`,
        /checks_ready/,
      ],
    ];
    for (const [breakSql, restoreSql, failed] of restoredByHand) {
      await client.query(breakSql);
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(failed);
      await client.query(restoreSql);
    }
    await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
  });

  it('adds seven nullable protocol columns with no default, and leaves existing protocol and assessment rows exactly as they were', async () => {
    // Back to the database before this migration: the eight tables and seven columns gone.
    await client.query(`drop table ${CATALOG_TABLES.map((t) => `pilot.${t}`).join(', ')} cascade`);
    for (const column of PROTOCOL_COLUMNS) {
      await client.query(`alter table pilot.assessment_protocols drop column ${column}`);
    }
    expect(await columnFacts()).toEqual([]);

    await createGym('gym_before');
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
                                   coach_id, created_at, updated_at)
       values ('gym_before', 'ath_before', 'Athlete A', '2010-01-01', '120lb', 'active', 'Contact', true, 'admin@gym_before', now(), now())`,
    );
    await client.query(
      `insert into pilot.assessment_protocols (organization_id, protocol_id, protocol_version, name, measure_kind, quality_measured, protocol_summary,
                                                equipment_needed, time_to_administer_min, retest_interval_days)
       values ('gym_before', 'A5-T01', 1, 'Countermovement jump', 'physical_test', 'Lower-body power', 'Best of three.', 'Mat', 5, 42)`,
    );
    await client.query(
      `insert into pilot.assessments (organization_id, assessment_id, athlete_id, assessor_account_id, assessment_type, result, protocol_id, protocol_version)
       values ('gym_before', gen_random_uuid(), 'ath_before', 'admin@gym_before', 'physical_test', '{"cm": 32}'::jsonb, 'A5-T01', 1)`,
    );
    const snapshot = async () => ({
      protocols: (await client.query(`select to_jsonb(p) as row from pilot.assessment_protocols p where organization_id = 'gym_before'`)).rows,
      assessments: (await client.query(`select to_jsonb(a) as row from pilot.assessments a where organization_id = 'gym_before'`)).rows,
    });
    const before = await snapshot();

    await applyMigrationTransaction(client, migrationSql);
    await applyMigrationTransaction(client, migrationSql);

    expect(await columnFacts()).toEqual(PROTOCOL_COLUMNS.slice().sort().map((column_name) => ({
      column_name, is_nullable: 'YES', column_default: null,
    })));
    const after = await snapshot();
    const withoutNew = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !PROTOCOL_COLUMNS.includes(key)));
    expect(after.protocols.map((r) => withoutNew(r.row))).toEqual(before.protocols.map((r) => r.row));
    for (const { row } of after.protocols) {
      for (const column of PROTOCOL_COLUMNS) expect(row[column]).toBeNull();
    }
    expect(after.assessments).toEqual(before.assessments);
  });

  it('admits every shape the frozen design_catalogs.json holds', async () => {
    await createGym('gym_shapes');
    await insertScale('gym_shapes');
    await insertScale('gym_shapes', 'cue_response_draft');
    await insertGate('gym_shapes', 1, 'T1', 'checkpoint_90_days');
    await insertGate('gym_shapes', 2, 'T1', 'exit');
    await insertGate('gym_shapes', 3, 'T2', 'entry');
    await insertGate('gym_shapes', 4, 'Y2', 'contact_readiness');
    await insertGate('gym_shapes', 5, 'T2', 'exit');
    await insertItem('gym_shapes', 1, 1);
    await insertItem('gym_shapes', 2, null, null); // the frozen item with no protocol and no scale (gap)

    const criteria = [
      // T1 checkpoint, polarity text (LR-201)
      [PGC(1), PGT(1), 8, 'text', { criterion_text: 'Sparred hard', polarity: 'should_not_have' }],
      // scorecard minimum with a half point (AM1/T2 exit, 4.5)
      [PGC(2), PGT(5), 2, 'scorecard_min', { scorecard_item_ids: [SCI(1)], item_numbers: [1], min_score: 4.5, contexts: ['live'], combine: 'all' }],
      // any of the items (Y2 contact_readiness, pgc_526687712a6aba)
      [PGC(6), PGT(4), 2, 'scorecard_min', { scorecard_item_ids: [SCI(1)], item_numbers: [1], min_score: 2, contexts: ['partner'], combine: 'any' }],
      // stage completed (Y2 entry shape) and gate met (T2 entry)
      [PGC(3), PGT(4), 1, 'stage_completed', { ref_stage_key: 'Y1' }],
      [PGC(4), PGT(3), 1, 'gate_met', { ref_stage_key: 'T1', ref_gate_kind: 'exit', ref_gate_id: PGT(2) }],
      // bout count (T1 exit)
      [PGC(5), PGT(2), 4, 'bout_count', { bout_min: 2, bout_max: 5, bout_scope: 'sanctioned bouts in stage', note: 'Competition route only.' }],
    ] as const;
    for (const [id, gate, ordinal, kind, fields] of criteria) {
      const f = fields as Record<string, unknown>;
      await client.query(
        `insert into pilot.pathway_gate_criteria (organization_id, criterion_id, gate_id, ordinal, kind, criterion_text, polarity, scorecard_item_ids,
                                                  item_numbers, min_score, contexts, combine, ref_stage_key, ref_gate_kind, ref_gate_id,
                                                  bout_min, bout_max, bout_scope, note, status, field_labels)
         values ('gym_shapes', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'REPORTED', $19::jsonb)`,
        [id, gate, ordinal, kind, f.criterion_text ?? null, f.polarity ?? null, f.scorecard_item_ids ?? null, f.item_numbers ?? null,
          f.min_score ?? null, f.contexts ?? null, f.combine ?? null, f.ref_stage_key ?? null, f.ref_gate_kind ?? null, f.ref_gate_id ?? null,
          f.bout_min ?? null, f.bout_max ?? null, f.bout_scope ?? null, f.note ?? null,
          JSON.stringify({ criterion_text: { text: 'INFERRED (test name and phase cell joined by the drafting session)' } })],
      );
    }
    await client.query(
      `insert into pilot.scorecard_anchor_clip_specs (organization_id, anchor_spec_id, scorecard_item_id, item_number, level, context_class,
                                                      used_by_stage_keys, priority, status, sources)
       values ('gym_shapes', $1, $2, 1, 3, 'non_contact', array['Y1','Y2'], 1, 'INFERRED', array['YOUTH_GATE_PROTOCOL.md (derived from gate thresholds)']),
              ('gym_shapes', $3, $2, 1, 3, 'live', array['T1','T2'], 2, 'INFERRED', null)`,
      [ACS(1), SCI(1), ACS(2)],
    );
    await client.query(
      `insert into pilot.scorecard_score_caps (organization_id, cap_key, scale_key, max_score, applies_to, applies_to_protocol_id, applies_to_contexts,
                                               wording, decision, note, status)
       values ('gym_shapes', 'non_contact_rule', 'live_long_road', 3, 'PP-T01 Long Road items scored in drill, shadow or partner contexts', 'PP-T01',
               array['drill','shadow','partner'], 'live_long_road (verbatim)', 'D-Q11', 'Cap scope read as PP-T01 only', 'OBSERVED')`,
    );
    await client.query(
      `insert into pilot.behavior_kpi_lists (organization_id, list_key, title, source_doc, scoring_rule_text, status)
       values ('gym_shapes', 'drill', 'Core Drill KPIs Worth Scoring', 'DOC-041', 'Use simple counts, yes-no marks, or three-level ratings when possible.', 'OBSERVED'),
              ('gym_shapes', 'room', 'Core Behavioral KPIs', 'DOC-027', 'Use simple counts or simple quality ratings.', 'REPORTED')`,
    );
    await client.query(
      `insert into pilot.behavior_kpis (organization_id, kpi_id, list_key, ordinal, name, scoring_kind, level_anchors, status, field_labels)
       values ('gym_shapes', $1, 'drill', 1, 'Clean exits.', 'count', null, 'OBSERVED', null),
              ('gym_shapes', $2, 'drill', 2, 'Reset quality.', 'three_level', '{"1": "a", "2": "b", "3": "c"}'::jsonb, 'OBSERVED',
               '{"level_anchors": {"status": "INFERRED", "draft": true}}'::jsonb),
              ('gym_shapes', $3, 'room', 1, 'Clean exits.', null, null, 'REPORTED', null)`,
      [KPI(1), KPI(2), KPI(3)],
    );
    await client.query(
      `insert into pilot.assessment_protocols (organization_id, protocol_id, protocol_version, name, measure_kind, quality_measured, protocol_summary,
                                                boxing_specific, evidence_class, reliability_status, validity_status,
                                                protocol_group, status, sources, decision, field_labels, evidence, backbone_version)
       values ('gym_shapes', 'PP-T35', 1, 'Tactical KPI count per round', 'other', '', 'Count these events per round.', '', '',
               'UNVALIDATED - PPBF MUST ESTABLISH (repo default, EVIDENCE_VOCABULARY s4)', 'UNKNOWN (repo default)',
               'Tactical KPIs', 'REPORTED', array['LR-034'], 'D-OQ184', '{}'::jsonb, $1::jsonb, 'draft-1')`,
      [EVIDENCE],
    );

    const { rows } = await client.query(
      `select (select count(*) from pilot.pathway_gates where organization_id = $1)::int as gates,
              (select count(*) from pilot.pathway_gate_criteria where organization_id = $1)::int as criteria,
              (select min_score::text from pilot.pathway_gate_criteria where organization_id = $1 and criterion_id = $2) as half,
              (select count(*) from pilot.scorecard_anchor_clip_specs where organization_id = $1)::int as specs,
              (select count(*) from pilot.behavior_kpis where organization_id = $1)::int as kpis`,
      ['gym_shapes', PGC(2)],
    );
    expect(rows[0]).toEqual({ gates: 5, criteria: 6, half: '4.5', specs: 2, kpis: 3 });
  });

  it('refuses, by name, what the frozen catalog does not hold', async () => {
    await createGym('gym_refuse');
    await insertScale('gym_refuse');
    await insertGate('gym_refuse', 10, 'T1', 'exit');
    await insertItem('gym_refuse', 10, 1);
    const gate = (stage: string, kind: string, id = PGT(11), informs = true) => attempt(
      `insert into pilot.pathway_gates (organization_id, gate_id, stage_key, gate_kind, informs_only, status) values ('gym_refuse', $1, $2, $3, $4, 'REPORTED')`,
      [id, stage, kind, informs],
    );
    const criterion = (kind: string, extra: string, values: string) => attempt(
      `insert into pilot.pathway_gate_criteria (organization_id, criterion_id, gate_id, ordinal, kind${extra})
       values ('gym_refuse', '${PGC(11)}', '${PGT(10)}', 2, '${kind}'${values})`,
    );
    const spec = (level: number, context: string) => attempt(
      `insert into pilot.scorecard_anchor_clip_specs (organization_id, anchor_spec_id, scorecard_item_id, level, context_class, status)
       values ('gym_refuse', $1, $2, $3, $4, 'INFERRED')`,
      [ACS(11), SCI(10), level, context],
    );
    await client.query(
      `insert into pilot.behavior_kpi_lists (organization_id, list_key, title, source_doc, status) values ('gym_refuse', 'drill', 'Drill KPIs', 'DOC-041', 'OBSERVED')`,
    );
    const kpi = (kind: string | null, anchors: string | null, list = 'drill') => attempt(
      `insert into pilot.behavior_kpis (organization_id, kpi_id, list_key, ordinal, name, scoring_kind, level_anchors, status)
       values ('gym_refuse', $1, $2, 1, 'Reset quality.', $3, $4::jsonb, 'OBSERVED')`,
      [KPI(11), list, kind, anchors],
    );

    expect(await gate('AM9', 'entry')).toBe('23503 pilot_pathway_gates_stage_fkey');
    expect(await gate('T1', 'graduation')).toBe('23514 pilot_pathway_gates_kind_check');
    expect(await gate('T1', 'entry', PGT(11), false)).toBe('23514 pilot_pathway_gates_informs_only_check');
    expect(await gate('T1', 'entry', 'gate_ppbf_T1')).toBe('23514 pilot_pathway_gates_id_check');
    expect(await gate('T1', 'exit', PGT(12))).toBe('23505 pilot_pathway_gates_stage_kind_key');
    expect(await attempt(
      `insert into pilot.pathway_gates (organization_id, gate_id, stage_key, gate_kind, status) values ('gym_refuse', $1, 'T1', 'entry', 'MAYBE')`, [PGT(13)],
    )).toBe('23514 pilot_pathway_gates_status_check');

    expect(await criterion('vibes', ', criterion_text', `, 'x'`)).toBe('23514 pilot_pathway_gate_criteria_kind_check');
    expect(await criterion('text', '', '')).toBe('23514 pilot_pathway_gate_criteria_kind_shape_check');
    expect(await criterion('scorecard_min', ', min_score, contexts', `, 3, array['live']`)).toBe('23514 pilot_pathway_gate_criteria_kind_shape_check');
    expect(await criterion('scorecard_min', ', scorecard_item_ids, min_score', `, array['${SCI(10)}'], 3`)).toBe('23514 pilot_pathway_gate_criteria_kind_shape_check');
    expect(await criterion('scorecard_min', ', scorecard_item_ids, min_score, contexts', `, array['${SCI(10)}'], 3, array['sparring']`))
      .toBe('23514 pilot_pathway_gate_criteria_contexts_check');
    expect(await criterion('stage_completed', '', '')).toBe('23514 pilot_pathway_gate_criteria_kind_shape_check');
    expect(await criterion('stage_completed', ', ref_stage_key', `, 'AM9'`)).toBe('23503 pilot_pathway_gate_criteria_ref_stage_fkey');
    expect(await criterion('gate_met', ', ref_gate_id', `, '${PGT(99)}'`)).toBe('23503 pilot_pathway_gate_criteria_ref_gate_fkey');
    expect(await criterion('bout_count', '', '')).toBe('23514 pilot_pathway_gate_criteria_kind_shape_check');
    expect(await criterion('bout_count', ', bout_min, bout_max', ', 5, 2')).toBe('23514 pilot_pathway_gate_criteria_bout_range_check');
    expect(await criterion('bout_count', ', bout_max', ', -1')).toBe('23514 pilot_pathway_gate_criteria_bout_range_check');
    // A gate_met criterion whose stage and kind name a different gate than its id.
    expect(await criterion('gate_met', ', ref_stage_key, ref_gate_kind, ref_gate_id', `, 'T1', 'entry', '${PGT(10)}'`))
      .toBe('23503 pilot_pathway_gate_criteria_ref_gate_match_fkey');
    expect(await criterion('text', ', criterion_text, polarity', `, 'x', 'maybe'`)).toBe('23514 pilot_pathway_gate_criteria_polarity_check');
    expect(await criterion('scorecard_min', ', scorecard_item_ids, min_score, contexts, combine', `, array['${SCI(10)}'], 3, array['live'], 'most'`))
      .toBe('23514 pilot_pathway_gate_criteria_combine_check');
    expect(await criterion('text', ', criterion_text', `, 'x'`)).toBe('ok');
    // One active criterion per place in a gate.
    expect(await attempt(
      `insert into pilot.pathway_gate_criteria (organization_id, criterion_id, gate_id, ordinal, kind, criterion_text)
       values ('gym_refuse', $1, $2, 2, 'text', 'y')`, [PGC(12), PGT(10)],
    )).toBe('23505 pilot_pathway_gate_criteria_one_active_ordinal');

    expect(await spec(6, 'live')).toBe('23514 pilot_scorecard_anchor_clip_specs_level_check');
    expect(await spec(3, 'contact')).toBe('23514 pilot_scorecard_anchor_clip_specs_context_check');
    expect(await attempt(
      `insert into pilot.scorecard_anchor_clip_specs (organization_id, anchor_spec_id, scorecard_item_id, level, context_class, status)
       values ('gym_refuse', $1, $2, 3, 'live', 'INFERRED')`, [ACS(12), SCI(99)],
    )).toBe('23503 pilot_scorecard_anchor_clip_specs_item_fkey');

    expect(await attempt(
      `insert into pilot.scorecard_score_caps (organization_id, cap_key, scale_key, max_score, applies_to, status)
       values ('gym_refuse', 'non_contact_rule', 'no_such_scale', 3, 'x', 'OBSERVED')`,
    )).toBe('23503 pilot_scorecard_score_caps_scale_fkey');
    expect(await attempt(
      `insert into pilot.scorecard_scales (organization_id, scale_key, min_level, max_level, level_anchors, status)
       values ('gym_refuse', 'backwards', 5, 1, '{}'::jsonb, 'REPORTED')`,
    )).toBe('23514 pilot_scorecard_scales_levels_check');
    expect(await attempt(
      `insert into pilot.scorecard_items (organization_id, scorecard_item_id, name, definition, scale, scale_key, status)
       values ('gym_refuse', $1, 'x', 'y', 'z', 'no_such_scale', 'REPORTED')`, [SCI(11)],
    )).toBe('23503 pilot_scorecard_items_scale_fkey');

    expect(await kpi('score_1_5', null)).toBe('23514 pilot_behavior_kpis_scoring_kind_check');
    expect(await kpi('count', '{"1": "a"}')).toBe('23514 pilot_behavior_kpis_anchors_check');
    expect(await kpi(null, '{"1": "a"}')).toBe('23514 pilot_behavior_kpis_anchors_check');
    expect(await kpi('three_level', '["a"]')).toBe('23514 pilot_behavior_kpis_anchors_check');
    expect(await kpi('count', null, 'room')).toBe('23503 pilot_behavior_kpis_list_fkey');
    expect(await attempt(
      `insert into pilot.behavior_kpi_lists (organization_id, list_key, title, source_doc, status) values ('gym_refuse', 'session', 'x', 'y', 'OBSERVED')`,
    )).toBe('23514 pilot_behavior_kpi_lists_key_check');

    const protocol = (extra: string, value: string) => attempt(
      `insert into pilot.assessment_protocols (organization_id, protocol_id, name, measure_kind, quality_measured, protocol_summary, ${extra})
       values ('gym_refuse', 'PP-T99', 'x', 'other', '', 'y', ${value})`,
    );
    expect(await protocol('status', `'MAYBE'`)).toBe('23514 pilot_assessment_protocols_status_check');
    expect(await protocol('field_labels', `'[]'::jsonb`)).toBe('23514 pilot_assessment_protocols_field_labels_check');
    expect(await protocol('evidence', `'"x"'::jsonb`)).toBe('23514 pilot_assessment_protocols_evidence_check');
  });

  it('keeps catalog rows: a delete is refused, a row retires, and removing the organization removes them all', async () => {
    await createGym('gym_keep');
    await insertScale('gym_keep');
    await insertGate('gym_keep', 20, 'Y1', 'entry');
    await insertItem('gym_keep', 20, 1);
    await client.query(
      `insert into pilot.pathway_gate_criteria (organization_id, criterion_id, gate_id, ordinal, kind, criterion_text) values ('gym_keep', $1, $2, 1, 'text', 'Age about 5 or older')`,
      [PGC(20), PGT(20)],
    );
    await client.query(
      `insert into pilot.scorecard_anchor_clip_specs (organization_id, anchor_spec_id, scorecard_item_id, level, context_class, status) values ('gym_keep', $1, $2, 2, 'live', 'INFERRED')`,
      [ACS(20), SCI(20)],
    );
    await client.query(
      `insert into pilot.scorecard_score_caps (organization_id, cap_key, scale_key, max_score, applies_to, status) values ('gym_keep', 'non_contact_rule', 'live_long_road', 3, 'x', 'OBSERVED')`,
    );
    await client.query(
      `insert into pilot.behavior_kpi_lists (organization_id, list_key, title, source_doc, status) values ('gym_keep', 'room', 'Room KPIs', 'DOC-027', 'REPORTED')`,
    );
    await client.query(
      `insert into pilot.behavior_kpis (organization_id, kpi_id, list_key, ordinal, name, status) values ('gym_keep', $1, 'room', 1, 'Clean exits.', 'REPORTED')`,
      [KPI(20)],
    );

    const keyOf: Record<string, string> = {
      pathway_gates: 'gate_id', pathway_gate_criteria: 'criterion_id', scorecard_scales: 'scale_key', scorecard_score_caps: 'cap_key',
      scorecard_items: 'scorecard_item_id', scorecard_anchor_clip_specs: 'anchor_spec_id', behavior_kpi_lists: 'list_key', behavior_kpis: 'kpi_id',
    };
    expect(Object.keys(keyOf).sort()).toEqual(CATALOG_TABLES.slice().sort());
    for (const table of CATALOG_TABLES) {
      const refused = await attempt(`delete from pilot.${table} where organization_id = 'gym_keep'`);
      expect([table, refused]).toEqual([table, '23001 PATHWAY_CATALOG_ROW_KEPT: retire a catalog row (active_flag false); never delete it']);
    }
    await client.query(`update pilot.pathway_gate_criteria set active_flag = false where organization_id = 'gym_keep'`);
    // The retired criterion keeps its ordinal; an active one may take the place.
    await client.query(
      `insert into pilot.pathway_gate_criteria (organization_id, criterion_id, gate_id, ordinal, kind, criterion_text) values ('gym_keep', $1, $2, 1, 'text', 'Age 5 or older')`,
      [PGC(21), PGT(20)],
    );

    await client.query(`delete from pilot.organization_memberships where organization_id = 'gym_keep'`);
    await client.query(`delete from pilot.accounts where organization_id = 'gym_keep'`);
    await client.query(`delete from pilot.organizations where organization_id = 'gym_keep'`);
    const { rows } = await client.query(
      `select sum(n)::int as n from (${CATALOG_TABLES.map((t) => `select count(*) as n from pilot.${t} where organization_id = 'gym_keep'`).join(' union all ')}) c`,
    );
    expect(rows[0].n).toBe(0);
  });
});
