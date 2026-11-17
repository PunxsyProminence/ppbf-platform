import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCsv } from '../src/server/pilot/contentImport/csv';
import { FILE_SPECS } from '../src/server/pilot/contentImport/specs';
import { PPBF_ASSESSMENT_PROTOCOLS } from '../src/server/pilot/assessmentResults';

// Lane CAT-c: the Backbone -> assessment-catalog exporter, over a small fixture
// Backbone built here (one record of each kind, its own manifest), plus two
// checks on the committed seed: it regenerates byte for byte from the frozen
// Backbone when that folder is on this machine (skipped elsewhere), and no
// catalog protocol takes a name of one of the app's own protocols
// (assessmentResults.ts ensurePpbfAssessmentProtocols needs its names free).

const SCRIPT = path.resolve(__dirname, 'backbone-export-assessment-catalog.mjs');
const SEED_DIR = path.resolve(__dirname, '../seed-data');
const FROZEN = 'C:\\Users\\jason\\OneDrive - PUNXSY PROMINENCE BOXING AND FITNESS\\PPBF-AI-Lanes\\Research\\Backbone';
const CATALOGS = 'working/design-2026-10-25/design_catalogs.json';
const DIR = 'assessment-catalog';
const FILES = [
  'seed_assessment_protocols.csv', 'seed_scorecard_scales.csv', 'seed_scorecard_score_caps.csv', 'seed_scorecard_items.csv',
  'seed_pathway_gates.csv', 'seed_pathway_gate_criteria.csv', 'seed_scorecard_anchor_clip_specs.csv',
];

type Json = Record<string, unknown>;
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-cat-export-test-'));
  temps.push(dir);
  return dir;
}
const sha16 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const UNTIERED = { evidence_category: 'unassigned', evidence_label: 'UNTIERED', check_state: 'unchecked', evidence_item_ids: [], registry_claim_ids: [] };

function catalogs(over: Json = {}): Json {
  return {
    status_line: 'Status: DRAFT, not app source until handoff (RULES.md)',
    meta: { generated: '2026-10-25' },
    default_rules: [],
    assessment_protocols: [
      { protocol_id: 'PP-T01', name: 'Long Road technical scorecard', measure_kind: 'skill_rubric', description: 'items 1-27, scale 1-5',
        reliability_status: 'UNVALIDATED - PPBF MUST ESTABLISH (repo default, EVIDENCE_VOCABULARY s4)', validity_status: 'UNKNOWN (repo default)',
        status: 'REPORTED', sources: ['LR-P2§3.2'], evidence: [UNTIERED], decision: 'D-PK118' },
      { protocol_id: 'PP-T03', name: 'Ankle dorsiflexion (knee-to-wall)', measure_kind: 'physical_test', protocol_group: 'Musculoskeletal screen',
        reliability_status: 'UNVALIDATED - PPBF MUST ESTABLISH (repo default, EVIDENCE_VOCABULARY s4)', validity_status: 'UNKNOWN (repo default)',
        status: 'REPORTED', sources: ['LR-026'], protocol_text: '| Ankle dorsiflexion | Foot perpendicular to wall |', minted_from: 'new:ankle', evidence: [UNTIERED], decision: 'D-OQ181' },
    ],
    scorecard_items: [
      { scorecard_item_id: 'sci_3e422ec1f94b2a', protocol_id: 'PP-T01', item_number: 1, group: 'foundations', name: 'Stance integrity under movement',
        definition: 'Stance integrity under movement \u2014 base width', scale: '1-5 (Long Road Part 2 section 3.1)', scorable_contexts: ['drill', 'live'],
        status: 'REPORTED', sources: ['LR-P2§3.2'], evidence: [UNTIERED], contexts_status: 'INFERRED', organization_id: '{{PPBF_ORG_ID}}' },
      { scorecard_item_id: 'sci_98fe7063b799ea', name: 'fight_iq_components', definition: '| Component | Definition |', scale: 'not in source (gap)',
        status: 'REPORTED', sources: ['LR-131'], evidence: [UNTIERED], gaps: ['no scale in the source; not scorable until a scale is set (D-PK119)'],
        id_note: "sci_ id from the identity string 'LR-131:fight_iq_components'", organization_id: '{{PPBF_ORG_ID}}', decision: 'D-OQ190' },
    ],
    gates: [
      { gate_id: 'pgt_b2023fc2fea6e0', stage_key: 'T1', gate_kind: 'exit', informs_only: true, override_process: 'progression_decision_request',
        override_presets_status: 'DECIDED', status: 'REPORTED', sources: ['LR-055'],
        evidence: [
          UNTIERED,
          { ...UNTIERED, evidence_category: 'research', evidence_label: 'EMERGING', check_state: 'verified',
            beside: [{ statement_id: 'ACSM-3PCT', source: 'EXT-ACSM-2021', location: 'section on weight-making practices', quotes: ['a licensed passage', 'another'] }] },
        ],
        criteria: [
          { criterion_id: 'pgc_00000000000001', ordinal: 1, kind: 'text', text: 'Twelve weeks of unbroken logging', polarity: 'should_have',
            field_labels: { text: 'INFERRED (test name and phase cell joined by the drafting session)' }, source_cell: '\u22652 cm',
            sources: ['LR-201'], status: 'REPORTED', evidence: [UNTIERED], decision: 'D-OQ194' },
          { criterion_id: 'pgc_00000000000002', ordinal: 2, kind: 'bout_count', min: 2, max: 5, scope: 'sanctioned bouts in stage', note: 'Competition route only.' },
          { criterion_id: 'pgc_00000000000003', ordinal: 3, kind: 'scorecard_min', item_numbers: [1], scorecard_item_ids: ['sci_3e422ec1f94b2a'], min_score: 4.5,
            contexts: ['live'], combine: 'any' },
        ],
      },
      { gate_id: 'pgt_00000000000002', stage_key: 'T2', gate_kind: 'entry', informs_only: true, status: 'INFERRED', sources: ['inference'], evidence: [UNTIERED],
        schema_note: 'a note on the kind',
        criteria: [{ criterion_id: 'pgc_00000000000004', ordinal: 1, kind: 'gate_met', stage_key: 'T1', gate_kind: 'exit', gate_id: 'pgt_b2023fc2fea6e0' }] },
    ],
    anchor_clip_specs: [
      { anchor_spec_id: 'acs_de74867602ddb4', scorecard_item_id: 'sci_3e422ec1f94b2a', item_number: 1, level: 2, context_class: 'live',
        used_by_gates: ['Y3', 'T1'], priority: 1, status: 'INFERRED', sources: ['YOUTH_GATE_PROTOCOL.md (derived from gate thresholds)'] },
    ],
    scale_definitions: {
      live_long_road: { 1: 'Absent or actively wrong', 5: 'Reliable under pressure against better opposition' },
      cue_response_draft: { 1: 'Does not change the next rep', 5: 'Applies and keeps cues' },
      status: { live_long_road: 'REPORTED', cue_response_draft: 'INFERRED', non_contact_rule: 'OBSERVED' },
      non_contact_rule: {
        wording: 'live_long_road (verbatim; the draft non-contact wording is withdrawn)', max_score: 3,
        applies_to: 'PP-T01 Long Road items scored in drill, shadow or partner contexts',
        decision: 'D-Q11 (Jason 2026-10-25): keep Long Road wording; cap non-contact scores at 3', note: 'Cap scope read as PP-T01 only',
      },
      cue_response_note: 'Draft anchors accepted by Jason for now (D-Q10); status stays INFERRED (AI-drafted wording).',
    },
    ...over,
  };
}

/** A Backbone folder with a manifest; `after` may tamper once the manifest is written. */
function backbone(data: Json = catalogs(), after?: (dir: string) => void): string {
  const dir = tempDir();
  const text = JSON.stringify(data, null, 2);
  fs.mkdirSync(path.join(dir, path.dirname(CATALOGS)), { recursive: true });
  fs.writeFileSync(path.join(dir, CATALOGS), text);
  fs.writeFileSync(path.join(dir, 'FREEZE_MANIFEST.json'), JSON.stringify({ files: [{ path: CATALOGS, sha256_16: sha16(text) }] }));
  after?.(dir);
  return dir;
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function exportInto(dir: string, seed?: string, extra: string[] = []) {
  const out = tempDir();
  if (seed) fs.cpSync(seed, out, { recursive: true });
  return { out, ...run([dir, '--out', out, ...extra]) };
}
const read = (out: string, name: string) => fs.readFileSync(path.join(out, DIR, name), 'utf8');
function rowsOf(text: string): Record<string, string>[] {
  const table = readCsv(text);
  expect(table.problems).toEqual([]);
  return table.records.map((record) => Object.fromEntries(table.header.map((name, index) => [name, record.cells[index]])));
}
const byKey = (rows: Record<string, string>[], key: string, value: string) => rows.find((row) => row[key] === value) as Record<string, string>;

describe('backbone-export-assessment-catalog (lane CAT-c)', () => {
  const dir = backbone();
  const first = exportInto(dir);

  it('writes the seven files, each header the spec\'s column list in order', () => {
    expect(first.stderr).toBe('');
    expect(first.status).toBe(2); // the fixture is small on purpose: counts differ from the brief's
    for (const name of FILES) {
      const spec = FILE_SPECS.find((file) => file.file === name);
      expect(readCsv(read(first.out, name)).header).toEqual(spec!.columns.map((column) => column.name));
    }
  });

  it('reports each count that differs from the brief, by name, and what it did not carry', () => {
    expect(first.stdout).toContain('COUNTS DIFFER FROM THE BRIEF');
    expect(first.stdout).toContain('gates: brief 38, observed 2');
    expect(first.stdout).toContain('not carried: catalogs.default_rules (1), catalogs.meta (1), catalogs.status_line (1), protocol.minted_from (1)');
  });

  it('maps the protocols as ruled: summary from protocol_text or description, Q1 blanks, human authority true and INFERRED', () => {
    const rows = rowsOf(read(first.out, 'seed_assessment_protocols.csv'));
    const t01 = byKey(rows, 'protocol_id', 'PP-T01');
    expect(t01).toMatchObject({
      protocol_summary: 'items 1-27, scale 1-5', quality_measured: '', boxing_specific: '', evidence_class: '', retest_interval_basis: '',
      human_authority_required: 'true', sources: 'LR-P2§3.2', backbone_version: expect.stringMatching(/^catalogs [0-9a-f]{16}$/),
    });
    expect(JSON.parse(t01.field_labels).human_authority_required).toMatchObject({ status: 'INFERRED', sources: ['RULES'] });
    expect(byKey(rows, 'protocol_id', 'PP-T03')).toMatchObject({ protocol_summary: '| Ankle dorsiflexion | Foot perpendicular to wall |', protocol_group: 'Musculoskeletal screen' });
  });

  it('renames the criterion keys, and a field label follows its renamed column', () => {
    const rows = rowsOf(read(first.out, 'seed_pathway_gate_criteria.csv'));
    expect(byKey(rows, 'criterion_id', 'pgc_00000000000001')).toMatchObject({
      gate_id: 'pgt_b2023fc2fea6e0', criterion_text: 'Twelve weeks of unbroken logging', polarity: 'should_have', source_cell: '\u22652 cm',
      field_labels: '{"criterion_text":"INFERRED (test name and phase cell joined by the drafting session)"}',
    });
    expect(byKey(rows, 'criterion_id', 'pgc_00000000000002')).toMatchObject({ bout_min: '2', bout_max: '5', bout_scope: 'sanctioned bouts in stage' });
    expect(byKey(rows, 'criterion_id', 'pgc_00000000000003')).toMatchObject({ min_score: '4.5', combine: 'any', item_numbers: '1', scorecard_item_ids: 'sci_3e422ec1f94b2a' });
    expect(byKey(rows, 'criterion_id', 'pgc_00000000000004')).toMatchObject({
      gate_id: 'pgt_00000000000002', ref_stage_key: 'T1', ref_gate_kind: 'exit', ref_gate_id: 'pgt_b2023fc2fea6e0',
    });
  });

  it('reads the scale key and the cap\'s scope as INFERRED, and keeps every frozen wording', () => {
    const items = rowsOf(read(first.out, 'seed_scorecard_items.csv'));
    expect(byKey(items, 'scorecard_item_id', 'sci_3e422ec1f94b2a')).toMatchObject({ scale_key: 'live_long_road', item_group: 'foundations', scorable_contexts: 'drill|live' });
    expect(JSON.parse(byKey(items, 'scorecard_item_id', 'sci_3e422ec1f94b2a').field_labels)).toMatchObject({ scale_key: { status: 'INFERRED' }, scorable_contexts: { status: 'INFERRED' } });
    const gap = byKey(items, 'scorecard_item_id', 'sci_98fe7063b799ea');
    expect(gap).toMatchObject({ scale_key: '', protocol_id: '', gaps: 'no scale in the source; not scorable until a scale is set (D-PK119)' });
    expect(JSON.parse(gap.field_labels).scorecard_item_id.note).toContain('LR-131:fight_iq_components');
    const [cap] = rowsOf(read(first.out, 'seed_scorecard_score_caps.csv'));
    expect(cap).toMatchObject({ cap_key: 'non_contact_rule', scale_key: 'live_long_road', max_score: '3', applies_to_protocol_id: 'PP-T01', applies_to_contexts: 'drill|shadow|partner', status: 'OBSERVED' });
    const scales = rowsOf(read(first.out, 'seed_scorecard_scales.csv'));
    expect(byKey(scales, 'scale_key', 'cue_response_draft')).toMatchObject({ min_level: '1', max_level: '5', status: 'INFERRED', note: expect.stringContaining('D-Q10') });
    expect(byKey(rowsOf(read(first.out, 'seed_scorecard_anchor_clip_specs.csv')), 'anchor_spec_id', 'acs_de74867602ddb4')).toMatchObject({ used_by_stage_keys: 'Y3|T1' });
    expect(JSON.parse(byKey(rowsOf(read(first.out, 'seed_pathway_gates.csv')), 'gate_id', 'pgt_00000000000002').field_labels)).toEqual({ gate_kind: { note: 'a note on the kind' } });
  });

  it('keeps licensed excerpts out and the citation in', () => {
    const gates = read(first.out, 'seed_pathway_gates.csv');
    expect(gates).not.toContain('a licensed passage');
    expect(gates).not.toContain('"quotes"');
    expect(gates).toContain('ACSM-3PCT');
    expect(gates).toContain('EXT-ACSM-2021');
    expect(first.stdout).toContain("evidence 'quotes' (licensed excerpts, OD-2026-10-02-013 2A) not carried: 1 keys, 2 passages");
  });

  it('a second run over the first run\'s output is byte-identical', () => {
    const again = exportInto(dir, first.out);
    expect(again.status).toBe(2);
    for (const name of FILES) expect(read(again.out, name)).toBe(read(first.out, name));
  });

  it('will not overwrite a committed row edited after the export unless --allow-overwrite, and then lists it', () => {
    const seed = tempDir();
    fs.cpSync(first.out, seed, { recursive: true });
    const file = path.join(seed, DIR, 'seed_pathway_gates.csv');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('progression_decision_request', 'edited by hand'));
    const refused = exportInto(dir, seed);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('seed_pathway_gates.csv pgt_b2023fc2fea6e0: changes override_process');
    expect(fs.readFileSync(path.join(refused.out, DIR, 'seed_pathway_gates.csv'), 'utf8')).toContain('edited by hand');
    const forced = exportInto(dir, seed, ['--allow-overwrite']);
    expect(forced.stdout).toContain('OVERWROTE (--allow-overwrite):');
    expect(read(forced.out, 'seed_pathway_gates.csv')).toBe(read(first.out, 'seed_pathway_gates.csv'));
  });

  it('stops on a hash that differs from the manifest, an unknown key, an unknown scale text, a reworded cap or a gate that does not only inform', () => {
    const stops: [string, string][] = [
      [backbone(catalogs(), (folder) => fs.appendFileSync(path.join(folder, CATALOGS), ' ')), 'differs from FREEZE_MANIFEST.json'],
      [backbone(catalogs({ extra_section: [] })), 'key "extra_section" has no column'],
      [backbone(catalogs({ scorecard_items: [{ ...(catalogs().scorecard_items as Json[])[0], scale: '1-10 (made up)' }] })), 'names no known scale'],
      [backbone(catalogs({ scale_definitions: { ...(catalogs().scale_definitions as Json), non_contact_rule: { ...((catalogs().scale_definitions as Json).non_contact_rule as Json), applies_to: 'every item' } } })), 'non_contact_rule: its wording differs'],
      [backbone(catalogs({ gates: [{ ...(catalogs().gates as Json[])[1], informs_only: false }] })), 'a gate only informs'],
    ];
    for (const [folder, message] of stops) {
      const result = exportInto(folder);
      expect([message, result.status]).toEqual([message, 1]);
      expect(result.stderr).toContain(message);
      expect(fs.existsSync(path.join(result.out, DIR))).toBe(false);
    }
  });
});

describe('the committed assessment-catalog seed', () => {
  it('takes no name of one of the app\'s own protocols (ensurePpbfAssessmentProtocols)', () => {
    const names = rowsOf(fs.readFileSync(path.join(SEED_DIR, DIR, 'seed_assessment_protocols.csv'), 'utf8')).map((row) => row.name);
    expect(names.length).toBe(46);
    const builtIn = PPBF_ASSESSMENT_PROTOCOLS.map((protocol) => protocol.name);
    expect(names.filter((name) => builtIn.includes(name) || name.startsWith('Skill rating: '))).toEqual([]);
  });

  const haveFrozen = fs.existsSync(path.join(FROZEN, CATALOGS));
  (haveFrozen ? it : it.skip)('regenerates byte for byte from the frozen Backbone (skipped where that folder is absent)', () => {
    const result = exportInto(FROZEN, SEED_DIR);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('counts: protocols 46, scales 2, caps 1, items 29, gates 38, criteria 94, anchorSpecs 105, excerptKeys 4, excerptPassages 10');
    for (const name of FILES) expect(read(result.out, name)).toBe(fs.readFileSync(path.join(SEED_DIR, DIR, name), 'utf8'));
  });
});
