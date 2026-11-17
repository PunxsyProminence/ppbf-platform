// The assessment catalog dataset (lane CAT-b; SCHEMA_PROPOSAL P5, P6;
// OD-2026-11-16-001, OD-2026-11-16-003), DATABASE half: an assessment-catalog
// package validates, plans, applies, re-plans unchanged, revises and retires;
// protocols version instead of retiring and a load leaves other protocols
// alone; blank loads blank (CAT ruling Q1); references are refused by name.
// And the two Overwatch guards: the shared snapshot engine leaves the
// committed pathway-catalog plan unchanged (3010 unchanged once loaded), and
// the dry-run plan names every existing protocol a load would version or
// refuse.
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

import { applyImport } from './contentImport/apply';
import { formatPlan, readDatasetFiles } from './contentImport/cli';
import { writeCsv } from './contentImport/csv';
import { hex14 } from './contentImport/ids';
import { type ImportPlan, planImport } from './contentImport/plan';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATABASE = 'assessment_catalog_dataset';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-assessment-catalog-dataset-pg-test-${Date.now()}`);
const WEB_DIR = path.resolve(__dirname, '../../..');
const SERVER_SCRIPT_PATH = path.join(WEB_DIR, 'scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(WEB_DIR, '../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.join(WEB_DIR, 'scripts/lib/full-schema.mjs');
const SEED_DATA_DIR = path.join(WEB_DIR, 'seed-data');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;

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

function outcomes(result: ImportPlan): Record<string, string> {
  return Object.fromEntries(result.units.filter((unit) => unit.dataset === 'assessment-catalog').map((unit) => [unit.key, unit.outcome]));
}

const blockingMessages = (result: ImportPlan) => result.blocking.map((finding) => `${finding.code} ${finding.column ?? ''} ${finding.message}`);

/** A gym with the committed pathway catalog loaded (the stages the gates name). */
async function gymWithPathway(organizationId: string): Promise<string> {
  const actor = await createGym(organizationId);
  await load(organizationId, actor, readDatasetFiles(SEED_DATA_DIR, ['pathway-catalog']));
  return actor;
}

type Row = Record<string, string>;
const DIR = 'assessment-catalog';
const csv = (header: string[], rows: Row[]) => writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? '')));

const ORG = '{{PPBF_ORG_ID}}';
const EVIDENCE = JSON.stringify([{ evidence_category: 'unassigned', evidence_label: 'UNTIERED', check_state: 'unchecked', evidence_item_ids: [], registry_claim_ids: [] }]);
const pgt = (stage: string, kind: string) => `pgt_${hex14(`${stage}:${kind}`)}`;
const pgc = (gate: string, ordinal: number) => `pgc_${hex14(`${gate}:${ordinal}`)}`;
const sci = (protocol: string, n: number) => `sci_${hex14(`${protocol}:${String(n).padStart(2, '0')}`)}`;
const acs = (item: string, level: number, context: string) => `acs_${hex14(`${item}:${level}:${context}`)}`;
const kpi = (list: string, name: string) => `kpi_${hex14(`${list}:${name}`)}`;

const H = {
  protocols: ['organization_id', 'protocol_id', 'name', 'measure_kind', 'quality_measured', 'protocol_summary', 'reliability_status', 'validity_status',
    'evidence_class', 'boxing_specific', 'protocol_group', 'status', 'sources', 'decision', 'backbone_version', 'evidence'],
  scales: ['organization_id', 'scale_key', 'min_level', 'max_level', 'level_anchors', 'status', 'note', 'backbone_version'],
  caps: ['organization_id', 'cap_key', 'scale_key', 'max_score', 'applies_to', 'applies_to_protocol_id', 'applies_to_contexts', 'wording', 'decision', 'note', 'status'],
  items: ['organization_id', 'scorecard_item_id', 'protocol_id', 'item_number', 'item_group', 'name', 'definition', 'scale', 'scale_key', 'scorable_contexts',
    'status', 'sources', 'backbone_version', 'field_labels', 'evidence'],
  gates: ['organization_id', 'gate_id', 'stage_key', 'gate_kind', 'informs_only', 'override_process', 'status', 'sources', 'backbone_version', 'evidence'],
  criteria: ['organization_id', 'criterion_id', 'gate_id', 'ordinal', 'kind', 'criterion_text', 'scorecard_item_ids', 'item_numbers', 'min_score', 'contexts',
    'combine', 'ref_stage_key', 'ref_gate_kind', 'ref_gate_id', 'status', 'sources', 'backbone_version'],
  specs: ['organization_id', 'anchor_spec_id', 'scorecard_item_id', 'item_number', 'level', 'context_class', 'used_by_stage_keys', 'priority', 'status', 'sources'],
  lists: ['organization_id', 'list_key', 'title', 'source_doc', 'scoring_rule_text', 'status'],
  kpis: ['organization_id', 'kpi_id', 'list_key', 'ordinal', 'name', 'scoring_kind', 'level_anchors', 'status', 'field_labels'],
};

const ITEM1 = sci('PP-T01', 1);
const ITEM2 = sci('PP-T01', 2);
const Y1_ENTRY = pgt('Y1', 'entry');
const Y1_EXIT = pgt('Y1', 'exit');
const Y2_ENTRY = pgt('Y2', 'entry');

const P1: Row = {
  organization_id: ORG, protocol_id: 'PP-T01', name: 'Long Road technical scorecard', measure_kind: 'skill_rubric',
  protocol_summary: 'the Long Road technical scorecard, items 1-27, scale 1-5',
  reliability_status: 'UNVALIDATED - PPBF MUST ESTABLISH (repo default, EVIDENCE_VOCABULARY s4)', validity_status: 'UNKNOWN (repo default)',
  status: 'REPORTED', sources: 'LR-P2§3.2', decision: 'D-PK118', backbone_version: 'catalogs 876ac31f5c677584', evidence: EVIDENCE,
};

function catalog(over: Partial<Record<keyof typeof H, Row[]>> = {}): Record<string, string> {
  const rows: Record<keyof typeof H, Row[]> = {
    protocols: [P1],
    scales: [{ organization_id: ORG, scale_key: 'live_long_road', min_level: '1', max_level: '5',
      level_anchors: '{"1": "Absent or actively wrong", "5": "Reliable under pressure against better opposition"}', status: 'REPORTED' }],
    caps: [{ organization_id: ORG, cap_key: 'non_contact_rule', scale_key: 'live_long_road', max_score: '3',
      applies_to: 'PP-T01 Long Road items scored in drill, shadow or partner contexts', applies_to_protocol_id: 'PP-T01',
      applies_to_contexts: 'drill|shadow|partner', wording: 'live_long_road (verbatim)', decision: 'D-Q11', note: 'Cap scope read as PP-T01 only', status: 'OBSERVED' }],
    items: [
      { organization_id: ORG, scorecard_item_id: ITEM1, protocol_id: 'PP-T01', item_number: '1', item_group: 'foundations', name: 'Stance integrity under movement',
        definition: 'Stance integrity under movement', scale: '1-5 (Long Road Part 2 section 3.1)', scale_key: 'live_long_road',
        scorable_contexts: 'drill|shadow|partner|constrained_live|live', status: 'REPORTED', sources: 'LR-P2§3.2|LR-AppxD',
        field_labels: '{"scorable_contexts": "INFERRED"}', evidence: EVIDENCE },
      { organization_id: ORG, scorecard_item_id: ITEM2, protocol_id: 'PP-T01', item_number: '2', name: 'Footwork economy', definition: 'Footwork economy',
        scale: '1-5 (Long Road Part 2 section 3.1)', scale_key: 'live_long_road', status: 'REPORTED' },
    ],
    gates: [
      { organization_id: ORG, gate_id: Y1_ENTRY, stage_key: 'Y1', gate_kind: 'entry', informs_only: 'true', status: 'REPORTED', sources: 'DOC-156|RULES', evidence: EVIDENCE },
      { organization_id: ORG, gate_id: Y1_EXIT, stage_key: 'Y1', gate_kind: 'exit', status: 'INFERRED', sources: 'inference' },
      { organization_id: ORG, gate_id: Y2_ENTRY, stage_key: 'Y2', gate_kind: 'entry', status: 'INFERRED' },
    ],
    criteria: [
      { organization_id: ORG, criterion_id: pgc(Y1_ENTRY, 1), gate_id: Y1_ENTRY, ordinal: '1', kind: 'text', criterion_text: 'Age about 5 or older; no prior skill required.' },
      { organization_id: ORG, criterion_id: pgc(Y1_EXIT, 1), gate_id: Y1_EXIT, ordinal: '1', kind: 'scorecard_min', scorecard_item_ids: `${ITEM1}|${ITEM2}`,
        item_numbers: '1|2', min_score: '2', contexts: 'drill|shadow', combine: 'all' },
      { organization_id: ORG, criterion_id: pgc(Y2_ENTRY, 1), gate_id: Y2_ENTRY, ordinal: '1', kind: 'stage_completed', ref_stage_key: 'Y1' },
    ],
    specs: [{ organization_id: ORG, anchor_spec_id: acs(ITEM1, 2, 'non_contact'), scorecard_item_id: ITEM1, item_number: '1', level: '2',
      context_class: 'non_contact', used_by_stage_keys: 'Y1|Y2', priority: '1', status: 'INFERRED' }],
    lists: [{ organization_id: ORG, list_key: 'drill', title: 'Core Drill KPIs Worth Scoring', source_doc: 'DOC-041',
      scoring_rule_text: 'Use simple counts, yes-no marks, or three-level ratings when possible.', status: 'OBSERVED' }],
    kpis: [
      { organization_id: ORG, kpi_id: kpi('drill', 'Clean exits.'), list_key: 'drill', ordinal: '1', name: 'Clean exits.', scoring_kind: 'count', status: 'OBSERVED' },
      { organization_id: ORG, kpi_id: kpi('drill', 'Reset quality.'), list_key: 'drill', ordinal: '2', name: 'Reset quality.', scoring_kind: 'three_level',
        level_anchors: '{"1": "a", "2": "b", "3": "c"}', status: 'OBSERVED', field_labels: '{"level_anchors": {"status": "INFERRED", "draft": true}}' },
    ],
    ...over,
  };
  const files: [keyof typeof H, string][] = [
    ['protocols', 'seed_assessment_protocols.csv'], ['scales', 'seed_scorecard_scales.csv'], ['caps', 'seed_scorecard_score_caps.csv'],
    ['items', 'seed_scorecard_items.csv'], ['gates', 'seed_pathway_gates.csv'], ['criteria', 'seed_pathway_gate_criteria.csv'],
    ['specs', 'seed_scorecard_anchor_clip_specs.csv'], ['lists', 'seed_behavior_kpi_lists.csv'], ['kpis', 'seed_behavior_kpis.csv'],
  ];
  return Object.fromEntries(files.map(([name, file]) => [`${DIR}/${file}`, csv(H[name], rows[name])]));
}

/** Only the named files. */
function only(files: Record<string, string>, ...names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([file]) => names.some((name) => file.endsWith(name))));
}

// ---------------------------------------------------------------------------

describe('guard: the shared snapshot engine leaves the pathway catalog as it was', () => {
  it('loads the committed pathway seed, then re-plans it as 3010 unchanged', async () => {
    const actor = await createGym('gym_pathway');
    const files = readDatasetFiles(SEED_DATA_DIR, ['pathway-catalog']);
    const first = await plan('gym_pathway', actor, files);
    expect(first.counts['pathway-catalog']).toMatchObject({ new: 3010, new_version: 0, unchanged: 0, absent: 0, reject: 0 });
    await load('gym_pathway', actor, files);
    const again = await plan('gym_pathway', actor, files);
    expect(again.blocking).toEqual([]);
    expect(again.counts['pathway-catalog']).toEqual({ new: 0, new_version: 0, unchanged: 3010, absent: 0, reject: 0 });
  });
});

describe('an assessment-catalog package', () => {
  let actor: string;
  beforeAll(async () => {
    actor = await gymWithPathway('gym_cat');
  });

  it('plans, applies and re-plans unchanged; blank loads blank', async () => {
    const files = catalog();
    const first = await plan('gym_cat', actor, files);
    expect(first.blocking).toEqual([]);
    expect(first.counts['assessment-catalog']).toEqual({ new: 15, new_version: 0, unchanged: 0, absent: 0, reject: 0 });
    await load('gym_cat', actor, files);

    const again = await plan('gym_cat', actor, files);
    expect(again.counts['assessment-catalog']).toEqual({ new: 0, new_version: 0, unchanged: 15, absent: 0, reject: 0 });

    const { rows: [protocol] } = await client.query(
      `select protocol_version, active, quality_measured, boxing_specific, evidence_class, retest_interval_basis, reliability_status,
              human_authority_required, sources, status, evidence
         from pilot.assessment_protocols where organization_id = 'gym_cat' and protocol_id = 'PP-T01'`,
    );
    expect(protocol).toEqual({
      protocol_version: 1, active: true, quality_measured: '', boxing_specific: '', evidence_class: '',
      retest_interval_basis: 'TBD - no defensible basis', reliability_status: P1.reliability_status, human_authority_required: true,
      sources: ['LR-P2§3.2'], status: 'REPORTED', evidence: JSON.parse(EVIDENCE),
    });
    const { rows: [counts] } = await client.query(
      `select (select count(*) from pilot.pathway_gates where organization_id = $1)::int as gates,
              (select count(*) from pilot.pathway_gate_criteria where organization_id = $1)::int as criteria,
              (select count(*) from pilot.scorecard_items where organization_id = $1)::int as items,
              (select array_to_string(scorable_contexts, '|') from pilot.scorecard_items where organization_id = $1 and item_number = 1) as contexts,
              (select level_anchors->>'2' from pilot.behavior_kpis where organization_id = $1 and ordinal = 2) as anchor,
              (select count(*) from pilot.reference_content_revisions where organization_id = $1 and dataset = 'pathway_gates')::int as gate_history`,
      ['gym_cat'],
    );
    expect(counts).toEqual({ gates: 3, criteria: 3, items: 2, contexts: 'drill|shadow|partner|constrained_live|live', anchor: 'b', gate_history: 3 });
  });

  it('revises a changed row and retires what a file leaves out; a file left out leaves its table alone', async () => {
    const base = catalog();
    const files = only(
      catalog({
        gates: [
          { organization_id: ORG, gate_id: Y1_ENTRY, stage_key: 'Y1', gate_kind: 'entry', status: 'OBSERVED', sources: 'DOC-156|RULES', evidence: EVIDENCE },
          { organization_id: ORG, gate_id: Y1_EXIT, stage_key: 'Y1', gate_kind: 'exit', status: 'INFERRED', sources: 'inference' },
        ],
        criteria: [
          { organization_id: ORG, criterion_id: pgc(Y1_ENTRY, 1), gate_id: Y1_ENTRY, ordinal: '1', kind: 'text', criterion_text: 'Age about 5 or older; no prior skill required.' },
          { organization_id: ORG, criterion_id: pgc(Y1_EXIT, 1), gate_id: Y1_EXIT, ordinal: '1', kind: 'scorecard_min', scorecard_item_ids: `${ITEM1}|${ITEM2}`,
            item_numbers: '1|2', min_score: '2', contexts: 'drill|shadow', combine: 'all' },
        ],
      }),
      'seed_pathway_gates.csv', 'seed_pathway_gate_criteria.csv',
    );
    expect(Object.keys(base).length).toBe(9);
    const result = await plan('gym_cat', actor, files);
    expect(result.blocking).toEqual([]);
    expect(outcomes(result)).toEqual({
      [Y1_ENTRY]: 'new_version', [Y1_EXIT]: 'unchanged', [Y2_ENTRY]: 'new_version',
      [pgc(Y1_ENTRY, 1)]: 'unchanged', [pgc(Y1_EXIT, 1)]: 'unchanged', [pgc(Y2_ENTRY, 1)]: 'new_version',
    });
    expect(formatPlan(result).filter((line) => line.includes('retire')).length).toBe(2);
    await load('gym_cat', actor, files);
    const { rows } = await client.query(
      `select gate_id, status, active_flag from pilot.pathway_gates where organization_id = 'gym_cat' order by gate_id`,
    );
    expect(rows.find((row) => row.gate_id === Y1_ENTRY)).toMatchObject({ status: 'OBSERVED', active_flag: true });
    expect(rows.find((row) => row.gate_id === Y2_ENTRY)).toMatchObject({ active_flag: false });
    const { rows: [scales] } = await client.query(`select count(*)::int as n from pilot.scorecard_scales where organization_id = 'gym_cat' and active_flag`);
    expect(scales.n).toBe(1);
  });

  it('refuses a file that would retire a row a loaded row of a file it leaves out still names', async () => {
    const files = only(catalog({ items: [{
      organization_id: ORG, scorecard_item_id: ITEM1, protocol_id: 'PP-T01', item_number: '1', item_group: 'foundations', name: 'Stance integrity under movement',
      definition: 'Stance integrity under movement', scale: '1-5 (Long Road Part 2 section 3.1)', scale_key: 'live_long_road',
      scorable_contexts: 'drill|shadow|partner|constrained_live|live', status: 'REPORTED', sources: 'LR-P2§3.2|LR-AppxD',
      field_labels: '{"scorable_contexts": "INFERRED"}', evidence: EVIDENCE,
    }] }), 'seed_scorecard_items.csv');
    const result = await plan('gym_cat', actor, files);
    expect(blockingMessages(result)).toEqual([
      `orphan_reference  this file would retire scorecard item '${ITEM2}', but the loaded pathway_gate_criteria row ${pgc(Y1_EXIT, 1)} still names it; carry seed_pathway_gate_criteria.csv too, or keep the scorecard item`,
    ]);
  });

  it('versions a changed protocol (the earlier version kept, inactive); the plan names it, and the protocols it leaves alone', async () => {
    await client.query(
      `insert into pilot.assessment_protocols (organization_id, protocol_id, protocol_version, name, measure_kind, quality_measured, protocol_summary)
       values ('gym_cat', 'A5-T01', 1, 'Countermovement jump', 'physical_test', 'Lower-body power', 'Best of three.')`,
    );
    const files = only(catalog({ protocols: [{ ...P1, protocol_summary: 'the Long Road technical scorecard, items 1-27, scale 1-5 (revised)' }] }), 'seed_assessment_protocols.csv');
    const result = await plan('gym_cat', actor, files);
    expect(result.blocking).toEqual([]);
    const lines = formatPlan(result);
    expect(lines).toContain('    new version PP-T01: history v1 -> v2');
    expect(lines.some((line) => line.startsWith('  [protocols_left_alone]') && line.includes('A5-T01'))).toBe(true);
    await load('gym_cat', actor, files);
    const { rows } = await client.query(
      `select protocol_id, protocol_version, active, protocol_summary from pilot.assessment_protocols where organization_id = 'gym_cat' order by 1, 2`,
    );
    expect(rows.map((row) => `${row.protocol_id} v${row.protocol_version} ${row.active}`)).toEqual(['A5-T01 v1 true', 'PP-T01 v1 false', 'PP-T01 v2 true']);
    expect((await plan('gym_cat', actor, files)).counts['assessment-catalog']).toMatchObject({ unchanged: 1, new_version: 0 });
  });

  it('refuses a protocol whose name another active protocol holds, and shows it in the dry-run plan', async () => {
    const files = only(catalog({ protocols: [P1, { ...P1, protocol_id: 'PP-T03', name: 'Countermovement jump' }] }), 'seed_assessment_protocols.csv');
    const result = await plan('gym_cat', actor, files);
    expect(blockingMessages(result)).toEqual(["duplicate_value name another active protocol, A5-T01 v1, already has the name 'Countermovement jump'"]);
    expect(formatPlan(result)).toContain("    reject PP-T03: another active protocol, A5-T01 v1, already has the name 'Countermovement jump'");
  });
});

describe('references are refused by name', () => {
  let actor: string;
  beforeAll(async () => {
    actor = await gymWithPathway('gym_refs');
  });

  it('offline, between the package\'s own files', async () => {
    const files = catalog({
      criteria: [
        { organization_id: ORG, criterion_id: pgc(Y1_EXIT, 1), gate_id: Y1_EXIT, ordinal: '1', kind: 'scorecard_min', scorecard_item_ids: sci('PP-T01', 9),
          item_numbers: '9', min_score: '2', contexts: 'drill', combine: 'all' },
        { organization_id: ORG, criterion_id: pgc(Y2_ENTRY, 1), gate_id: Y2_ENTRY, ordinal: '1', kind: 'gate_met', ref_stage_key: 'Y2', ref_gate_kind: 'exit', ref_gate_id: Y1_EXIT },
      ],
      specs: [{ organization_id: ORG, anchor_spec_id: acs(ITEM1, 2, 'live'), scorecard_item_id: ITEM1, item_number: '2', level: '2', context_class: 'live', status: 'INFERRED' }],
    });
    const result = await plan('gym_refs', actor, files);
    expect(blockingMessages(result).sort()).toEqual([
      `orphan_reference ref_gate_id gate ${Y1_EXIT} is Y1 exit, not Y2 exit`,
      `orphan_reference scorecard_item_ids scorecard_item_ids names scorecard item '${sci('PP-T01', 9)}', which is not in seed_scorecard_items.csv of this package`,
      `row_rule item_number item_number 2 is not the number of item ${ITEM1} (1)`,
    ].sort());
  });

  it('at plan, against the loaded catalog and stages; an id that is not its identity\'s', async () => {
    const zz = pgt('ZZ9', 'entry');
    const files = only(catalog({
      gates: [{ organization_id: ORG, gate_id: zz, stage_key: 'ZZ9', gate_kind: 'entry', status: 'INFERRED' }],
      criteria: [
        { organization_id: ORG, criterion_id: pgc(zz, 1), gate_id: zz, ordinal: '1', kind: 'scorecard_min', scorecard_item_ids: ITEM1, item_numbers: '1',
          min_score: '2', contexts: 'drill', combine: 'all' },
        { organization_id: ORG, criterion_id: pgc(zz, 3), gate_id: zz, ordinal: '2', kind: 'text', criterion_text: 'x' },
      ],
    }), 'seed_pathway_gates.csv', 'seed_pathway_gate_criteria.csv');
    const result = await plan('gym_refs', actor, files);
    expect(blockingMessages(result).sort()).toEqual([
      `orphan_reference scorecard_item_ids scorecard_item_ids names scorecard item '${ITEM1}', which is not in this organization's assessment catalog and pathway stages`,
      "orphan_reference stage_key stage_key names stage 'ZZ9', which is not in this organization's assessment catalog and pathway stages",
      `row_rule  criterion_id '${pgc(zz, 3)}' is not the id of '${zz}:2' (${pgc(zz, 2)})`,
    ].sort());
  });

  it('a package with no stage file and no pathway catalog loaded: the gate\'s stage is refused at plan', async () => {
    const bare = await createGym('gym_bare');
    const files = only(catalog(), 'seed_pathway_gates.csv');
    const result = await plan('gym_bare', bare, files);
    expect(blockingMessages(result).filter((message) => message.includes('stage_key')).length).toBe(3);
  });
});
