import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCsv } from '../src/server/pilot/contentImport/csv';
import { FILE_SPECS } from '../src/server/pilot/contentImport/specs';

// Lane FT1b: the Backbone -> FT1 track exporter, over a small fixture Backbone built here
// (1 track, 2 blocks, 3 block sessions on 2 templates, 3 drills: one reached through a template
// item, one through a block's optional_drill_refs, one free-text item) with its own manifest.

const SCRIPT = path.resolve(__dirname, 'backbone-export-ft1-track.mjs');
const SEED_DATA_DIR = path.resolve(__dirname, '../seed-data');
const ORG = '{{PPBF_ORG_ID}}';
const TRACK = 'trk_d104860a7eccef';
const B1 = 'trb_000000000000a1';
const B2 = 'trb_000000000000a2';
const T1 = 'wtp_000000000000b1';
const T2 = 'wtp_000000000000b2';
const D1 = 'drl_000000000000c1';
const D2 = 'drl_000000000000c2';
const D3 = 'drl_000000000000c3';

type Json = Record<string, unknown>;
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-ft1-export-test-'));
  temps.push(dir);
  return dir;
}
const sha16 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

const labels = (fields: string[]) => Object.fromEntries(fields.map((field) => [field, { status: 'OBSERVED', sources: ['DOC-123'] }]));
const evidence = () => [{ evidence_category: 'convention', evidence_label: 'CONVENTION', check_state: 'verified', evidence_item_ids: [], registry_claim_ids: [], covers: ['CL-1'], source: 'DOC-123' }];

function drill(id: string, extra: Json = {}): Json {
  return {
    organization_id: ORG, drill_id: id, lineage_id: id, name: `Drill ${id}`, discipline: 'boxing', category: 'footwork', target_behavior: 'hold position', purpose: 'purpose',
    standard_setup: 'set up', execution: 'run it', what_good_looks_like: null, what_bad_looks_like: 'bad', common_errors: 'errors', corrections: 'fix', transfer: null,
    contact_level: 'none', equipment_needed: null, requires_coach_authorization: false, content_class: 'PPBF class material', source_ref: 'DOC-123', difficulty: 'beginner',
    grounding_claim_ids: [], cues: [{ cue_id: `cue_${id.slice(4)}`, cue_text: `Get set first ${id}.`, focus_type: 'unspecified', source_ref: 'DOC-123' }],
    stop_rules: [], scale_levels: [], field_provenance: 'PPBF owner-authored', active: true, status: 'REPORTED', sources: ['DOC-123'], stage_keys: ['FT1'],
    stage_links: [{ target_kind: 'drill', target_lineage_id: id, stage_key: 'FT1', role: 'core', lane: null }], evidence: evidence(), field_labels: labels(['name', 'purpose']), ...extra,
  };
}
function template(id: string, items: Json[], extra: Json = {}): Json {
  return {
    organization_id: ORG, session_kind: 'template', template_id: id, lineage_id: id, name: `Session ${id}`, session_type: 'technical', difficulty: 'beginner', age_band: 'any',
    duration_minutes: 45, intent: 'intent', coach_notes: 'Get set first.', requires_coach_authorization: false, contact_structure: 'non_contact', items, track_id: TRACK,
    active: true, status: 'REPORTED', sources: ['DOC-123'], stage_keys: ['FT1'], stage_links: [], evidence: evidence(), field_labels: labels(['name']), ...extra,
  };
}
function block(id: string, order: number, refs: Json[], extra: Json = {}): Json {
  return {
    organization_id: ORG, track_block_id: id, lineage_id: id, track_id: TRACK, block_order: order, title: `Week ${order}`, weeks: 1, description: `Description ${order}`,
    session_refs: refs, optional_drill_refs: [], active: true, status: 'REPORTED', sources: ['DOC-123', 'Jason 2026-10-24 (RULES s9, First class track)'], stage_keys: ['FT1'],
    evidence: evidence(), field_labels: labels(['title']), ...extra,
  };
}
const track = (extra: Json = {}): Json => ({
  organization_id: ORG, track_id: TRACK, lineage_id: TRACK, name: '8-Week Non-Contact Boxing Pilot Program', lane: 'standard', track: 'fitness', duration_weeks: 8,
  delivered_to_program_id: null, age_band: 'all ages', decision_cycle: 'Observe, Decide, Execute, Reset', daily_domain_order: ['Footwork'], domain_roles: { Footwork: 'x' },
  weekly_rhythm: { Monday: 'm' }, friday_protocol: ['a'], week_titles: ['Week 1'], punch_introduction_guideline: ['p'], primary_cue: 'Get set first.',
  coach_intervention_standards: ['c'], source_references_note: 'none', block_ids: [B1, B2], active: true, status: 'REPORTED', sources: ['DOC-123'], stage_keys: ['FT1'],
  stage_links: [], evidence: evidence(), field_labels: labels(['name']), ...extra,
});

interface Fixture { track: Json; blocks: Json[]; templates: Json[]; drills: Json[] }
function fixture(): Fixture {
  return {
    track: track(),
    blocks: [
      block(B1, 1, [{ week: 1, day: 'Monday', template_id: T1 }, { week: 1, day: 'Friday', template_id: T2 }], { optional_drill_refs: [D3] }),
      block(B2, 2, [{ week: 2, day: 'Monday', template_id: T1 }]),
    ],
    templates: [
      template(T2, [{ item_id: 'wti_000000000000d3', ordinal: 1, block: 'observation', contact_level: 'none', free_text_drill: 'Watch sparring' }], { session_type: 'observation' }),
      template(T1, [{ item_id: 'wti_000000000000d1', ordinal: 1, block: 'footwork', contact_level: 'none', drill_id: D1, scale_level: null },
        { item_id: 'wti_000000000000d2', ordinal: 2, block: 'defense', contact_level: 'light_technical', drill_id: D2, scale_level: null }]),
    ],
    drills: [drill(D1), drill(D2, { stop_rules: [{ stop_rule_id: 'stp_000000000000e1', ordinal: 1, condition_text: 'loses stance', scope: 'drill_specific', rule_kind: 'technique_degradation' }] }), drill(D3)],
  };
}

/** Write a Backbone folder with a manifest; `after` may tamper with files once the manifest is written. */
function backbone(data: Fixture = fixture(), after?: (dir: string) => void): string {
  const dir = tempDir();
  const files: { path: string; sha256_16: string }[] = [];
  const write = (folder: string, id: string, record: Json) => {
    const rel = `data/content/${folder}/${id}.json`;
    const text = JSON.stringify({ status_line: 'Status: DRAFT', record_kind: 'x', gaps: ['a gap'], review_notes: [], conversion: {}, record }, null, 2);
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
    files.push({ path: rel, sha256_16: sha16(text) });
  };
  write('tracks', TRACK, data.track);
  for (const item of data.blocks) write('blocks', item.track_block_id as string, item);
  for (const item of data.templates) write('sessions', item.template_id as string, item);
  for (const item of data.drills) write('drills', item.drill_id as string, item);
  fs.writeFileSync(path.join(dir, 'FREEZE_MANIFEST.json'), JSON.stringify({ files }));
  after?.(dir);
  return dir;
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Run the exporter into a copy of `seed` (or an empty folder); returns the folder and the run. */
function exportInto(dir: string, seed?: string) {
  const out = tempDir();
  if (seed) fs.cpSync(seed, out, { recursive: true });
  return { out, ...run([dir, '--out', out]) };
}
const read = (out: string, name: string) => fs.readFileSync(path.join(out, name), 'utf8');
function rowsOf(text: string): Record<string, string>[] {
  const table = readCsv(text);
  expect(table.problems).toEqual([]);
  return table.records.map((record) => Object.fromEntries(table.header.map((name, index) => [name, record.cells[index]])));
}
const DRILLS = 'drill-library/seed_drill_library.csv';
const TEMPLATES = 'workout-templates/seed_workout_templates.csv';
const ITEMS = 'workout-templates/seed_workout_template_items.csv';
const TRACKS = 'training-tracks/seed_training_tracks.csv';
const BLOCKS = 'training-tracks/seed_track_blocks.csv';
const SESSIONS = 'training-tracks/seed_track_block_sessions.csv';
const CUES = 'drill-library/seed_drill_cues.csv';
const STOPS = 'drill-library/seed_drill_stop_rules.csv';

describe('backbone-export-ft1-track', () => {
  const dir = backbone();
  const first = exportInto(dir);

  it('writes the eight package files, each header the spec\'s column list in order', () => {
    expect(first.stderr).toBe('');
    // exit 2 = counts differ from the brief's (the fixture is small on purpose); the files are still written.
    expect(first.status).toBe(2);
    for (const name of [DRILLS, CUES, STOPS, TEMPLATES, ITEMS, TRACKS, BLOCKS, SESSIONS]) {
      const spec = FILE_SPECS.find((file) => file.file === path.basename(name));
      expect(spec).toBeDefined();
      expect(readCsv(read(first.out, name)).header).toEqual(spec!.columns.map((column) => column.name));
    }
  });

  it('reports each count that differs from the brief, by name', () => {
    expect(first.stdout).toContain('COUNTS DIFFER FROM THE BRIEF');
    expect(first.stdout).toContain('drills: brief 131, observed 3');
    expect(first.stdout).toContain('session_type values: technical 1, observation 1');
  });

  it('writes drills with cues and own stop rules, blank for null, labels as JSON and a | list', () => {
    const rows = rowsOf(read(first.out, DRILLS));
    expect(rows.map((row) => row.drill_id)).toEqual([D1, D2, D3]);
    expect(rows[0]).toMatchObject({ organization_id: ORG, lineage_id: D1, version: '1', what_good_looks_like: '', transfer: '', equipment_needed: '', stage_keys: 'FT1', active: 'true', requires_coach_authorization: 'false' });
    expect(JSON.parse(rows[0].field_labels)).toEqual(labels(['name', 'purpose']));
    expect(JSON.parse(rows[0].evidence)).toEqual(evidence());
    expect(rowsOf(read(first.out, CUES)).map((row) => [row.drill_id, row.focus_type])).toEqual([[D1, 'unspecified'], [D2, 'unspecified'], [D3, 'unspecified']]);
    expect(rowsOf(read(first.out, STOPS))).toEqual([{ organization_id: ORG, stop_rule_id: 'stp_000000000000e1', drill_id: D2, ordinal: '1', condition_text: 'loses stance', scope: 'drill_specific', rule_kind: 'technique_degradation' }]);
  });

  it('writes templates with items: drill or free text, contact_level kept, nothing else invented', () => {
    expect(rowsOf(read(first.out, TEMPLATES)).map((row) => [row.template_id, row.session_type])).toEqual([[T1, 'technical'], [T2, 'observation']]);
    const items = rowsOf(read(first.out, ITEMS));
    expect(items.map((row) => [row.template_id, row.ordinal, row.drill_id, row.free_text_drill, row.contact_level, row.scale_level, row.duration_minutes, row.rep_count])).toEqual([
      [T1, '1', D1, '', 'none', '', '', ''],
      [T1, '2', D2, '', 'light_technical', '', '', ''],
      [T2, '1', '', 'Watch sparring', 'none', '', '', ''],
    ]);
  });

  it('writes the track, blocks and block sessions in the FT1a form', () => {
    const [trackRow] = rowsOf(read(first.out, TRACKS));
    expect(trackRow).toMatchObject({ track_id: TRACK, lineage_id: TRACK, lane: 'standard', track: 'fitness', duration_weeks: '8', delivered_to_program_id: '', stage_keys: 'FT1', sources: '["DOC-123"]' });
    expect(Object.keys(JSON.parse(trackRow.details)).sort()).toEqual(['coach_intervention_standards', 'daily_domain_order', 'decision_cycle', 'domain_roles', 'friday_protocol',
      'primary_cue', 'punch_introduction_guideline', 'source_references_note', 'week_titles', 'weekly_rhythm']);
    const blocks = rowsOf(read(first.out, BLOCKS));
    expect(blocks.map((row) => [row.track_block_id, row.block_lineage_id, row.block_order, row.stage_keys])).toEqual([[B1, B1, '1', '["FT1"]'], [B2, B2, '2', '["FT1"]']]);
    expect(JSON.parse(blocks[0].sources)).toEqual(['DOC-123', 'Jason 2026-10-24 (RULES s9, First class track)']);
    expect(JSON.parse(blocks[0].details)).toEqual({ description: 'Description 1', optional_drill_refs: [D3] });
    expect(rowsOf(read(first.out, SESSIONS)).map((row) => [row.block_order, row.ordinal, row.week, row.day, row.template_lineage_id, row.block_session_id])).toEqual([
      ['1', '1', '1', 'Monday', T1, ''], ['1', '2', '1', 'Friday', T2, ''], ['2', '1', '2', 'Monday', T1, ''],
    ]);
  });

  it('prints every record key it does not carry, and the excerpt count', () => {
    expect(first.stdout).toContain('drill.status x3');
    expect(first.stdout).toContain('template.track_id x2');
    expect(first.stdout).toContain('track.stage_links x1');
    expect(first.stdout).toContain('licensed excerpt keys (quote, quotes, owner_passages) dropped: 0');
  });

  it('a second run over the first run\'s output is byte-identical', () => {
    const before = Object.fromEntries([DRILLS, CUES, STOPS, TEMPLATES, ITEMS, TRACKS, BLOCKS, SESSIONS].map((name) => [name, read(first.out, name)]));
    const second = run([dir, '--out', first.out]);
    expect(second.status).toBe(2);
    for (const [name, text] of Object.entries(before)) expect(read(first.out, name)).toBe(text);
  });

  it('adds to a committed file: an existing row keeps its values and place, gains blank label cells, and is not duplicated on a rerun', () => {
    const seed = tempDir();
    const oldHeader = readCsv(read(SEED_DATA_DIR, DRILLS)).header.filter((column) => !['field_labels', 'evidence', 'stage_keys'].includes(column));
    const old = Object.fromEntries(oldHeader.map((column) => [column, column === 'organization_id' ? ORG : column === 'drill_id' || column === 'lineage_id' ? 'drl_0000000000aaaa' : column === 'version' ? '1' : column === 'active' ? 'true' : column === 'requires_coach_authorization' ? 'false' : `old ${column}`]));
    fs.mkdirSync(path.join(seed, 'drill-library'), { recursive: true });
    fs.writeFileSync(path.join(seed, DRILLS), `${oldHeader.join(',')}
${oldHeader.map((column) => old[column]).join(',')}
`);
    const out = exportInto(dir, seed).out;
    const rows = rowsOf(read(out, DRILLS));
    expect(rows.map((row) => row.drill_id)).toEqual(['drl_0000000000aaaa', D1, D2, D3]);
    expect(rows[0]).toMatchObject({ ...old, field_labels: '', evidence: '', stage_keys: '' });
    run([dir, '--out', out]);
    expect(rowsOf(read(out, DRILLS))).toHaveLength(4);
  });

  it('a rerun replaces the cues of a drill and the items of a template as a whole, and stops on a foreign organization_id or an inactive block', () => {
    const changed = fixture();
    (changed.drills[0].cues as Json[])[0].cue_text = 'A reworded cue.';
    changed.templates[1].items = (changed.templates[1].items as Json[]).slice(0, 1);
    changed.blocks[1].optional_drill_refs = [D2]; // D2 stays reachable, now without its template item
    const rerun = exportInto(backbone(changed), first.out);
    expect(rowsOf(read(rerun.out, CUES)).filter((row) => row.drill_id === D1).map((row) => row.cue_text)).toEqual(['A reworded cue.']);
    expect(rowsOf(read(rerun.out, ITEMS)).filter((row) => row.template_id === T1)).toHaveLength(1);
    const foreign = fixture();
    foreign.drills[0].organization_id = 'other_org';
    expect(exportInto(backbone(foreign)).stderr).toContain('organization_id "other_org"');
    const inactive = fixture();
    inactive.blocks[0].active = false;
    expect(exportInto(backbone(inactive)).stderr).toContain('only an active block can be exported');
  });

  it('stops on a file whose hash differs from the manifest, or that the manifest does not list', () => {
    const tampered = backbone(fixture(), (root) => fs.appendFileSync(path.join(root, `data/content/drills/${D1}.json`), ' '));
    const result = exportInto(tampered);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`data/content/drills/${D1}.json: hash`);
    const extra = backbone(fixture(), (root) => fs.writeFileSync(path.join(root, 'data/content/drills/drl_ffffffffffffff.json'), '{"record":{}}'));
    expect(exportInto(extra).stderr).toContain('is not in FREEZE_MANIFEST.json');
  });

  it('stops on a record key that has no column and is not on the not-carried list', () => {
    const data = fixture();
    data.drills[0].surprise_field = 'x';
    const result = exportInto(backbone(data));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('key "surprise_field" has no column');
  });

  it('drops quote, quotes and owner_passages at every depth, keeps the citation, and counts them', () => {
    const data = fixture();
    data.drills[0].evidence = [{ ...(evidence()[0]), quotes: ['a licensed passage'], beside: [{ quote: 'another', source: 'DOC-1' }] }];
    data.drills[1].field_labels = { name: { status: 'OBSERVED', sources: ['DOC-123'], owner_passages: ['p'] } };
    const result = exportInto(backbone(data));
    const text = read(result.out, DRILLS);
    expect(text).not.toMatch(/licensed passage|another|"owner_passages"|"quotes"|"quote"/);
    expect(text).toContain('DOC-123');
    expect(result.stdout).toContain('dropped: 3');
  });

  it('stops when the track\'s block_ids differ from the blocks in block_order', () => {
    const data = fixture();
    data.track.block_ids = [B2, B1];
    expect(exportInto(backbone(data)).stderr).toContain('block_ids');
  });

  it('stops when the set reachable from the track differs from the stage_keys ["FT1"] set', () => {
    const data = fixture();
    data.drills.push(drill('drl_000000000000c9'));
    expect(exportInto(backbone(data)).stderr).toContain('differ from those with stage_keys ["FT1"]');
  });

  it('stops on a value that is not the type the column takes, never converting it', () => {
    const data = fixture();
    data.templates[0].duration_minutes = '45';
    expect(exportInto(backbone(data)).stderr).toContain('duration_minutes is "45", not a number');
  });
});

describe('the committed FT1 rows', () => {
  const count = (name: string, pick: (row: Record<string, string>) => boolean) => rowsOf(fs.readFileSync(path.join(SEED_DATA_DIR, name), 'utf8')).filter(pick).length;
  it('leave every row that is not FT1 with blank label cells: only the three label columns were added to the two root files', () => {
    for (const [name, key] of [[DRILLS, 'drill_id'], [TEMPLATES, 'template_id']] as const) {
      const rows = rowsOf(fs.readFileSync(path.join(SEED_DATA_DIR, name), 'utf8'));
      const others = rows.filter((row) => row.stage_keys !== 'FT1');
      expect(others.length).toBeGreaterThan(0);
      for (const row of others) expect([key, row.field_labels, row.evidence, row.stage_keys]).toEqual([key, '', '', '']);
    }
  });
  it('are 131 drills, 131 cues, 9 stop rules, 33 templates, 131 items, 1 track, 8 blocks and 40 block sessions', () => {
    expect(count(DRILLS, (row) => row.stage_keys === 'FT1')).toBe(131);
    expect(count(TEMPLATES, (row) => row.stage_keys === 'FT1')).toBe(33);
    expect(rowsOf(fs.readFileSync(path.join(SEED_DATA_DIR, TRACKS), 'utf8'))).toHaveLength(1);
    expect(rowsOf(fs.readFileSync(path.join(SEED_DATA_DIR, BLOCKS), 'utf8'))).toHaveLength(8);
    expect(rowsOf(fs.readFileSync(path.join(SEED_DATA_DIR, SESSIONS), 'utf8'))).toHaveLength(40);
    const drillIds = new Set(rowsOf(fs.readFileSync(path.join(SEED_DATA_DIR, DRILLS), 'utf8')).filter((row) => row.stage_keys === 'FT1').map((row) => row.drill_id));
    expect(count(CUES, (row) => drillIds.has(row.drill_id))).toBe(131);
    expect(count(STOPS, (row) => drillIds.has(row.drill_id))).toBe(9);
    const templateIds = new Set(rowsOf(fs.readFileSync(path.join(SEED_DATA_DIR, TEMPLATES), 'utf8')).filter((row) => row.stage_keys === 'FT1').map((row) => row.template_id));
    expect(count(ITEMS, (row) => templateIds.has(row.template_id))).toBe(131);
  });
});
