import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCsv, writeCsv } from '../src/server/pilot/contentImport/csv';
import { FILE_SPECS } from '../src/server/pilot/contentImport/specs';

// Lane YR (YR-b): the Backbone -> youth + recreational exporter, over a small fixture Backbone
// built here (a library track, the DOC-154 track, a class track with one block, two templates,
// the script session, and records of other lanes it must leave out), plus checks on the
// committed seed: it regenerates byte for byte from the frozen Backbone when that folder is on
// this machine (skipped elsewhere), and every reference the loaded rows hold resolves.

const SCRIPT = path.resolve(__dirname, 'backbone-export-youth-recreational.mjs');
const SEED_DIR = path.resolve(__dirname, '../seed-data');
const FROZEN = 'C:\\Users\\jason\\OneDrive - PUNXSY PROMINENCE BOXING AND FITNESS\\PPBF-AI-Lanes\\Research\\Backbone';
const ORG = '{{PPBF_ORG_ID}}';

const TEMPLATES = 'workout-templates/seed_workout_templates.csv';
const ITEMS = 'workout-templates/seed_workout_template_items.csv';
const TRACKS = 'training-tracks/seed_training_tracks.csv';
const BLOCKS = 'training-tracks/seed_track_blocks.csv';
const SESSIONS = 'training-tracks/seed_track_block_sessions.csv';
const SCRIPTS = 'session-scripts/seed_session_scripts.csv';
const SCRIPT_BLOCKS = 'session-scripts/seed_session_script_blocks.csv';
const RENDERINGS = 'session-scripts/seed_session_script_renderings.csv';
const DRILLS = 'drill-library/seed_drill_library.csv';
const WRITTEN = [TEMPLATES, ITEMS, TRACKS, BLOCKS, SESSIONS, SCRIPTS, SCRIPT_BLOCKS];

const LIBRARY = 'trk_00000000000001';
const DOC154 = 'trk_98f1b755dce913';
const CLASS = 'trk_00000000000003';
const FT1_TRACK = 'trk_d104860a7eccef';
const AMATEUR = 'trk_00000000000009';
const B1 = 'trb_00000000000001';
const T1 = 'wtp_00000000000001';
const T2 = 'wtp_00000000000002';
const T_FT1 = 'wtp_0000000000000f';
const SCR = 'scr_e2ed38b1a19670';
const D1 = 'drl_00000000000001';
const HELD = ['wtp_40b6956ea37245', 'wtp_0f42c41a78dea4', 'wtp_fb399b5d31e70d', 'wtp_35c593e3b96cdf', 'wtp_b965c8174bd41a', 'wtp_f20745471ef7c4'];

const SHEET_1 = 'THURSDAY – REST / WEIGH-IN (Walk, Stretch, Rehydrate, Early sleep)';
const SHEET_2 = 'REST / WEIGH-IN: Walk + stretch | Rehydrate smart | Early sleep';
const LINE = "'Day-before' conflicts with USA Boxing 2026 Rule 11.1(2) (weigh in on the day they box) on the USA Boxing route; 11.2 events use the same 'Daily weigh-in' (INFERRED same day).";

type Json = Record<string, unknown>;
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-yr-export-test-'));
  temps.push(dir);
  return dir;
}
const sha16 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const labels = (fields: string[]) => Object.fromEntries(fields.map((field) => [field, { status: 'OBSERVED', sources: ['DOC-151'] }]));
const research = () => ({
  evidence_category: 'research', evidence_label: 'EMERGING', check_state: 'verified', evidence_item_ids: [], registry_claim_ids: [], covers: ['CL-1'],
  citation: 'Someone et al. 2020', source_id: 'EXT-X', quote: 'A licensed sentence that must never reach the repository.',
  // A note sentence that repeats the quote goes; the rest of the note, and a note with only numbers, stay.
  sp10: { limitations: 'A licensed sentence that must never reach the repository. The Backbone note stays.', population: 'n = 12 boxers; g = 0.67' },
});
const passage = () => ({ doc: 'DOC-027', doc_title: 'Punxsy Master Source Manual v1', section: 'Cue Selection Standard', standards: ['Choose the shortest phrase.'], beside: ['groups'], read_for: 'LR-1', difference: null });

const track = (id: string, stageKeys: string[], extra: Json = {}): Json => ({
  organization_id: ORG, track_id: id, lineage_id: id, name: `Track ${id}`, lane: 'standard', track: null, delivered_to_program_id: null, age_band: 'any',
  part_heading: 'PART 1', chapter_heading: '1. Chapter', groups: [{ order: 1, section: 'LR-1', heading: '1.1 Heading', source: 'LR-1', blocks: [{ type: 'text', text: '  Kept with its spaces  ' }], drill_refs: [] }],
  session_refs: [], active: true, status: 'REPORTED', sources: ['LR-1'], stage_keys: stageKeys, stage_links: [], evidence: [research()], field_labels: labels(['name']), ...extra,
});
const doc154 = (sheet1 = SHEET_1): Json => track(DOC154, ['Y2', 'Y3', 'Y4', 'Y5'], {
  part_heading: null, chapter_heading: null, publisher_line: null, subtitle: null, field_provenance: 'PPBF owner-authored', evidence: [],
  groups: [
    { order: 1, section: 'DOC-154 sheet 1', heading: 'FIGHT WEEK CHECKLIST', source: 'DOC-154', drill_refs: [],
      blocks: ['a', 'b', 'c', 'd', 'e', sheet1, 'f'].map((text) => ({ type: 'checkbox', text })) },
    { order: 2, section: 'DOC-154 sheet 2', heading: 'FIGHT WEEK TRAINING SHEET', source: 'DOC-154', drill_refs: [],
      blocks: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'THU', SHEET_2].map((text) => ({ type: 'text', text })) },
  ],
});
const item = (ordinal: number, extra: Json = {}): Json => ({ item_id: `wti_0000000000000${ordinal}`, ordinal, block: 'warmup', contact_level: 'none', ...extra });
const template = (id: string, stageKeys: string[], items: Json[], extra: Json = {}): Json => ({
  organization_id: ORG, session_kind: 'template', template_id: id, lineage_id: id, name: `Session ${id}`, session_type: null, age_band: 'youth', duration_minutes: null,
  intent: 'Learn the jab.', coach_notes: null, requires_coach_authorization: false, contact_structure: 'non_contact', items, track_id: CLASS, active: true,
  status: 'REPORTED', sources: ['DOC-151'], stage_keys: stageKeys, stage_links: [], evidence: [], field_labels: labels(['name']), ...extra,
});
const script = (extra: Json = {}): Json => ({
  organization_id: ORG, session_kind: 'script', script_id: SCR, lineage_id: SCR, name: 'Week 2 Monday', discipline: 'boxing', theme: 'Jab', phase: 'Accumulation',
  day_of_week: 'Monday', total_minutes: 120, contact_structure: 'split_non_contact_then_contact', target_group: null, prerequisite_note: null,
  reset_protocol: 'Freeze.', coach_priorities: 'Safety', frequent_phrases: null, authoring_state: 'coach_reviewed', source_document: 'Week_2_Monday (PPBF)',
  blocks: [
    { block_id: 'blk_00000000000001', block_order: 1, start_offset_min: 0, end_offset_min: 5, block_label: 'Instruction', what_to_say: 'Circle up.', block_kind: 'instruction', contact_level: 'none' },
    { block_id: 'blk_00000000000002', block_order: 2, start_offset_min: 5, end_offset_min: 15, block_label: 'Sparring', what_to_say: 'Touch gloves.', block_kind: 'drill_round', contact_level: 'controlled_sparring' },
  ],
  renderings: [{ rendering_id: 'rnd_00000000000001', format: 'cheat_sheet', audience_note: 'Coach', body: 'LINE ONE\r\nLINE TWO', generated_from_blocks: false }],
  active: true, status: 'REPORTED', sources: ['DOC-091'], stage_keys: ['Y3', 'Y4', 'Y5'], stage_links: [], evidence: [], field_labels: labels(['name']), ...extra,
});

interface Fixture { tracks: Json[]; blocks: Json[]; sessions: Json[]; spine: Json }
function fixture(): Fixture {
  return {
    tracks: [
      track(LIBRARY, ['Y3', 'T1'], { owner_passages: [passage()], field_labels: { ...labels(['name']), owner_passages: { status: 'REPORTED', sources: ['DOC-027'] } } }),
      doc154(),
      track(CLASS, ['Y1', 'Y2'], { groups: undefined, part_heading: undefined, chapter_heading: undefined, duration_weeks: 12, block_ids: [B1], session_minutes: 60 }),
      track(FT1_TRACK, ['FT1']),
      track(AMATEUR, ['AM1']),
    ],
    blocks: [{
      organization_id: ORG, track_block_id: B1, lineage_id: B1, track_id: CLASS, block_order: 1, title: 'Weeks 1–4', weeks: 4, description: 'Focus',
      session_refs: [{ week: 1, day: 'Monday', template_id: T1 }, { week: 1, day: 'Tuesday', template_id: T2 }], optional_drill_refs: [], active: true,
      status: 'REPORTED', sources: ['DOC-151'], stage_keys: ['Y1', 'Y2'], evidence: [], field_labels: labels(['title']),
    }],
    sessions: [
      template(T1, ['Y1', 'Y2'], [
        item(1, { drill_id: D1 }),
        item(2, { free_text_drill: 'Jump rope', phase: 'Warm-Up', time: '5 min', parts: { Drill: ['Jump rope.'] } }),
        item(3, { block: 'sparring', contact_level: 'controlled_sparring', free_text_drill: 'Technical sparring', duration_minutes: 20 }),
      ], { difficulty: 'beginner', owner_passages: [passage()] }),
      template(T2, ['RC1'], [item(1, { item_id: 'wti_00000000000021', free_text_drill: 'Shadow' })], { duration_minutes: 45 }),
      template(T_FT1, ['FT1'], [item(1, { item_id: 'wti_000000000000f1', free_text_drill: 'FT1 only' })]),
      // The six DOC-136 days are held (OD-2026-10-02-013 2A): in the set by stage, never exported.
      ...HELD.map((id, index) => template(id, ['Y1', 'RC1'], [item(1, { item_id: `wti_00000000000h${index}`, free_text_drill: 'Printed outside text' })])),
      script(),
    ],
    spine: { stages: [{ defaults: [{ claims: [`USAB-R11 (RULE): ... | Note: ${LINE}`] }] }] },
  };
}

function backbone(data: Fixture = fixture(), after?: (dir: string) => void): string {
  const dir = tempDir();
  const files: { path: string; sha256_16: string }[] = [];
  const write = (rel: string, body: Json) => {
    const text = JSON.stringify(body, null, 2);
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
    files.push({ path: rel, sha256_16: sha16(text) });
  };
  const wrap = (record: Json) => ({ status_line: 'Status: DRAFT', record_kind: 'x', gaps: [], review_notes: [], conversion: {}, record });
  for (const record of data.tracks) write(`data/content/tracks/${record.track_id}.json`, wrap(record));
  for (const record of data.blocks) write(`data/content/blocks/${record.track_block_id}.json`, wrap(record));
  for (const record of data.sessions) write(`data/content/sessions/${(record.template_id ?? record.script_id) as string}.json`, wrap(record));
  write('data/spine/spine.json', data.spine);
  fs.writeFileSync(path.join(dir, 'FREEZE_MANIFEST.json'), JSON.stringify({ files }));
  after?.(dir);
  return dir;
}

const csvText = (header: string[], rows: Record<string, string>[]) => writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? '')));
/** A committed seed folder: the drill the template names, the script with its rendering, and the FT1 track row. */
function seed(scriptRow: Record<string, string> = {}): string {
  const dir = tempDir();
  const put = (name: string, text: string) => {
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };
  put(DRILLS, csvText(['organization_id', 'drill_id', 'name'], [{ organization_id: ORG, drill_id: D1, name: 'Jab' }]));
  put(SCRIPTS, csvText(
    ['organization_id', 'script_id', 'lineage_id', 'version', 'name', 'discipline', 'theme', 'phase', 'day_of_week', 'total_minutes', 'contact_structure', 'target_group',
      'prerequisite_note', 'reset_protocol', 'coach_priorities', 'frequent_phrases', 'authoring_state', 'source_document', 'created_by_account_id'],
    [
      { organization_id: ORG, script_id: 'scr_00000000000077', lineage_id: 'scr_00000000000077', version: '1', name: 'Another script', discipline: 'boxing', authoring_state: 'draft' },
      { organization_id: ORG, script_id: SCR, lineage_id: SCR, version: '1', name: 'Week 2 Monday', discipline: 'boxing', theme: 'Jab', phase: 'Accumulation', day_of_week: 'Monday',
        total_minutes: '120', contact_structure: 'split_non_contact_then_contact', reset_protocol: 'Freeze.', coach_priorities: 'Safety', authoring_state: 'coach_reviewed',
        source_document: 'Week_2_Monday (PPBF)', created_by_account_id: '{{SEED_ACCOUNT_ID}}', ...scriptRow },
    ],
  ));
  put(RENDERINGS, csvText(['organization_id', 'rendering_id', 'script_id', 'format', 'audience_note', 'body', 'generated_from_blocks'],
    [{ organization_id: ORG, rendering_id: 'rnd_00000000000001', script_id: SCR, format: 'cheat_sheet', audience_note: 'Coach', body: 'LINE ONE\nLINE TWO', generated_from_blocks: 'false' }]));
  put(TRACKS, csvText(['organization_id', 'track_id', 'lineage_id', 'version', 'name', 'lane', 'status'],
    [{ organization_id: ORG, track_id: FT1_TRACK, lineage_id: FT1_TRACK, version: '1', name: 'FT1', lane: 'standard', status: 'REPORTED' }]));
  return dir;
}

function exportInto(dir: string, from: string = seed(), extra: string[] = []) {
  const out = tempDir();
  fs.cpSync(from, out, { recursive: true });
  const result = spawnSync(process.execPath, [SCRIPT, dir, '--out', out, ...extra], { encoding: 'utf8' });
  return { out, status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const read = (out: string, name: string) => fs.readFileSync(path.join(out, name), 'utf8');
function rowsOf(text: string): Record<string, string>[] {
  const table = readCsv(text);
  expect(table.problems).toEqual([]);
  return table.records.map((record) => Object.fromEntries(table.header.map((name, index) => [name, record.cells[index]])));
}
const json = (cell: string) => JSON.parse(cell) as Json;

describe('backbone-export-youth-recreational', () => {
  const dir = backbone();
  const first = exportInto(dir);

  it('writes each package file with the spec\'s column list in order', () => {
    expect(first.stderr).toBe('');
    // exit 2 = counts differ from the brief's (the fixture is small on purpose); the files are still written.
    expect(first.status).toBe(2);
    expect(first.stdout).toContain('COUNTS DIFFER FROM THE BRIEF');
    for (const name of WRITTEN) {
      const spec = FILE_SPECS.find((file) => file.file === path.basename(name));
      expect(spec).toBeDefined();
      expect(readCsv(read(first.out, name)).header).toEqual(spec!.columns.map((column) => column.name));
    }
  });

  it('takes the youth and RC1 records only: not the FT1-only ones, not the amateur ones', () => {
    // The committed FT1 row keeps its place; the new rows follow, by id.
    expect(rowsOf(read(first.out, TRACKS)).map((row) => row.track_id)).toEqual([FT1_TRACK, LIBRARY, CLASS, DOC154]);
    expect(rowsOf(read(first.out, TEMPLATES)).map((row) => row.template_id)).toEqual([T1, T2]);
    expect(first.stdout).toContain('counts: besideLines 2, tracks 3, blocks 1, blockSessions 2, templates 2, items 4, heldTemplates 6, heldItems 6, scripts 1, scriptBlocks 2, quoteKeys 2, ownerPassages 2');
  });

  it('holds the six DOC-136 templates out, lists them by id, and removes any committed row of theirs', () => {
    for (const name of WRITTEN) for (const id of HELD) expect(read(first.out, name)).not.toContain(id);
    expect(first.stdout).toContain(`HELD, not exported (OD-2026-10-02-013 2A): ${[...HELD].sort().map((id) => `${id} (1 items)`).join(', ')}`);
    expect(read(first.out, TEMPLATES)).not.toContain('Printed outside text');
    // A held template committed earlier is removed, and the guard names it.
    const stale = tempDir();
    fs.cpSync(first.out, stale, { recursive: true });
    const table = readCsv(read(stale, TEMPLATES));
    const extra = [...table.records[0].cells];
    extra[table.header.indexOf('template_id')] = HELD[0];
    extra[table.header.indexOf('lineage_id')] = HELD[0];
    extra[table.header.indexOf('name')] = 'Held day';
    fs.writeFileSync(path.join(stale, TEMPLATES), writeCsv(table.header, [...table.records.map((record) => record.cells), extra]));
    const refused = exportInto(dir, stale);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`${TEMPLATES} template_id ${HELD[0]}: removes ${HELD[0]}`);
    const forced = exportInto(dir, stale, ['--allow-overwrite']);
    expect(read(forced.out, TEMPLATES)).toBe(read(first.out, TEMPLATES));
  });

  it('keeps every Backbone field: columns as written, the rest whole in details, research quotes dropped, owner passages kept', () => {
    const library = rowsOf(read(first.out, TRACKS)).find((row) => row.track_id === LIBRARY)!;
    expect([library.track, library.duration_weeks, library.age_band, library.status, library.stage_keys]).toEqual(['', '', 'any', 'REPORTED', 'Y3|T1']);
    const details = json(library.details);
    expect(details.groups).toEqual([{ order: 1, section: 'LR-1', heading: '1.1 Heading', source: 'LR-1', blocks: [{ type: 'text', text: '  Kept with its spaces  ' }], drill_refs: [] }]);
    expect(details.owner_passages).toEqual([passage()]);
    expect(json(library.field_labels).owner_passages).toEqual({ status: 'REPORTED', sources: ['DOC-027'] });
    expect(library.evidence).not.toContain('quote');
    const cited = Object.fromEntries(Object.entries(research()).filter(([key]) => key !== 'quote'));
    expect(json(library.evidence)).toEqual([{ ...cited, sp10: { limitations: 'The Backbone note stays.', population: 'n = 12 boxers; g = 0.67' } }]);
    for (const name of WRITTEN) expect(read(first.out, name)).not.toContain('A licensed sentence');
    expect(first.stdout).toContain('research excerpt keys dropped: quote 2, quotes 0; sp10 sentences repeating their quote dropped: 2; owner passages carried: 2');
    expect(first.stdout).toContain('record keys not carried (kind.key xcount): script.active x1, script.session_kind x1, script.sources x1, script.stage_links x1, script.status x1, '
      + 'template.session_kind x2, template.sources x2, template.stage_links x2, template.status x2, template.track_id x2, track.stage_links x3');
  });

  it('writes templates and items: blanks blank, the item fields with no column in details, sparring minutes in details, not the column', () => {
    const [t1, t2] = rowsOf(read(first.out, TEMPLATES));
    expect([t1.session_type, t1.difficulty, t1.duration_minutes, t1.intent, t1.coach_notes]).toEqual(['', 'beginner', '', 'Learn the jab.', '']);
    expect(json(t1.details)).toEqual({ contact_structure: 'non_contact', owner_passages: [passage()] });
    expect([t2.difficulty, t2.duration_minutes]).toEqual(['', '45']);
    const items = rowsOf(read(first.out, ITEMS));
    expect(items.map((row) => [row.template_id, row.ordinal, row.drill_id, row.free_text_drill, row.duration_minutes, row.contact_level, row.details])).toEqual([
      [T1, '1', D1, '', '', 'none', ''],
      [T1, '2', '', 'Jump rope', '', 'none', '{"parts":{"Drill":["Jump rope."]},"phase":"Warm-Up","time":"5 min"}'],
      [T1, '3', '', 'Technical sparring', '', 'controlled_sparring', '{"duration_minutes":20}'],
      [T2, '1', '', 'Shadow', '', 'none', ''],
    ]);
    expect(first.stdout).toContain(`template ${T1} item 3: controlled_sparring with 20 min -> details.duration_minutes`);
  });

  it('writes the class track\'s block and block sessions, and the track\'s other fields in details', () => {
    expect(rowsOf(read(first.out, BLOCKS)).map((row) => [row.track_block_id, row.block_lineage_id, row.track_id, row.block_order, row.weeks, row.stage_keys, row.details]))
      .toEqual([[B1, B1, CLASS, '1', '4', '["Y1","Y2"]', '{"description":"Focus","optional_drill_refs":[]}']]);
    expect(rowsOf(read(first.out, SESSIONS)).map((row) => [row.track_id, row.block_order, row.ordinal, row.week, row.day, row.template_lineage_id]))
      .toEqual([[CLASS, '1', '1', '1', 'Monday', T1], [CLASS, '1', '2', '1', 'Tuesday', T2]]);
    const cls = rowsOf(read(first.out, TRACKS)).find((row) => row.track_id === CLASS)!;
    expect([cls.duration_weeks, json(cls.details)]).toEqual(['12', { session_minutes: 60, session_refs: [] }]);
  });

  it('places the USA Boxing line beside both DOC-154 Thursday lines, labelled, with the sheet untouched', () => {
    const row = rowsOf(read(first.out, TRACKS)).find((candidate) => candidate.track_id === DOC154)!;
    const details = json(row.details);
    const groups = details.groups as { blocks: { text: string }[] }[];
    expect(groups[0].blocks[5].text).toBe(SHEET_1);
    expect(groups[1].blocks[10].text).toBe(SHEET_2);
    expect(details.beside_lines).toEqual([
      { group_section: 'DOC-154 sheet 1', block_index: 5, sheet_text: SHEET_1, line_key: 'USAB-R11', line_text: LINE, sources: ['EXT-USAB-RB2026'],
        caveat: 'The card for OW25-23 says the research session read the USA Boxing rule only in search-result excerpts, not the full 2026 rule book.', ruling: 'OD-2026-11-16-004' },
      expect.objectContaining({ group_section: 'DOC-154 sheet 2', block_index: 10, sheet_text: SHEET_2, line_text: LINE }),
    ]);
    expect(json(row.field_labels).beside_lines).toEqual(expect.objectContaining({ status: 'OBSERVED', sources: expect.arrayContaining(['Jason 2026-11-16 (OD-2026-11-16-004)']) }));
    expect(first.stdout).toContain('beside-lines placed (OD-2026-11-16-004): 2');
  });

  it('stops when a sheet line is not where the ruling places the beside-line, or the line is not word for word in the spine', () => {
    const moved = fixture();
    moved.tracks[1] = doc154('THURSDAY – REST (edited)');
    const refused = exportInto(backbone(moved));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('DOC-154 sheet 1 block 5 is "THURSDAY – REST (edited)", not the sheet line');
    const noLine = fixture();
    noLine.spine = { stages: [] };
    expect(exportInto(backbone(noLine)).stderr).toContain('the beside-line text is not word for word in data/spine/spine.json');
  });

  it('adds the script\'s blocks, labels its committed row and keeps its renderings and every other script', () => {
    const scripts = rowsOf(read(first.out, SCRIPTS));
    expect(scripts.map((row) => [row.script_id, row.version, row.created_by_account_id, row.stage_keys, row.field_labels === '' ? 'blank' : 'labelled'])).toEqual([
      ['scr_00000000000077', '1', '', '', 'blank'],
      [SCR, '1', '{{SEED_ACCOUNT_ID}}', 'Y3|Y4|Y5', 'labelled'],
    ]);
    expect(rowsOf(read(first.out, SCRIPT_BLOCKS)).map((row) => [row.block_id, row.block_order, row.start_offset_min, row.end_offset_min, row.contact_level])).toEqual([
      ['blk_00000000000001', '1', '0', '5', 'none'], ['blk_00000000000002', '2', '5', '15', 'controlled_sparring'],
    ]);
    expect(fs.readFileSync(path.join(first.out, RENDERINGS), 'utf8')).toBe(read(seed(), RENDERINGS));
  });

  it('stops when the committed script differs from the frozen one, or its renderings are not committed as frozen', () => {
    expect(exportInto(dir, seed({ theme: 'Something else' })).stderr).toContain(`script ${SCR}: theme is "Jab" in the Backbone and "Something else"`);
    const changed = fixture();
    changed.sessions[changed.sessions.findIndex((record) => record.script_id === SCR)] = script({ renderings: [{ rendering_id: 'rnd_00000000000001', format: 'cheat_sheet', audience_note: 'Coach', body: 'LINE ONE\r\nLINE 2', generated_from_blocks: false }] });
    expect(exportInto(backbone(changed)).stderr).toContain(`script ${SCR} rendering cheat_sheet is not committed as frozen`);
  });

  it('a second run over the first run\'s output is byte-identical, and keeps the FT1 track row first', () => {
    const rerun = exportInto(dir, first.out);
    expect(rerun.status).toBe(2);
    for (const name of WRITTEN) expect(read(rerun.out, name)).toBe(read(first.out, name));
    expect(rowsOf(read(rerun.out, TRACKS))[0].track_id).toBe(FT1_TRACK);
  });

  it('a rerun that would change a committed non-blank cell stops, naming it, and writes nothing; --allow-overwrite writes', () => {
    const edited = tempDir();
    fs.cpSync(first.out, edited, { recursive: true });
    const table = readCsv(read(edited, TEMPLATES));
    const cells = table.records.map((record) => [...record.cells]);
    cells[0][table.header.indexOf('intent')] = 'Edited in the repo.';
    fs.writeFileSync(path.join(edited, TEMPLATES), writeCsv(table.header, cells));
    const refused = exportInto(dir, edited);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`${TEMPLATES} template_id ${T1}: changes intent of ${T1}`);
    expect(read(refused.out, TEMPLATES)).toBe(read(edited, TEMPLATES));
    const forced = exportInto(dir, edited, ['--allow-overwrite']);
    expect(forced.status).toBe(2);
    expect(read(forced.out, TEMPLATES)).toBe(read(first.out, TEMPLATES));
  });

  // LANE GD: TWO STOPS NO FLAG PASSES (lib/backbone-export-guards.mjs; Overwatch Q2 = A and C1 on #2042).

  it('a track that names a held DOC-136 template stops the export, with or without --allow-overwrite, and nothing is written', () => {
    // The frozen tracks name the held days in their session_refs; the track itself is in the set.
    const naming = fixture();
    naming.tracks[0] = { ...naming.tracks[0], session_refs: [{ week: 1, day: 'Monday', template_id: HELD[0] }] };
    const held = backbone(naming);
    for (const extra of [[], ['--allow-overwrite']]) {
      const refused = exportInto(held, first.out, extra);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`  ${TRACKS} track_id ${LIBRARY}: details names a held DOC-136 record`);
      expect(refused.stderr).toContain('Nothing was written, and --allow-overwrite does not change that.');
      // The refusal says where, never which held record.
      for (const id of HELD) expect(refused.stderr.includes(id)).toBe(false);
      for (const name of WRITTEN) expect(read(refused.out, name)).toBe(read(first.out, name));
    }
    // Onto a seed that has none of this lane's rows yet: still nothing is produced.
    const before = seed();
    const fresh = exportInto(held, before);
    expect(fresh.status).toBe(1);
    expect(fs.existsSync(path.join(fresh.out, TEMPLATES))).toBe(false);
    expect(read(fresh.out, TRACKS)).toBe(read(before, TRACKS));
  });

  it('a row that carries the DOC-136 source key stops the export the same way; a key that only starts the same does not', () => {
    const sourced = fixture();
    sourced.tracks[0] = { ...sourced.tracks[0], sources: ['LR-1', 'DOC-136 (a made-up source line)'] };
    const refused = exportInto(backbone(sourced), first.out, ['--allow-overwrite']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`  ${TRACKS} track_id ${LIBRARY}: sources names a held DOC-136 record`);
    for (const name of WRITTEN) expect(read(refused.out, name)).toBe(read(first.out, name));

    const other = fixture();
    other.tracks[0] = { ...other.tracks[0], sources: ['LR-1', 'DOC-1360 (another document)'] };
    const written = exportInto(backbone(other), first.out, ['--allow-overwrite']);
    expect(written.status).toBe(2);
    expect(read(written.out, TRACKS)).toContain('DOC-1360 (another document)');
  });

  it('a committed step that links a drill is never written back as a typed line, with or without --allow-overwrite', () => {
    // What a later lane does to a typed line (OW26-05 B, OW27-09 B): the step gets a drill_id and loses its typed text.
    const editItems = (edit: (row: string[], at: (name: string) => number) => void) => {
      const out = tempDir();
      fs.cpSync(first.out, out, { recursive: true });
      const table = readCsv(read(out, ITEMS));
      const cells = table.records.map((record) => [...record.cells]);
      const at = (name: string) => table.header.indexOf(name);
      for (const row of cells) edit(row, at);
      fs.writeFileSync(path.join(out, ITEMS), writeCsv(table.header, cells));
      return out;
    };
    const converted = editItems((row, at) => {
      if (row[at('template_id')] !== T1 || row[at('ordinal')] !== '2') return;
      // Typed in the Backbone.
      expect([row[at('drill_id')], row[at('free_text_drill')]]).toEqual(['', 'Jump rope']);
      row[at('drill_id')] = D1;
      row[at('free_text_drill')] = '';
    });
    expect(read(converted, ITEMS)).not.toBe(read(first.out, ITEMS));
    for (const extra of [[], ['--allow-overwrite']]) {
      const refused = exportInto(dir, converted, extra);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`  ${ITEMS} template_id ${T1}: step 2 links drill ${D1}; the export would write it back as a typed line`);
      expect(refused.stderr).toContain('Nothing was written, and --allow-overwrite does not change that.');
      for (const name of WRITTEN) expect(read(refused.out, name)).toBe(read(converted, name));
    }

    // The stop is about typed lines only. A step whose drill link merely differs from the Backbone's
    // is the overwrite guard's, and --allow-overwrite still writes the Backbone's row over it.
    const relinked = editItems((row, at) => {
      if (row[at('template_id')] === T1 && row[at('ordinal')] === '1') row[at('drill_id')] = 'drl_00000000000002';
    });
    const refusedPlain = exportInto(dir, relinked);
    expect(refusedPlain.status).toBe(1);
    expect(refusedPlain.stderr).toContain('run again with --allow-overwrite');
    const forced = exportInto(dir, relinked, ['--allow-overwrite']);
    expect(forced.status).toBe(2);
    expect(read(forced.out, ITEMS)).toBe(read(first.out, ITEMS));
  });

  it('stops on an unknown record key, a manifest mismatch, a drill the drill library lacks, or a block session naming a template outside the set', () => {
    const unknown = fixture();
    unknown.sessions[0] = { ...unknown.sessions[0], new_field: 'x' };
    expect(exportInto(backbone(unknown)).stderr).toContain(`template ${T1}: key "new_field" has no column`);
    const tampered = backbone(fixture(), (folder) => fs.appendFileSync(path.join(folder, `data/content/tracks/${LIBRARY}.json`), ' '));
    expect(exportInto(tampered).stderr).toMatch(/differs from FREEZE_MANIFEST.json/);
    const missingDrill = fixture();
    missingDrill.sessions[0] = template(T1, ['Y1'], [item(1, { drill_id: 'drl_000000000000ff' })]);
    expect(exportInto(backbone(missingDrill)).stderr).toContain('drill drl_000000000000ff is not in drill-library/seed_drill_library.csv');
    const outside = fixture();
    (outside.blocks[0].session_refs as Json[]).push({ week: 2, day: 'Monday', template_id: T_FT1 });
    expect(exportInto(backbone(outside)).stderr).toContain(`template ${T_FT1} is not in this set`);
  });
});

describe('the committed youth + recreational rows', () => {
  const rows = (name: string) => rowsOf(fs.readFileSync(path.join(SEED_DIR, name), 'utf8'));
  const inLane = (row: Record<string, string>) => row.stage_keys.split('|').some((key) => ['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'RC1'].includes(key)) && row.stage_keys !== 'FT1';
  const templates = rows(TEMPLATES).filter(inLane);
  const tracks = rows(TRACKS).filter(inLane);

  it('are 27 templates, 240 items, 53 tracks, 3 blocks, 48 block sessions and 13 script blocks, and none of the 6 held DOC-136 templates', () => {
    const templateIds = new Set(templates.map((row) => row.template_id));
    const trackIds = new Set(tracks.map((row) => row.track_id));
    expect([templates.length, rows(ITEMS).filter((row) => templateIds.has(row.template_id)).length]).toEqual([27, 240]);
    const held = ['wtp_0f42c41a78dea4', 'wtp_35c593e3b96cdf', 'wtp_40b6956ea37245', 'wtp_b965c8174bd41a', 'wtp_f20745471ef7c4', 'wtp_fb399b5d31e70d'];
    for (const name of [TEMPLATES, ITEMS]) expect(rows(name).filter((row) => held.includes(row.template_id))).toEqual([]);
    expect([tracks.length, rows(BLOCKS).filter((row) => trackIds.has(row.track_id)).length, rows(SESSIONS).filter((row) => trackIds.has(row.track_id)).length]).toEqual([53, 3, 48]);
    expect(rows(SCRIPT_BLOCKS).filter((row) => row.script_id === 'scr_e2ed38b1a19670')).toHaveLength(13);
  });

  it('hold no research quote, and every owner passage is DOC-027 or DOC-072', () => {
    const cells = [...templates, ...tracks].flatMap((row) => [row.details, row.evidence, row.field_labels]).filter(Boolean).map((cell) => json(cell));
    const keys = new Set<string>();
    const docs = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          if (key === 'owner_passages' && Array.isArray(inner)) for (const one of inner) docs.add((one as Json).doc as string);
          walk(inner);
        }
      }
    };
    cells.forEach(walk);
    expect(keys.has('quote')).toBe(false);
    expect(keys.has('quotes')).toBe(false);
    expect([...docs].sort()).toEqual(['DOC-027', 'DOC-072']);
  });

  it('name only drills, gates, criteria, protocols, scorecard items and stage defaults the committed seed holds', () => {
    const ids = (name: string, column: string) => new Set(rows(name).map((row) => row[column]));
    const tables: [RegExp, Set<string>][] = [
      [/\bdrl_[0-9a-f]{14}\b/g, ids(DRILLS, 'drill_id')],
      [/\bpgt_[0-9a-f]{14}\b/g, ids('assessment-catalog/seed_pathway_gates.csv', 'gate_id')],
      [/\bpgc_[0-9a-f]{14}\b/g, ids('assessment-catalog/seed_pathway_gate_criteria.csv', 'criterion_id')],
      [/\bPP-T\d{2}\b/g, ids('assessment-catalog/seed_assessment_protocols.csv', 'protocol_id')],
      [/\bsci_[0-9a-f]{14}\b/g, ids('assessment-catalog/seed_scorecard_items.csv', 'scorecard_item_id')],
      [/\bdft_[0-9a-f]{14}\b/g, ids('pathway-catalog/seed_pathway_stage_defaults.csv', 'default_id')],
      [/\bwtp_[0-9a-f]{14}\b/g, ids(TEMPLATES, 'template_id')],
    ];
    const laneTemplateIds = new Set(templates.map((row) => row.template_id));
    const text = [...templates, ...tracks, ...rows(ITEMS).filter((row) => laneTemplateIds.has(row.template_id))]
      .map((row) => [row.details, row.drill_id, row.field_labels].join(' ')).join('\n');
    // No allowance for a held DOC-136 template: a track's text may not name one (lane GD; Overwatch C1 on #2042).
    for (const [pattern, known] of tables) {
      const missing = [...new Set(text.match(pattern) ?? [])].filter((id) => !known.has(id));
      expect({ pattern: pattern.source, missing }).toEqual({ pattern: pattern.source, missing: [] });
    }
  });

  it('name no held DOC-136 record: no held template id and no DOC-136 source key in any file this export writes', () => {
    // A row that names one stops the export (lib/backbone-export-guards.mjs), so none may be committed either.
    for (const name of WRITTEN) {
      const text = fs.readFileSync(path.join(SEED_DIR, name), 'utf8');
      expect({ file: name, namesHeldId: HELD.some((id) => text.includes(id)) }).toEqual({ file: name, namesHeldId: false });
      expect({ file: name, carriesKey: /DOC-136(?![0-9])/.test(text) }).toEqual({ file: name, carriesKey: false });
    }
  });

  // OD-2026-11-17-001: the blank session_type, difficulty, duration_minutes and intent are AI-drafted
  // in the committed rows, each labelled INFERRED with the draft marker.
  const DRAFT = 'AI draft, lane YR, 2026-11-17 (OD-2026-11-17-001)';
  const DRAFTED = ['session_type', 'difficulty', 'duration_minutes', 'intent'];

  it('carry 43 drafted cells, each filled and labelled with the draft marker: 41 INFERRED, 2 durations UNVERIFIED (order of basis 2)', () => {
    const drafted = templates.flatMap((row) => {
      const labels = JSON.parse(row.field_labels) as Record<string, { status?: string; draft?: string; basis?: string; sources?: string[] }>;
      return DRAFTED.filter((field) => labels[field]?.draft).map((field) => ({ row, field, label: labels[field] }));
    });
    const byField = (field: string) => drafted.filter((entry) => entry.field === field).length;
    expect([drafted.length, byField('session_type'), byField('difficulty'), byField('duration_minutes'), byField('intent')]).toEqual([43, 17, 17, 7, 2]);
    // A duration from the same document's matching sheet, not the template's own content, is UNVERIFIED.
    const UNVERIFIED = new Map([['wtp_4b192f174699bc', '60'], ['wtp_c5d6897640434c', '120']]);
    for (const { row, field, label } of drafted) {
      const fromSheet = field === 'duration_minutes' && UNVERIFIED.has(row.template_id);
      expect({ id: row.template_id, field, value: row[field] !== '', status: label.status, draft: label.draft, basis: Boolean(label.basis), sources: (label.sources ?? []).length > 0 })
        .toEqual({ id: row.template_id, field, value: true, status: fromSheet ? 'UNVERIFIED' : 'INFERRED', draft: DRAFT, basis: true, sources: true });
      if (fromSheet) expect(row[field]).toBe(UNVERIFIED.get(row.template_id));
    }
    expect(drafted.filter(({ label }) => label.status === 'UNVERIFIED')).toHaveLength(2);
    // Its own record's DOC-027 owner passage, "Base 60 Minute Session Template", is its basis (Overwatch, Q2).
    expect(templates.find((row) => row.template_id === 'wtp_151338565aea69')?.duration_minutes).toBe('60');
    // Difficulty goes by the lowest stage served, not by a template's name.
    for (const id of ['wtp_1696a57348cd45', 'wtp_16acacbeaa1eeb']) expect(templates.find((row) => row.template_id === id)?.difficulty).toBe('intermediate');
    // A written value is never drafted over: the ~10-minute circuit keeps its 10.
    expect(templates.find((row) => row.template_id === 'wtp_b314d9a0582d20')?.duration_minutes).toBe('10');
  });

  const HW_TRACK = 'trk_55480ac4429113';
  const HW_TRACK_COLUMNS = ['sources', 'details', 'field_labels'];
  // Lane W4-8's step PRs: template id -> the typed steps now linked to the lane's drills (one entry per template).
  const LANE_W48_STEPS: Record<string, number[]> = {
    wtp_43c793b8f90e77: [1, 2, 7, 8, 9, 10, 11, 12, 13, 14], // 48-Session Youth Coaching Manual, Weeks 1-4 (TL-1b)
    wtp_ed57bea28de0f7: [1, 2, 7, 8, 9, 10, 11, 12, 13, 14], // Weeks 5-8 (TL-1b)
    wtp_d861f584584788: [1, 2, 7, 8, 9, 10, 11, 12, 13, 14], // Weeks 9-12 (TL-1b)
    wtp_900c0a3fd4422a: [1, 2, 8, 9, 10, 11, 12, 13, 14, 15], // Scripted 60-Minute Class (test run 4-5) (TL-2)
  };
  // Of those, the steps that also took their own clock time (details.block_time) as duration_minutes (Codex P1 and
  // App Overwatch on #2177): the export would blank that cell too.
  const LANE_W48_DURATIONS: Record<string, number[]> = {
    wtp_900c0a3fd4422a: [1, 2, 8, 9, 10, 11, 12, 13, 14, 15], // Scripted 60-Minute Class (TL-2)
  };
  const haveFrozen = fs.existsSync(path.join(FROZEN, 'FREEZE_MANIFEST.json'));
  (haveFrozen ? it : it.skip)('differ from a fresh export of the frozen Backbone only in the drafted cells and their labels (skipped where that folder is absent)', () => {
    // The guard refuses to put the frozen blanks back over the drafts, naming only the drafted templates.
    const refused = exportInto(FROZEN, SEED_DIR);
    expect(refused.status).toBe(1);
    const named = [...refused.stderr.matchAll(/^ {2}(\S+) \w+ (\S+): changes ([\w, ]+) of /gm)].map((match) => [match[1], match[2], match[3]]);
    const draftedIds = templates.filter((row) => DRAFTED.some((field) => (JSON.parse(row.field_labels)[field] ?? {}).draft)).map((row) => row.template_id).sort();
    expect(draftedIds).toHaveLength(17);
    // Lane HW (OD-2026-11-19-005; Overwatch R1): the Personal and Home Training track names the six PPBF
    // home sessions in days 1-6 in place of the held six, so its details, sources and field_labels differ
    // from the frozen Backbone, and the guard refuses to write the frozen row back over them.
    expect(named.filter(([file]) => file !== TEMPLATES && file !== ITEMS)).toEqual([[TRACKS, HW_TRACK, HW_TRACK_COLUMNS.join(', ')]]);
    // Lane W4-8 (OD-2026-11-19-030, OW26-05 B; OD-2026-11-20-001, OW27-09 B; plan and GO on #2162): each typed step in
    // LANE_W48_STEPS now links the drill the lane wrote for its line, and its template's 'items' label gains the
    // lane's 'drill_id' part. The frozen Backbone keeps the typed lines, so the guard names exactly those
    // steps (drill_id is their one committed cell the export would change; the cleared free_text_drill is a blank it
    // would fill) and those templates' field_labels. UNVERIFIED where written (no frozen folder); App Overwatch runs this case on each
    // step PR's head before merging it (#2162).
    const laneSteps = rows(ITEMS).filter((row) => (LANE_W48_STEPS[row.template_id] ?? []).includes(Number(row.ordinal)));
    expect(laneSteps).toHaveLength(Object.values(LANE_W48_STEPS).flat().length);
    const timed = (row: Record<string, string>) => (LANE_W48_DURATIONS[row.template_id] ?? []).includes(Number(row.ordinal));
    expect(named.filter(([file]) => file === ITEMS))
      .toEqual(laneSteps.map((row) => [ITEMS, row.template_id, timed(row) ? 'drill_id, duration_minutes' : 'drill_id']));
    expect(named.filter(([file]) => file === TEMPLATES).map(([, id]) => id).sort())
      .toEqual([...new Set([...draftedIds, ...Object.keys(LANE_W48_STEPS)])].sort());
    // A lane template changes in field_labels and, if lane YR drafted it, in exactly its drafted cells (header order).
    for (const id of Object.keys(LANE_W48_STEPS)) {
      const labels = JSON.parse(templates.find((row) => row.template_id === id)?.field_labels ?? '{}');
      const columns = [...DRAFTED.filter((field) => (labels[field] ?? {}).draft), 'field_labels'].join(', ');
      expect(named.filter(([file, owner]) => file === TEMPLATES && owner === id).map(([, , cells]) => cells)).toEqual([columns]);
    }
    // Every overwrite line is one of those named: no committed row is removed.
    expect(refused.stderr.split('\n').filter((line) => /^ {2}\S+ \w+ \S+: (changes .+|removes .+)$/.test(line) && !line.includes(' links drill '))).toHaveLength(named.length);

    // Lane GD: the frozen track row still names the held six in its details, so no flag writes it back
    // (lib/backbone-export-guards.mjs; Overwatch Q2 = A and C1 on #2042). The plain refusal says so, and
    // the forced run is refused too, writing nothing. These expectations were written where the frozen
    // folder is absent: they are INFERRED from that row as it was committed before lane HW (#1980), when
    // the held ids and the DOC-136 key sat in its details and in no other seed row.
    const heldLine = `  ${TRACKS} track_id ${HW_TRACK}: details names a held DOC-136 record`;
    const heldLines = (stderr: string) => stderr.split('\n').filter((line) => line.includes('names a held DOC-136 record'));
    expect(refused.stderr).toContain('--allow-overwrite would not write this run either.');
    expect(heldLines(refused.stderr)).toEqual([heldLine]);
    const forced = exportInto(FROZEN, SEED_DIR, ['--allow-overwrite']);
    expect(forced.status).toBe(1);
    expect(heldLines(forced.stderr)).toEqual([heldLine]);
    // ...and both runs refuse to write lane W4-8's linked steps back as typed lines, naming exactly those steps.
    const typedLines = (stderr: string) => stderr.split('\n').filter((line) => line.endsWith('the export would write it back as a typed line'));
    const laneTypedLines = laneSteps.map((row) => `  ${ITEMS} template_id ${row.template_id}: step ${row.ordinal} links drill ${row.drill_id}; the export would write it back as a typed line`);
    expect(typedLines(refused.stderr)).toEqual(laneTypedLines);
    expect(typedLines(forced.stderr)).toEqual(laneTypedLines);
    for (const name of WRITTEN) expect(read(forced.out, name)).toBe(fs.readFileSync(path.join(SEED_DIR, name), 'utf8'));
  });
});
