// Training tracks (SCHEMA_PROPOSAL P17; lane FT1a), DATABASE half: the
// training_tracks migration applies; a training-tracks package (a track, its
// blocks and block sessions) validates, plans, dry-runs and applies; a change
// makes a new track version and a block a later file leaves out is kept only
// on the superseded version; jsonb and text[] cells round-trip unchanged
// through the shared versioned engine; a block session naming a template the
// organization does not have, or has withdrawn, is refused by name.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { applyImport } from './contentImport/apply';
import { runApply } from './contentImport/cli';
import { writeCsv } from './contentImport/csv';
import { hex14 } from './contentImport/ids';
import { type ImportPlan, planImport } from './contentImport/plan';
import { loadOfflineReferenceSets } from './contentImport/referenceSets';
import { validatePackage } from './contentImport/validate';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'training_tracks';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-training-tracks-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.join(WEB_DIR, 'scripts/pilot-apply-training-tracks-migration.mjs');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_training_tracks_migration.sql');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');


const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let applyMigrationTransaction: (c: Client, sql: string) => Promise<void>;

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

/** A gym and an organization admin of it with an active membership. */
async function createGym(organizationId: string): Promise<string> {
  const account = `admin@${organizationId}`;
  await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`, [organizationId]);
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, is_platform_owner, active_flag) values ($1, 'organization_admin', $2, false, true)`,
    [account, organizationId],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'organization_admin', true)`,
    [account, organizationId],
  );
  return account;
}

const ORG = '{{PPBF_ORG_ID}}';
const STAGES = 'pathway-catalog/seed_pathway_stages.csv';
const TEMPLATES = 'workout-templates/seed_workout_templates.csv';
const TRACKS = 'training-tracks/seed_training_tracks.csv';
const BLOCKS = 'training-tracks/seed_track_blocks.csv';
const SESSIONS = 'training-tracks/seed_track_block_sessions.csv';

// Ids in the backbone's shapes. A template id is MINT.template(name).
const T_A = `wtp_${hex14('Track Day A')}`;
const T_B = `wtp_${hex14('Track Day B')}`;
const TRACK = `trk_${hex14('fixture:track')}`;
const B1 = `trb_${hex14('fixture:block-1')}`;
const B2 = `trb_${hex14('fixture:block-2')}`;

// Written out of key order and with spaces, so the round trip proves the JSON
// is compared parsed and key-sorted, not as typed.
const DETAILS = '{"weekly_rhythm": {"Tuesday": "Stabilize", "Monday": "Focus"}, "primary_cue": "Get set first.", "week_titles": ["Week 1", "Week 2"]}';
// The comma in the second source is what a '|' list column refuses (addition A).
const SOURCES = '["DOC-123", "Jason 2026-10-24 (RULES s9, First class track)"]';
const TRACK_LABELS = '{"name": {"status": "OBSERVED", "sources": ["DOC-123"]}, "lane": {"status": "INFERRED", "sources": ["inference"]}}';
const EVIDENCE = '[{"evidence_category": "convention", "evidence_label": "CONVENTION", "check_state": "verified"}]';
const BLOCK_LABELS = '{"title": {"status": "OBSERVED", "sources": ["DOC-123"]}, "session_refs": {"status": "REPORTED", "sources": ["DOC-123"]}}';
const BLOCK_DETAILS = '{"optional_drill_refs": [{"note": "Optional punch introduction", "drill_id": "drl_44d4c0b52f4dbd"}], "description": "Week 1 holds position."}';

const STAGE_HEADER = ['organization_id', 'stage_key', 'segment', 'ordinal', 'name', 'contact_default', 'backbone_version'];
const TEMPLATE_HEADER = ['organization_id', 'template_id', 'name', 'session_type', 'difficulty', 'duration_minutes', 'intent'];
const TRACK_HEADER = [
  'organization_id', 'track_id', 'name', 'lane', 'track', 'duration_weeks', 'delivered_to_program_id', 'age_band', 'status', 'sources', 'details',
  'field_labels', 'evidence', 'stage_keys',
];
const BLOCK_HEADER = [
  'organization_id', 'track_block_id', 'block_lineage_id', 'track_id', 'block_order', 'title', 'weeks', 'status', 'sources', 'field_labels',
  'evidence', 'stage_keys', 'details',
];
const SESSION_HEADER = ['organization_id', 'block_session_id', 'track_id', 'block_order', 'ordinal', 'week', 'day', 'template_lineage_id'];

type Row = Record<string, string>;
const csv = (header: string[], rows: Row[]) => writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? '')));

const FT1_STAGE: Row = { organization_id: ORG, stage_key: 'FT1', segment: 'recreational', ordinal: '17', name: 'Fitness Track', contact_default: 'none', backbone_version: 'test' };
const template = (id: string, name: string): Row => ({
  organization_id: ORG, template_id: id, name, session_type: 'technical', difficulty: 'beginner', duration_minutes: '60', intent: `${name} intent`,
});
const TRACK_ROW: Row = {
  organization_id: ORG, track_id: TRACK, name: '8-Week Fixture Track', lane: 'standard', track: 'fitness', duration_weeks: '2', age_band: 'all ages',
  status: 'REPORTED', sources: SOURCES, details: DETAILS, field_labels: TRACK_LABELS, evidence: EVIDENCE, stage_keys: 'FT1',
};
const block = (id: string, blockOrder: string, extra: Row = {}): Row => ({
  organization_id: ORG, track_block_id: id, block_lineage_id: id, track_id: TRACK, block_order: blockOrder, title: `Week ${blockOrder}`, weeks: '1',
  status: 'REPORTED', sources: '["DOC-123"]', field_labels: BLOCK_LABELS, evidence: EVIDENCE, stage_keys: '["FT1"]', details: BLOCK_DETAILS, ...extra,
});
const session = (blockOrder: string, ordinal: string, day: string, templateId: string): Row => ({
  organization_id: ORG, track_id: TRACK, block_order: blockOrder, ordinal, week: blockOrder, day, template_lineage_id: templateId,
});
const SESSION_ROWS = [session('1', '1', 'Monday', T_A), session('1', '2', 'Wednesday', T_B), session('2', '1', 'Monday', T_A)];

function trackFiles(track: Row[], blocks: Row[], sessions: Row[]): Record<string, string> {
  return { [TRACKS]: csv(TRACK_HEADER, track), [BLOCKS]: csv(BLOCK_HEADER, blocks), [SESSIONS]: csv(SESSION_HEADER, sessions) };
}

/** The fixture track: 2 blocks, 3 block sessions. */
const TRACK_FILES = () => trackFiles([TRACK_ROW], [block(B1, '1'), block(B2, '2')], SESSION_ROWS);
/** What the track needs loaded first: the FT1 stage (its stage_keys) and the two templates its sessions name. */
const PREREQUISITES = () => ({
  [STAGES]: csv(STAGE_HEADER, [FT1_STAGE]),
  [TEMPLATES]: csv(TEMPLATE_HEADER, [template(T_A, 'Track Day A'), template(T_B, 'Track Day B')]),
});

async function plan(organizationId: string, actor: string, files: Record<string, string>): Promise<ImportPlan> {
  return planImport({ client, organizationId, actorAccountId: actor, files });
}

async function load(organizationId: string, actor: string, files: Record<string, string>) {
  const shown = await plan(organizationId, actor, files);
  expect(shown.blocking).toEqual([]);
  await client.query('BEGIN');
  try {
    const result = await applyImport({ client, organizationId, actorAccountId: actor, files, expectedPlanHash: shown.planHash });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function outcomes(result: ImportPlan, dataset = 'training-tracks'): Record<string, string> {
  return Object.fromEntries(result.units.filter((unit) => unit.dataset === dataset).map((unit) => [unit.key, unit.outcome]));
}

const codes = (result: ImportPlan) => result.blocking.map((finding) => `${finding.code} ${finding.column ?? ''} ${finding.message}`);

async function rows(sql: string, organizationId: string) {
  return (await client.query(sql, [organizationId])).rows;
}

const trackRows = (org: string) => rows(
  `select track_id, lineage_id, version, supersedes_track_id, superseded_at is not null as superseded, active, name, lane, track, duration_weeks,
          delivered_to_program_id, age_band, status, sources, details, created_by_role
     from pilot.training_tracks where organization_id = $1 order by version`,
  org,
);
const blockRows = (org: string) => rows(
  `select b.track_id, t.version, b.track_block_id, b.block_lineage_id, b.block_order, b.title, b.weeks, b.status, b.sources, b.field_labels,
          b.evidence, b.stage_keys, b.details
     from pilot.track_blocks b join pilot.training_tracks t using (organization_id, track_id)
    where b.organization_id = $1 order by t.version, b.block_order`,
  org,
);
const sessionRows = (org: string) => rows(
  `select t.version, s.block_session_id, s.block_order, s.ordinal, s.week, s.day, s.template_lineage_id
     from pilot.track_block_sessions s join pilot.training_tracks t using (organization_id, track_id)
    where s.organization_id = $1 order by t.version, s.block_order, s.ordinal`,
  org,
);

const offline = (files: Record<string, string>) => validatePackage(
  Object.entries(files).map(([file, text]) => ({ path: file, text })),
  { references: loadOfflineReferenceSets(SEED_DATA_DIR) },
).blocking.map((finding) => `${finding.code} ${finding.column ?? ''} ${finding.message}`);

// ---------------------------------------------------------------------------

describe('the training_tracks migration', () => {
  it('is in the schema, and its runner re-applies it and passes its own readiness check', async () => {
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');
    await applyMigrationTransaction(client, sql);
    await applyMigrationTransaction(client, sql);
    const tables = await client.query(
      `select table_name from information_schema.tables
        where table_schema = 'pilot' and table_name in ('training_tracks', 'track_blocks', 'track_block_sessions') order by 1`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(['track_block_sessions', 'track_blocks', 'training_tracks']);
  });

  it('readiness refuses an environment missing a piece, and the next full run restores it', async () => {
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');
    await client.query('drop index pilot.pilot_training_tracks_one_head_per_lineage');
    const withoutIndex = sql.replace(/create unique index if not exists pilot_training_tracks_one_head_per_lineage[\s\S]*?;\n/, '');
    expect(withoutIndex).not.toBe(sql);
    await expect(applyMigrationTransaction(client, withoutIndex)).rejects.toThrow('TRAINING_TRACKS_NOT_READY');
    await applyMigrationTransaction(client, sql);
    const index = await client.query(`select to_regclass('pilot.pilot_training_tracks_one_head_per_lineage') is not null as present`);
    expect(index.rows[0].present).toBe(true);
  });

  it('refuses what the tables refuse, and an organization delete takes all three', async () => {
    const gym = 'gym_tt_db';
    await createGym(gym);
    const track = (id: string, extra = '') => client.query(
      `insert into pilot.training_tracks (organization_id, track_id, lineage_id, name, lane, status${extra ? ', track' : ''})
       values ($1, $2, $2, 'T', 'standard', 'REPORTED'${extra ? `, '${extra}'` : ''})`,
      [gym, id],
    );
    await track(TRACK);
    await expect(track(`trk_${hex14('bad-track-kind')}`, 'boxing')).rejects.toMatchObject({ code: '23514', constraint: 'pilot_training_tracks_track_check' });
    await expect(client.query(
      `insert into pilot.training_tracks (organization_id, track_id, lineage_id, name, lane, status) values ($1, 'trk_x', 'trk_x', 'T', 'standard', 'REPORTED')`,
      [gym],
    )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_training_tracks_id_check' });
    await expect(client.query(
      `insert into pilot.training_tracks (organization_id, track_id, lineage_id, name, lane, status) values ($1, $2, $2, 'T', 'standard', 'CHECKED')`,
      [gym, `trk_${hex14('bad-status')}`],
    )).rejects.toMatchObject({ code: '23514', constraint: 'pilot_training_tracks_status_check' });
    // A second current version of one lineage.
    await expect(client.query(
      `insert into pilot.training_tracks (organization_id, track_id, lineage_id, version, name, lane, status) values ($1, $2, $3, 2, 'T', 'standard', 'REPORTED')`,
      [gym, `trk_${hex14('second-head')}`, TRACK],
    )).rejects.toMatchObject({ code: '23505', constraint: 'pilot_training_tracks_one_head_per_lineage' });

    await client.query(
      `insert into pilot.track_blocks (organization_id, track_block_id, block_lineage_id, track_id, block_order, status) values ($1, $2, $2, $3, 1, 'REPORTED')`,
      [gym, B1, TRACK],
    );
    const sessionInsert = (blockOrder: number, day: string, templateId = T_A) => client.query(
      `insert into pilot.track_block_sessions (organization_id, block_session_id, track_id, block_order, ordinal, week, day, template_lineage_id)
       values ($1, $2, $3, $4, 1, 1, $5, $6)`,
      [gym, `tbs_${hex14(`${blockOrder}:${day}:${templateId}`)}`, TRACK, blockOrder, day, templateId],
    );
    await expect(sessionInsert(2, 'Monday')).rejects.toMatchObject({ code: '23503', constraint: 'pilot_track_block_sessions_block_fkey' });
    // day is stored as written; only a blank is refused.
    await expect(sessionInsert(1, ' \t')).rejects.toMatchObject({ code: '23514', constraint: 'pilot_track_block_sessions_day_check' });
    await expect(sessionInsert(1, 'Monday', 'not-a-template')).rejects.toMatchObject({ code: '23514', constraint: 'pilot_track_block_sessions_template_check' });
    await sessionInsert(1, '1 (bout day)');

    await client.query('delete from pilot.organization_memberships where organization_id = $1', [gym]);
    await client.query('delete from pilot.accounts where organization_id = $1', [gym]);
    await client.query('delete from pilot.organizations where organization_id = $1', [gym]);
    const left = await client.query(
      `select (select count(*) from pilot.training_tracks where organization_id = $1)
            + (select count(*) from pilot.track_blocks where organization_id = $1)
            + (select count(*) from pilot.track_block_sessions where organization_id = $1) as n`,
      [gym],
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });
});

describe('a training-tracks package: 1 track, 2 blocks, 3 block sessions', () => {
  const GYM = 'gym_tt';
  let admin: string;

  beforeAll(async () => {
    admin = await createGym(GYM);
  });

  it('validates offline with the templates it names in the same package', () => {
    expect(offline({ ...PREREQUISITES(), ...TRACK_FILES() })).toEqual([]);
  });

  it('refuses malformed rows offline, each by name', () => {
    const findings = offline({
      ...PREREQUISITES(),
      ...trackFiles(
        [{ ...TRACK_ROW, sources: 'DOC-123|Jason 2026-10-24 (RULES s9, First class track)', details: '["not", "an object"]', lane: 'contact' }],
        [block(B1, '1', { block_lineage_id: B2, field_labels: '{"title": {"status": "CHECKED"}}', stage_keys: 'FT1' }), block('trb_short', '2')],
        [session('1', '1', '', T_A), session('2', '1', 'Monday', `wtp_${hex14('nowhere')}`)],
      ),
    });
    expect(findings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^unknown_value lane 'contact' is not allowed/),
      expect.stringMatching(/^row_rule {2}sources is not readable JSON/),
      expect.stringMatching(/^row_rule {2}details must be a JSON object/),
      expect.stringMatching(new RegExp(`^row_rule {2}track_block_id '${B1}' and block_lineage_id '${B2}' differ`)),
      expect.stringMatching(/^row_rule {2}field_labels status title.status is "CHECKED"/),
      expect.stringMatching(/^row_rule {2}stage_keys is not readable JSON/),
      expect.stringMatching(/^row_rule {2}track_block_id 'trb_short' is not 'trb_' and 14 lowercase hex/),
      expect.stringMatching(/^row_rule {2}block_lineage_id 'trb_short' is not 'trb_' and 14 lowercase hex/),
      expect.stringMatching(/^missing_required day day is required/),
      expect.stringMatching(new RegExp(`^orphan_reference template_lineage_id template 'wtp_${hex14('nowhere')}' is in neither`)),
    ]));
    expect(findings).toHaveLength(10);
  });

  it('plans all new, and the dry run lists every unit and writes nothing', async () => {
    const files = { ...PREREQUISITES(), ...TRACK_FILES() };
    const shown = await plan(GYM, admin, files);
    expect(shown.blocking).toEqual([]);
    expect(outcomes(shown)).toEqual({ [TRACK]: 'new' });
    expect(outcomes(shown, 'workout-templates')).toEqual({ [T_A]: 'new', [T_B]: 'new' });

    const dir = mkdtempSync(path.join(os.tmpdir(), 'ppbf-training-tracks-seed-'));
    try {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
        writeFileSync(path.join(dir, name), text);
      }
      const lines: string[] = [];
      const code = await runApply(
        { client, organizationId: GYM, actorAccountId: admin, seedDataDir: dir, datasets: ['pathway-catalog', 'workout-templates', 'training-tracks'], dryRun: true },
        { log: (line) => lines.push(line) },
      );
      const out = lines.join('\n');
      expect(code).toBe(0);
      expect(out).toContain('training-tracks: 1 new');
      expect(out).toContain('RESULT: DRY RUN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await trackRows(GYM)).toEqual([]);
  });

  it('applies: the track, its blocks and sessions under the backbone ids, its labels beside it; JSON and text[] stored whole', async () => {
    const result = await load(GYM, admin, { ...PREREQUISITES(), ...TRACK_FILES() });
    expect(result.written['training-tracks']?.inserted).toEqual([TRACK, `labels ${TRACK} v1`, `stage link ${TRACK} FT1`]);
    expect(await trackRows(GYM)).toEqual([{
      track_id: TRACK, lineage_id: TRACK, version: 1, supersedes_track_id: null, superseded: false, active: true, name: '8-Week Fixture Track',
      lane: 'standard', track: 'fitness', duration_weeks: 2, delivered_to_program_id: null, age_band: 'all ages', status: 'REPORTED',
      sources: ['DOC-123', 'Jason 2026-10-24 (RULES s9, First class track)'], details: JSON.parse(DETAILS), created_by_role: 'organization_admin',
    }]);
    const blocks = await blockRows(GYM);
    expect(blocks.map((row) => [row.track_block_id, row.block_lineage_id, row.block_order])).toEqual([[B1, B1, 1], [B2, B2, 2]]);
    expect(blocks[0]).toMatchObject({
      sources: ['DOC-123'], field_labels: JSON.parse(BLOCK_LABELS), evidence: JSON.parse(EVIDENCE), stage_keys: ['FT1'], details: JSON.parse(BLOCK_DETAILS),
    });
    expect((await sessionRows(GYM)).map((row) => [row.block_order, row.ordinal, row.week, row.day, row.template_lineage_id])).toEqual([
      [1, 1, 1, 'Monday', T_A],
      [1, 2, 1, 'Wednesday', T_B],
      [2, 1, 2, 'Monday', T_A],
    ]);
    expect((await sessionRows(GYM)).every((row) => /^tbs_[0-9a-f]{14}$/.test(row.block_session_id))).toBe(true);

    expect(await rows(
      `select target_lineage_id, target_version, field_labels, evidence from pilot.content_record_labels
        where organization_id = $1 and target_kind = 'training_track'`,
      GYM,
    )).toEqual([{ target_lineage_id: TRACK, target_version: 1, field_labels: JSON.parse(TRACK_LABELS), evidence: JSON.parse(EVIDENCE) }]);
    expect(await rows(
      `select stage_key from pilot.content_stage_links where organization_id = $1 and target_kind = 'training_track' and superseded_at is null`,
      GYM,
    )).toEqual([{ stage_key: 'FT1' }]);
  });

  it('re-plans the same package unchanged: details, sources and block labels round-trip (jsonb and text[])', async () => {
    const again = await plan(GYM, admin, { ...PREREQUISITES(), ...TRACK_FILES() });
    expect(again.blocking).toEqual([]);
    expect(outcomes(again)).toEqual({ [TRACK]: 'unchanged' });
    // The same content written in another key order and spacing is the same content.
    const respaced = trackFiles(
      [{ ...TRACK_ROW, details: JSON.stringify(JSON.parse(DETAILS)), sources: JSON.stringify(JSON.parse(SOURCES)) }],
      [block(B1, '1', { details: JSON.stringify(JSON.parse(BLOCK_DETAILS), null, 1) }), block(B2, '2')],
      SESSION_ROWS,
    );
    expect(outcomes(await plan(GYM, admin, respaced))).toEqual({ [TRACK]: 'unchanged' });
  });

  it('one changed key inside details makes v2: v1 superseded and kept whole, blocks and sessions re-minted, block lineage kept', async () => {
    const details = DETAILS.replace('"Get set first."', '"Get set, then move."');
    const files = trackFiles([{ ...TRACK_ROW, details }], [block(B1, '1'), block(B2, '2')], SESSION_ROWS);
    const shown = await plan(GYM, admin, files);
    expect(shown.blocking).toEqual([]);
    expect(outcomes(shown)).toEqual({ [TRACK]: 'new_version' });
    await load(GYM, admin, files);

    const tracks = await trackRows(GYM);
    const v2 = `trk_${hex14(`${TRACK}#v2`)}`;
    expect(tracks.map((row) => [row.track_id, row.version, row.superseded, row.active, row.supersedes_track_id])).toEqual([
      [TRACK, 1, true, false, null],
      [v2, 2, false, true, TRACK],
    ]);
    expect(tracks[0].details.primary_cue).toBe('Get set first.');
    expect(tracks[1].details.primary_cue).toBe('Get set, then move.');

    const blocks = await blockRows(GYM);
    expect(blocks.map((row) => [row.version, row.track_block_id === row.block_lineage_id, row.block_lineage_id, row.block_order])).toEqual([
      [1, true, B1, 1],
      [1, true, B2, 2],
      [2, false, B1, 1],
      [2, false, B2, 2],
    ]);
    const sessions = await sessionRows(GYM);
    expect(sessions.filter((row) => row.version === 2)).toHaveLength(3);
    expect(new Set(sessions.map((row) => row.block_session_id)).size).toBe(6);
    // v2's labels are written with it; the stage link is by lineage and stays.
    expect((await rows(
      `select target_version from pilot.content_record_labels where organization_id = $1 and target_kind = 'training_track' order by 1`,
      GYM,
    )).map((row) => row.target_version)).toEqual([1, 2]);
    expect(outcomes(await plan(GYM, admin, files))).toEqual({ [TRACK]: 'unchanged' });
  });

  it('a block a later file leaves out: absent from the new version, kept on the superseded version\'s rows', async () => {
    const details = DETAILS.replace('"Get set first."', '"Get set, then move."');
    const files = trackFiles([{ ...TRACK_ROW, details }], [block(B1, '1')], SESSION_ROWS.filter((row) => row.block_order === '1'));
    expect(outcomes(await plan(GYM, admin, files))).toEqual({ [TRACK]: 'new_version' });
    await load(GYM, admin, files);

    const blocks = await blockRows(GYM);
    expect(blocks.filter((row) => row.version === 3).map((row) => row.block_lineage_id)).toEqual([B1]);
    expect(blocks.filter((row) => row.version === 2).map((row) => row.block_lineage_id)).toEqual([B1, B2]);
    const sessions = await sessionRows(GYM);
    expect(sessions.filter((row) => row.version === 3).map((row) => [row.block_order, row.ordinal])).toEqual([[1, 1], [1, 2]]);
    expect(sessions.filter((row) => row.version === 2).map((row) => [row.block_order, row.ordinal])).toEqual([[1, 1], [1, 2], [2, 1]]);
    expect((await trackRows(GYM)).map((row) => [row.version, row.superseded, row.active])).toEqual([
      [1, true, false],
      [2, true, false],
      [3, false, true],
    ]);
  });
});

describe('refused at plan, by name', () => {
  const GYM = 'gym_tt_refuse';
  let admin: string;

  beforeAll(async () => {
    admin = await createGym(GYM);
    await load(GYM, admin, PREREQUISITES());
  });

  it('a block session naming a template the organization does not have', async () => {
    const missing = `wtp_${hex14('Never Loaded')}`;
    const shown = await plan(GYM, admin, trackFiles([TRACK_ROW], [block(B1, '1')], [session('1', '1', 'Monday', missing)]));
    expect(codes(shown)).toEqual([
      expect.stringMatching(new RegExp(`^orphan_reference template_lineage_id template '${missing}' is in neither`)),
    ]);
    expect(outcomes(shown)).toEqual({ [TRACK]: 'reject' });
  });

  it('a block session naming a template whose current version is withdrawn', async () => {
    await client.query(`update pilot.workout_templates set active = false where organization_id = $1 and lineage_id = $2`, [GYM, T_B]);
    try {
      const shown = await plan(GYM, admin, TRACK_FILES());
      expect(codes(shown)).toEqual([
        `withdrawn_template template_lineage_id track ${TRACK} block 1 session 2 names template ${T_B}, whose current version in ${GYM} is withdrawn. Name an active template, or restore it first.`,
      ]);
      expect(shown.blocking[0].line).toBe(3);
      expect(outcomes(shown)).toEqual({ [TRACK]: 'reject' });
    } finally {
      await client.query(`update pilot.workout_templates set active = true where organization_id = $1 and lineage_id = $2`, [GYM, T_B]);
    }
    expect((await plan(GYM, admin, TRACK_FILES())).blocking).toEqual([]);
  });

  it('a block session naming a block_order its track has no block for', async () => {
    const shown = await plan(GYM, admin, trackFiles([TRACK_ROW], [block(B1, '1')], [session('1', '1', 'Monday', T_A), session('2', '1', 'Monday', T_A)]));
    expect(codes(shown)).toEqual([
      `orphan_reference block_order track ${TRACK} block 2 session 1 names block_order 2, which ${TRACK} has no block for`,
    ]);
  });

  it('rows of a track that is neither in the package nor loaded', async () => {
    const files = trackFiles([], [block(B1, '1')], []);
    delete files[TRACKS];
    delete files[SESSIONS];
    const shown = await plan(GYM, admin, files);
    expect(codes(shown)).toEqual([
      `orphan_reference track_id track ${TRACK} has rows in seed_track_blocks.csv or seed_track_block_sessions.csv but is neither in this package nor loaded in ${GYM}`,
    ]);
  });
});

describe('JSON cells: blanks, and what the database could not store as written', () => {
  const GYM = 'gym_tt_blank';
  let admin: string;

  beforeAll(async () => {
    admin = await createGym(GYM);
    await load(GYM, admin, PREREQUISITES());
  });

  it('blank sources, details and block labels load as their defaults and re-plan unchanged', async () => {
    const files = trackFiles(
      [{ ...TRACK_ROW, sources: '', details: '' }],
      [block(B1, '1', { sources: '', field_labels: '', evidence: '', stage_keys: '', details: '' })],
      [session('1', '1', 'Monday', T_A)],
    );
    await load(GYM, admin, files);
    expect((await trackRows(GYM)).map((row) => [row.sources, row.details])).toEqual([[[], {}]]);
    expect((await blockRows(GYM)).map((row) => [row.sources, row.field_labels, row.evidence, row.stage_keys, row.details])).toEqual([
      [[], null, null, [], {}],
    ]);
    expect(outcomes(await plan(GYM, admin, files))).toEqual({ [TRACK]: 'unchanged' });
    // A blank and its default written out are the same content.
    const explicit = trackFiles(
      [{ ...TRACK_ROW, sources: '[]', details: '{}' }],
      [block(B1, '1', { sources: '[]', field_labels: '', evidence: '', stage_keys: '[]', details: '{}' })],
      [session('1', '1', 'Monday', T_A)],
    );
    expect(outcomes(await plan(GYM, admin, explicit))).toEqual({ [TRACK]: 'unchanged' });
  });

  it('refuses offline, by name, a whole number past 2^53 and the NUL character', () => {
    const findings = offline({
      ...PREREQUISITES(),
      ...trackFiles(
        [{ ...TRACK_ROW, details: '{"week_titles": ["Week 1"], "count": 12345678901234567890}', sources: '["DOC-123", "bad\\u0000source"]' }],
        [block(B1, '1', { evidence: '[{"evidence_label": "CONVENTION", "note": "a\\u0000b"}]' })],
        [session('1', '1', 'Monday', T_A)],
      ),
    });
    expect(findings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^row_rule {2}sources cannot be stored as written: \[1\] holds the NUL character/),
      expect.stringMatching(/^row_rule {2}details cannot be stored as written: count is a whole number too large to keep exactly/),
      expect.stringMatching(/^row_rule {2}evidence cannot be stored as written: \[0\]\.note holds the NUL character/),
    ]));
    expect(findings).toHaveLength(3);
  });
});

describe('readiness: every clause it asserts is one a broken environment fails', () => {
  const breakages: [string, string][] = [
    ['a named check', 'alter table pilot.track_blocks drop constraint pilot_track_blocks_weeks_check'],
    ['a session check', 'alter table pilot.track_block_sessions drop constraint pilot_track_block_sessions_week_check'],
    ['a primary key', 'alter table pilot.track_block_sessions drop constraint pilot_track_block_sessions_pkey'],
    [
      "one table's organization cascade",
      `alter table pilot.track_blocks drop constraint track_blocks_organization_id_fkey;
       alter table pilot.track_blocks add constraint track_blocks_organization_id_fkey
         foreign key (organization_id) references pilot.organizations(organization_id)`,
    ],
    [
      'a text[] column the engine writes by type',
      `alter table pilot.track_blocks alter column stage_keys drop default;
       alter table pilot.track_blocks alter column stage_keys type text using array_to_string(stage_keys, '|')`,
    ],
    [
      'a jsonb column the engine writes by type',
      // The named check is put back on the text column, so only the type clause can fail.
      `alter table pilot.training_tracks drop constraint pilot_training_tracks_details_check,
         alter column details drop default, alter column details type text using details::text,
         add constraint pilot_training_tracks_details_check check (details is not null)`,
    ],
  ];

  it.each(breakages)('%s', async (_what, breakage) => {
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');
    // The runner opens its own transaction; inside this one, its ROLLBACK
    // also undoes the breakage, so the next case starts from a whole schema.
    await client.query('BEGIN');
    try {
      await client.query(breakage);
      await expect(applyMigrationTransaction(client, sql)).rejects.toThrow('TRAINING_TRACKS_NOT_READY');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
    await applyMigrationTransaction(client, sql);
  });
});

describe('a revision carried from the stored version', () => {
  const GYM = 'gym_tt_rev';
  let admin: string;

  beforeAll(async () => {
    admin = await createGym(GYM);
    await load(GYM, admin, { ...PREREQUISITES(), ...TRACK_FILES() });
  });

  it('a sessions file alone revises the track against its stored blocks; a session naming a block it lacks is refused by name', async () => {
    const more = { [SESSIONS]: csv(SESSION_HEADER, [...SESSION_ROWS, session('2', '2', 'Friday', T_B)]) };
    expect(outcomes(await plan(GYM, admin, more))).toEqual({ [TRACK]: 'new_version' });
    const orphan = { [SESSIONS]: csv(SESSION_HEADER, [...SESSION_ROWS, session('3', '1', 'Friday', T_B)]) };
    expect(codes(await plan(GYM, admin, orphan))).toEqual([
      `orphan_reference block_order track ${TRACK} block 3 session 1 names block_order 3, which ${TRACK} has no block for`,
    ]);
  });

  it('a blocks file alone that drops a block the stored sessions use is refused by name, at the stored rows', async () => {
    const shown = await plan(GYM, admin, { [BLOCKS]: csv(BLOCK_HEADER, [block(B1, '1')]) });
    expect(shown.blocking.map((finding) => [finding.code, finding.file, finding.message])).toEqual([
      [
        'orphan_reference',
        `database:pilot.track_block_sessions (track ${TRACK} v1)`,
        `track ${TRACK} block 2 session 1 names block_order 2, which ${TRACK} has no block for`,
      ],
    ]);
  });

  it('a stored session naming a template since withdrawn is refused when the track is revised', async () => {
    await client.query(`update pilot.workout_templates set active = false where organization_id = $1 and lineage_id = $2`, [GYM, T_B]);
    try {
      const shown = await plan(GYM, admin, { [BLOCKS]: csv(BLOCK_HEADER, [block(B1, '1', { title: 'Week 1, revised' }), block(B2, '2')]) });
      expect(codes(shown)).toEqual([
        `withdrawn_template template_lineage_id track ${TRACK} block 1 session 2 names template ${T_B}, whose current version in ${GYM} is withdrawn. Name an active template, or restore it first.`,
      ]);
    } finally {
      await client.query(`update pilot.workout_templates set active = true where organization_id = $1 and lineage_id = $2`, [GYM, T_B]);
    }
  });

  it("'1' and '1.0' are one block_order: refused by name at plan, not at the database", async () => {
    const shown = await plan(GYM, admin, trackFiles([TRACK_ROW], [block(B1, '1'), block(B2, '1.0')], SESSION_ROWS.filter((row) => row.block_order === '1')));
    expect(codes(shown)).toEqual(expect.arrayContaining([`duplicate_key block_order track ${TRACK} has two blocks at block_order 1`]));
  });

  it('an integer past the database integer is refused offline, by name', () => {
    expect(offline({ ...PREREQUISITES(), ...trackFiles([TRACK_ROW], [block(B1, '1')], [{ ...session('1', '1', 'Monday', T_A), week: '3000000000' }]) }))
      .toEqual([expect.stringMatching(/^row_rule {2}week 3000000000 is above 2147483647/)]);
  });
});
