// The backbone label columns (SCHEMA_PROPOSAL P19; lane BB-1a), DATABASE
// half: the content_labels migration applies, and the content-import engines
// write a package's field_labels, evidence and stage_keys into
// pilot.content_record_labels and pilot.content_stage_links -- and read them
// back, so the same package plans `unchanged` the next time.
// contentImportLabels.test.ts is the offline half (validator, hash).
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
import { readDatasetFiles, runApply } from './contentImport/cli';
import { readCsv, writeCsv } from './contentImport/csv';
import { type ImportPlan, planImport } from './contentImport/plan';
import { claimIdsFromChunksCsv, LOADED_RESEARCH_CHUNKS } from './contentImport/referenceSets';
import { STAGE_KEYS } from './contentImport/types';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'content_labels';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-content-labels-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.join(WEB_DIR, 'scripts/pilot-apply-content-labels-migration.mjs');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_content_labels_migration.sql');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');

const DISCIPLINES = 'multidiscipline/seed_disciplines.csv';
const DRILLS = 'drill-library/seed_drill_library.csv';
const CUES = 'drill-library/seed_drill_cues.csv';
const TEMPLATES = 'workout-templates/seed_workout_templates.csv';

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
  await loadPlatformClaims();
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
  // The 18 backbone stages: content_stage_links.stage_key references the
  // organization's pathway catalog (pathway_catalog migration, lane BB-1b).
  await client.query(
    `insert into pilot.pathway_stages (organization_id, stage_key, segment, ordinal, name, contact_default)
     select $1, key, case substring(key from '^[A-Z]+') when 'Y' then 'youth' when 'T' then 'trunk' when 'AM' then 'amateur'
                     when 'PR' then 'pro' when 'EX' then 'exit' else 'recreational' end,
            ordinal::int, key, 'none'
       from unnest($2::text[]) with ordinality as stage(key, ordinal)`,
    [organizationId, [...STAGE_KEYS]],
  );
  return account;
}

/** The LOADED research claims as __platform__ chunks, which the drill package cites. */
async function loadPlatformClaims(): Promise<void> {
  const ids = [...claimIdsFromChunksCsv(await fs.readFile(path.join(SEED_DATA_DIR, LOADED_RESEARCH_CHUNKS), 'utf8'))];
  await client.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, url, rights_status)
     values ('src_labels_test', '__platform__', 'Loaded research claims (test)', 'peer_reviewed', 1, 'https://example.org/labels-test', 'ppbf_owned')`,
  );
  await client.query(
    `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name, content_sha256)
     values ('doc_labels_test', 'src_labels_test', '__platform__', 'Loaded research claims (test)', 'labels-test')`,
  );
  await client.query(
    `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content, metadata)
     select 'chunk_' || claim_id, 'doc_labels_test', 'src_labels_test', '__platform__', ordinal::int, 'Claim ' || claim_id,
            jsonb_build_object('claim_id', claim_id)
       from unnest($1::text[]) with ordinality as claim(claim_id, ordinal)`,
    [ids],
  );
}

const FIELD_LABELS = JSON.stringify({
  display_name: { status: 'OBSERVED', sources: ['DOC-027'] },
  evidence_note: { status: 'REPORTED', sources: ['LR-114'], placement: { status: 'INFERRED', sources: [] } },
});
const EVIDENCE = JSON.stringify([
  { evidence_category: 'convention', evidence_label: 'CONVENTION', check_state: 'unchecked', evidence_item_ids: [], registry_claim_ids: [], basis: 'coaching practice', source_note: 'Long Road practice' },
]);

/**
 * The committed files as a package WITHOUT the label columns: the FT1 drills now carry labels in the
 * committed drill file (lane FT1b), so the three columns are taken out of every file that has them.
 */
function stripLabelColumns(files: Record<string, string>): Record<string, string> {
  const labelColumns = ['field_labels', 'evidence', 'stage_keys'];
  return Object.fromEntries(Object.entries(files).map(([name, text]) => {
    const table = readCsv(text);
    if (!table.header.some((column) => labelColumns.includes(column)) || name.startsWith('pathway-catalog/')) return [name, text];
    const keep = table.header.map((column, index) => (labelColumns.includes(column) ? -1 : index)).filter((index) => index >= 0);
    return [name, writeCsv(keep.map((index) => table.header[index]), table.records.map((record) => keep.map((index) => record.cells[index] ?? '')))];
  }));
}

function committed(): Record<string, string> {
  return stripLabelColumns(readDatasetFiles(SEED_DATA_DIR, ['disciplines', 'pathway-catalog', 'drill-library']));
}

/** A file with the label columns added to its header and set on the rows `labels` names (by key column). */
function withLabels(text: string, keyColumn: string, labels: Record<string, Record<string, string>>): string {
  const table = readCsv(text);
  const header = [...table.header, ...['field_labels', 'evidence', 'stage_keys'].filter((name) => !table.header.includes(name))];
  const rows = table.records.map((record) => {
    const row: Record<string, string> = Object.fromEntries(table.header.map((name, index) => [name, record.cells[index] ?? '']));
    Object.assign(row, labels[row[keyColumn]] ?? {});
    return header.map((name) => row[name] ?? '');
  });
  return writeCsv(header, rows);
}

function firstKey(text: string, keyColumn: string): string {
  const table = readCsv(text);
  return table.records[0].cells[table.header.indexOf(keyColumn)];
}

async function plan(organizationId: string, actor: string, files: Record<string, string>): Promise<ImportPlan> {
  return planImport({ client, organizationId, actorAccountId: actor, files });
}

async function applyCommitted(organizationId: string, actor: string, files: Record<string, string>) {
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

async function labelRows(organizationId: string) {
  const { rows } = await client.query(
    `select target_kind, target_lineage_id, target_version, field_labels, evidence, backbone_version
       from pilot.content_record_labels where organization_id = $1 order by target_kind, target_lineage_id, target_version`,
    [organizationId],
  );
  return rows;
}

async function linkRows(organizationId: string) {
  const { rows } = await client.query(
    `select target_kind, target_lineage_id, stage_key, role, lane, superseded_at is not null as ended, superseded_by_import_id
       from pilot.content_stage_links where organization_id = $1 order by target_kind, target_lineage_id, stage_key, link_id`,
    [organizationId],
  );
  return rows;
}

function outcomes(result: ImportPlan): Record<string, number> {
  return Object.fromEntries(Object.entries(result.totals).filter(([, count]) => count > 0));
}

// ---------------------------------------------------------------------------

describe('the content_labels migration', () => {
  it('is in the schema, and its runner re-applies it and passes its own readiness check', async () => {
    await expect(applyMigrationTransaction(client, await fs.readFile(MIGRATION_PATH, 'utf8'))).resolves.toBeUndefined();
    const { rows } = await client.query(
      `select to_regclass('pilot.content_record_labels') is not null as labels, to_regclass('pilot.content_stage_links') is not null as links`,
    );
    expect(rows[0]).toEqual({ labels: true, links: true });
  });

  it('refuses a stage key outside the catalog and a label row with nothing in it; role is free text, written NULL by the engine', async () => {
    await createGym('gym_checks');
    const link = (stage: string, role: string | null) => client.query(
      `insert into pilot.content_stage_links (organization_id, target_kind, target_lineage_id, stage_key, role, import_id, recorded_by_account_id, recorded_by_role)
       values ('gym_checks', 'drill', 'drl_00000000000000', $1, $2, 'imp_test', 'admin@gym_checks', 'organization_admin')`,
      [stage, role],
    );
    // A foreign key to the pathway catalog since lane BB-1b (was the 18-key CHECK).
    await expect(link('T3', null)).rejects.toMatchObject({ code: '23503' });
    await expect(link('T1', 'core')).resolves.toBeDefined();
    await expect(link('T1', null)).rejects.toMatchObject({ code: '23505' }); // one current link per item and stage
    await expect(client.query(
      `insert into pilot.content_record_labels (organization_id, target_kind, target_lineage_id, target_version, import_id, recorded_by_account_id, recorded_by_role)
       values ('gym_checks', 'drill', 'drl_00000000000000', 1, 'imp_test', 'admin@gym_checks', 'organization_admin')`,
    )).rejects.toMatchObject({ code: '23514' });
  });
});

describe('a package with the label columns', () => {
  const ORG = 'gym_labels';
  let admin: string;
  let drillKey: string;

  beforeAll(async () => {
    admin = await createGym(ORG);
    drillKey = firstKey(committed()[DRILLS], 'drill_id');
  });

  it('a package WITHOUT the columns loads as before: nothing in either label table, and a re-plan is all unchanged', async () => {
    await applyCommitted(ORG, admin, committed());
    expect(await labelRows(ORG)).toEqual([]);
    expect(await linkRows(ORG)).toEqual([]);
    const again = await plan(ORG, admin, committed());
    expect(again.blocking).toEqual([]);
    expect(again.changes).toBe(0);
  });

  function labelled(boxingStages: string, drillStages: string): Record<string, string> {
    const files = committed();
    return {
      ...files,
      [DISCIPLINES]: withLabels(files[DISCIPLINES], 'discipline', {
        boxing: { field_labels: FIELD_LABELS, evidence: EVIDENCE, stage_keys: boxingStages },
      }),
      [DRILLS]: withLabels(files[DRILLS], 'drill_id', { [drillKey]: { evidence: EVIDENCE, stage_keys: drillStages } }),
    };
  }

  it('the dry run lists the label and link rows and writes nothing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ppbf-labels-seed-'));
    try {
      mkdirSync(path.join(dir, 'multidiscipline'));
      writeFileSync(path.join(dir, DISCIPLINES), labelled('T1|T2', '')[DISCIPLINES]);
      const lines: string[] = [];
      const code = await runApply(
        { client, organizationId: ORG, actorAccountId: admin, seedDataDir: dir, datasets: ['disciplines'], dryRun: true },
        { log: (line) => lines.push(line) },
      );
      const out = lines.join('\n');
      expect(code).toBe(0);
      expect(out).toContain('new version boxing');
      expect(out).toContain('labels boxing v2');
      expect(out).toContain('stage link boxing T1');
      expect(out).toContain('stage link boxing T2');
      expect(out).toContain('RESULT: DRY RUN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await labelRows(ORG)).toEqual([]);
    expect(await linkRows(ORG)).toEqual([]);
  });

  it('writes the labels at the version it writes, links by lineage, and plans unchanged the next time', async () => {
    const files = labelled('T1|T2|RC1', 'AM1|T1');
    const shown = await plan(ORG, admin, files);
    expect(shown.blocking).toEqual([]);
    expect(shown.units.filter((unit) => unit.outcome === 'new_version').map((unit) => unit.key).sort()).toEqual(['boxing', drillKey].sort());

    const result = await applyCommitted(ORG, admin, files);
    expect(result.written.disciplines?.inserted).toEqual(['labels boxing v2', 'stage link boxing RC1', 'stage link boxing T1', 'stage link boxing T2']);
    expect(result.written['drill-library']?.inserted).toEqual(expect.arrayContaining([`labels ${drillKey} v2`, `stage link ${drillKey} AM1`, `stage link ${drillKey} T1`]));

    const labels = await labelRows(ORG);
    expect(labels).toEqual([
      { target_kind: 'discipline', target_lineage_id: 'boxing', target_version: 2, field_labels: JSON.parse(FIELD_LABELS), evidence: JSON.parse(EVIDENCE), backbone_version: null },
      { target_kind: 'drill', target_lineage_id: drillKey, target_version: 2, field_labels: null, evidence: JSON.parse(EVIDENCE), backbone_version: null },
    ]);
    // The drill's version 2 is a real drill_library row; the discipline's is its history-ledger version.
    const drillVersion = await client.query(`select version from pilot.drill_library where organization_id = $1 and lineage_id = $2 and superseded_at is null`, [ORG, drillKey]);
    expect(drillVersion.rows).toEqual([{ version: 2 }]);
    const ledger = await client.query(`select max(version) as v from pilot.reference_content_revisions where organization_id = $1 and dataset = 'disciplines' and item_key = 'boxing'`, [ORG]);
    expect(Number(ledger.rows[0].v)).toBe(2);

    expect((await linkRows(ORG)).map((row) => [row.target_kind, row.target_lineage_id, row.stage_key, row.role, row.lane, row.ended])).toEqual([
      ['discipline', 'boxing', 'RC1', null, null, false],
      ['discipline', 'boxing', 'T1', null, null, false],
      ['discipline', 'boxing', 'T2', null, null, false],
      ['drill', drillKey, 'AM1', null, null, false],
      ['drill', drillKey, 'T1', null, null, false],
    ]);

    // Read back: the same package, keys and JSON in another order, is unchanged.
    const reordered = labelled('RC1|T2|T1', 'T1|AM1');
    const again = await plan(ORG, admin, reordered);
    expect(again.blocking).toEqual([]);
    expect(again.changes).toBe(0);
  });

  it('a dropped stage link is ended, never deleted; a version written without labels has no label row', async () => {
    const files = committed();
    const result = await applyCommitted(ORG, admin, {
      ...files,
      [DISCIPLINES]: withLabels(files[DISCIPLINES], 'discipline', { boxing: { stage_keys: 'T1|AM1' } }),
      [DRILLS]: withLabels(files[DRILLS], 'drill_id', { [drillKey]: { evidence: EVIDENCE, stage_keys: 'AM1|T1' } }),
    });
    expect(result.written.disciplines?.updated).toEqual(['boxing', 'stage link boxing RC1 ended', 'stage link boxing T2 ended']);
    expect(result.written.disciplines?.inserted).toEqual(['stage link boxing AM1']);
    // The drill repeats its stored labels and links: unchanged, nothing written.
    expect(result.written['drill-library']).toEqual({ inserted: [], updated: [], ledgerRows: 0 });

    const boxing = (await linkRows(ORG)).filter((row) => row.target_lineage_id === 'boxing');
    expect(boxing.map((row) => [row.stage_key, row.ended, row.superseded_by_import_id])).toEqual([
      ['AM1', false, null],
      ['RC1', true, result.importId],
      ['T1', false, null],
      ['T2', true, result.importId],
    ]);
    expect((await labelRows(ORG)).filter((row) => row.target_lineage_id === 'boxing').map((row) => row.target_version)).toEqual([2]);
  });

  it("a package carrying only a drill's cues writes its new version WITH the drill's labels, and keeps its links", async () => {
    const files = committed();
    const cues = readCsv(files[CUES]);
    const drillColumn = cues.header.indexOf('drill_id');
    const ours = cues.records.filter((record) => record.cells[drillColumn] === drillKey).map((record) => record.cells);
    expect(ours.length).toBeGreaterThan(0);
    const textColumn = cues.header.indexOf('cue_text');
    const edited = ours.map((cells, index) => (index === 0 ? cells.map((cell, i) => (i === textColumn ? `${cell} (revised)` : i === cues.header.indexOf('cue_id') ? '' : cell)) : cells));
    const result = await applyCommitted(ORG, admin, { [CUES]: writeCsv(cues.header, edited) });
    expect(result.plan.units.find((unit) => unit.key === drillKey)?.toVersion).toBe(3);
    expect(result.written['drill-library']?.inserted).toContain(`labels ${drillKey} v3`);
    expect(result.written['drill-library']?.inserted.some((entry) => entry.startsWith('stage link'))).toBe(false);
    const drill = (await labelRows(ORG)).filter((row) => row.target_lineage_id === drillKey);
    expect(drill.map((row) => [row.target_version, row.evidence])).toEqual([[2, JSON.parse(EVIDENCE)], [3, JSON.parse(EVIDENCE)]]);
  });

  it('label history is append-only, and a link only ever changes by being ended', async () => {
    await expect(client.query(`update pilot.content_record_labels set evidence = null where organization_id = $1`, [ORG])).rejects.toMatchObject({ code: '23001' });
    await expect(client.query(`delete from pilot.content_record_labels where organization_id = $1`, [ORG])).rejects.toMatchObject({ code: '23001' });
    await expect(client.query(`update pilot.content_stage_links set stage_key = 'T2' where organization_id = $1 and superseded_at is null`, [ORG])).rejects.toMatchObject({ code: '23001' });
    await expect(client.query(`delete from pilot.content_stage_links where organization_id = $1`, [ORG])).rejects.toMatchObject({ code: '23001' });
    await expect(client.query(`update pilot.content_stage_links set superseded_at = null where organization_id = $1 and superseded_at is not null`, [ORG])).rejects.toMatchObject({ code: '23001' });
  });

  // LEFT OUT IS NOT BLANK (Overwatch review, PR #1893): a root file without
  // the label columns -- every package written before P19 -- does not state
  // labels, so it must neither revise a labelled item nor strip its labels.
  // State here: boxing holds links AM1, T1 (no label row at its current
  // version); the drill holds evidence at its current version and links AM1, T1.
  it('a root file WITHOUT the label columns repeating labelled items plans all unchanged and writes nothing', async () => {
    const files = committed();
    const again = await plan(ORG, admin, { [DISCIPLINES]: files[DISCIPLINES], [DRILLS]: files[DRILLS] });
    expect(again.blocking).toEqual([]);
    expect(outcomes(again)).toEqual({ unchanged: again.units.length - again.totals.absent, ...(again.totals.absent ? { absent: again.totals.absent } : {}) });
    expect(again.changes).toBe(0);
  });

  it('a root file WITHOUT the label columns revising labelled items writes the new versions WITH their stored labels, and keeps their links', async () => {
    const files = committed();
    const before = await linkRows(ORG);
    const edit = (text: string, keyColumn: string, key: string, column: string) => {
      const table = readCsv(text);
      const at = table.header.indexOf(column);
      const rows = table.records.map((record) => (record.cells[table.header.indexOf(keyColumn)] === key
        ? record.cells.map((cell, index) => (index === at ? `${cell} (revised)` : cell))
        : record.cells));
      return writeCsv(table.header, rows);
    };
    const result = await applyCommitted(ORG, admin, {
      [DISCIPLINES]: edit(files[DISCIPLINES], 'discipline', 'boxing', 'governing_body'),
      [DRILLS]: edit(files[DRILLS], 'drill_id', drillKey, 'purpose'),
    });
    const drillUnit = result.plan.units.find((unit) => unit.key === drillKey);
    expect(drillUnit?.outcome).toBe('new_version');
    expect(result.plan.units.find((unit) => unit.key === 'boxing')?.outcome).toBe('new_version');
    expect(result.written['drill-library']?.inserted).toContain(`labels ${drillKey} v${drillUnit?.toVersion}`);
    for (const written of [result.written.disciplines, result.written['drill-library']]) {
      expect([...(written?.inserted ?? []), ...(written?.updated ?? [])].filter((entry) => entry.startsWith('stage link'))).toEqual([]);
    }
    expect(await linkRows(ORG)).toEqual(before);
    const drill = (await labelRows(ORG)).filter((row) => row.target_lineage_id === drillKey);
    expect(drill[drill.length - 1]).toMatchObject({ target_version: drillUnit?.toVersion, field_labels: null, evidence: JSON.parse(EVIDENCE) });
    // And the revised items, sent again without the columns, are unchanged.
    const again = await plan(ORG, admin, {
      [DISCIPLINES]: edit(files[DISCIPLINES], 'discipline', 'boxing', 'governing_body'),
      [DRILLS]: edit(files[DRILLS], 'drill_id', drillKey, 'purpose'),
    });
    expect(again.changes).toBe(0);
  });

  // The versioned template engine (templateScriptVersions.ts): its own head
  // rule and version numbering, the same label behaviour.
  it('workout templates: labels land at the version written, read back unchanged, and a file without the columns keeps them', async () => {
    const files = stripLabelColumns(readDatasetFiles(SEED_DATA_DIR, ['workout-templates']));
    await applyCommitted(ORG, admin, files);
    const key = firstKey(files[TEMPLATES], 'template_id');
    const labelledFiles = { ...files, [TEMPLATES]: withLabels(files[TEMPLATES], 'template_id', { [key]: { field_labels: FIELD_LABELS, stage_keys: 'T1|FT1' } }) };
    const result = await applyCommitted(ORG, admin, labelledFiles);
    const unit = result.plan.units.find((candidate) => candidate.key === key);
    expect(unit?.outcome).toBe('new_version');
    const version = await client.query(`select max(version)::int as v from pilot.workout_templates where organization_id = $1 and lineage_id = $2`, [ORG, key]);
    expect(unit?.toVersion).toBe(version.rows[0].v);
    expect(result.written['workout-templates']?.inserted).toEqual([`labels ${key} v${unit?.toVersion}`, `stage link ${key} FT1`, `stage link ${key} T1`]);
    expect((await plan(ORG, admin, labelledFiles)).changes).toBe(0);
    expect((await plan(ORG, admin, files)).changes).toBe(0);
  });
});
