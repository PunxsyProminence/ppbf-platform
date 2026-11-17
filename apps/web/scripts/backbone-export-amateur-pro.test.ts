import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readCsv, writeCsv } from '../src/server/pilot/contentImport/csv';
import { FILE_SPECS } from '../src/server/pilot/contentImport/specs';

// Lane AP: the Backbone -> amateur + pro exporter. Over a small fixture Backbone built here (an
// amateur class track whose blocks carry no block_ids, a pro library track, templates with blank
// fields and their drafts, and records of other lanes it must leave out), driven through the
// module with fixture drafts; then checks on the committed seed: its counts, its drafts and labels,
// that it regenerates byte for byte from the frozen Backbone when that folder is on this machine
// (skipped elsewhere), and that every reference the loaded rows hold resolves.

const SCRIPT = path.resolve(__dirname, 'backbone-export-amateur-pro.mjs');
const SEED_DIR = path.resolve(__dirname, '../seed-data');
const FROZEN = 'C:\\Users\\jason\\OneDrive - PUNXSY PROMINENCE BOXING AND FITNESS\\PPBF-AI-Lanes\\Research\\Backbone';
const ORG = '{{PPBF_ORG_ID}}';

const TEMPLATES = 'workout-templates/seed_workout_templates.csv';
const ITEMS = 'workout-templates/seed_workout_template_items.csv';
const TRACKS = 'training-tracks/seed_training_tracks.csv';
const BLOCKS = 'training-tracks/seed_track_blocks.csv';
const SESSIONS = 'training-tracks/seed_track_block_sessions.csv';
const DRILLS = 'drill-library/seed_drill_library.csv';
const WRITTEN = [TEMPLATES, ITEMS, TRACKS, BLOCKS, SESSIONS];

const CLASS = 'trk_00000000000001';
const LIBRARY = 'trk_00000000000002';
const YOUTH = 'trk_00000000000003';
const FT1_TRACK = 'trk_d104860a7eccef';
const B1 = 'trb_00000000000001';
const B2 = 'trb_00000000000002';
const T1 = 'wtp_00000000000001';
const T2 = 'wtp_00000000000002';
const T_YR = 'wtp_00000000000003';
const T_FT1 = 'wtp_0000000000000f';
const D1 = 'drl_00000000000001';
const MARK = 'AI draft, lane AP, 2026-11-17 (OD-2026-11-17-001)';
const SHEET = 'docs/content-review/amateur-pro/TEMPLATE_DRAFTS_REVIEW.md';

type Json = Record<string, unknown>;
type Row = Record<string, string>;
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-ap-export-test-'));
  temps.push(dir);
  return dir;
}
const sha16 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const labels = (fields: string[]) => Object.fromEntries(fields.map((field) => [field, { status: 'REPORTED', sources: ['LR-050'] }]));
const research = () => ({
  evidence_category: 'research', evidence_label: 'EMERGING', check_state: 'verified', evidence_item_ids: [], registry_claim_ids: [], covers: ['CL-1'],
  citation: 'Someone et al. 2020', source_id: 'EXT-X', quote: 'A licensed sentence that must never reach the repository.',
  sp10: { limitations: 'The Backbone note stays.' },
});
const passage = () => ({ doc: 'DOC-072', doc_title: 'Pro Boxing Skill System Master Registry', sheet: 'Drill_Registry', row_id: 'S01-001', beside: ['groups'], read_for: 'DOC-023', difference: null });

const track = (id: string, stageKeys: string[], extra: Json = {}): Json => ({
  organization_id: ORG, track_id: id, lineage_id: id, name: `Track ${id}`, lane: 'standard', track: null, delivered_to_program_id: null, age_band: 'any',
  active: true, status: 'REPORTED', sources: ['LR-050'], stage_keys: stageKeys, stage_links: [], evidence: [research()], field_labels: labels(['name']), ...extra,
});
const block = (id: string, order: number, refs: Json[], extra: Json = {}): Json => ({
  organization_id: ORG, track_block_id: id, lineage_id: id, track_id: CLASS, block_order: order, title: `Block ${order}`, weeks: null, session_refs: refs,
  active: true, status: 'REPORTED', sources: ['LR-231'], stage_keys: ['T2', 'PR1'], evidence: [], field_labels: labels(['title']), ...extra,
});
const item = (ordinal: number, extra: Json = {}): Json => ({ item_id: `wti_0000000000000${ordinal}`, ordinal, block: 'technical', contact_level: 'none', ...extra });
const template = (id: string, stageKeys: string[], items: Json[], extra: Json = {}): Json => ({
  organization_id: ORG, session_kind: 'template', template_id: id, lineage_id: id, name: `Session ${id}`, session_type: 'technical', difficulty: 'advanced',
  age_band: 'any', duration_minutes: 60, intent: 'Boxing skill', coach_notes: null, requires_coach_authorization: false, contact_structure: 'non_contact', items,
  track_id: CLASS, active: true, status: 'REPORTED', sources: ['LR-231', 'Jason 2026-10-31 (D-PK67-6)'], stage_keys: stageKeys, stage_links: [], evidence: [],
  field_labels: labels(['name']), ...extra,
});

interface Fixture { tracks: Json[]; blocks: Json[]; sessions: Json[] }
function fixture(): Fixture {
  return {
    tracks: [
      // No block_ids: its blocks are taken by their own track_id.
      track(CLASS, ['T2', 'AM1', 'PR1'], { block_use_rule: { text: 'Copy and adapt' } }),
      track(LIBRARY, ['PR1', 'PR2'], {
        part_heading: 'PART 1', groups: [{ order: 1, section: 'DOC-023 lines 1-2', blocks: [{ type: 'text', text: '  Kept with its spaces  ' }], drill_refs: [] }],
        owner_passages: [passage()], session_refs: [], weekly_template: { Monday: 'Skill' },
      }),
      track(YOUTH, ['Y3', 'T1']),
      track(FT1_TRACK, ['FT1']),
    ],
    blocks: [
      block(B1, 1, [{ week: 1, day: 'Monday', template_id: T1 }, { week: 1, day: '1 (bout day)', template_id: T2 }], { plan_items: ['Strength'] }),
      block(B2, 2, []),
    ],
    sessions: [
      template(T1, ['T2', 'PR1'], [
        item(1, { drill_id: D1, slot: 'AM' }),
        item(2, { block: 'sparring', contact_level: 'controlled_sparring', free_text_drill: 'Constrained live', duration_minutes: 30, slot: 'PM' }),
      ], {
        session_type: null, duration_minutes: null, day_role: 'hard skill',
        field_labels: { ...labels(['name']), duration_minutes: { status: 'UNVERIFIED', sources: [] } },
      }),
      template(T2, ['PR1'], [item(1, { item_id: 'wti_00000000000021', free_text_drill: 'Round 1 mitts', phase: 'Round 1' })], { difficulty: null, pass_fail: 'clean exits.', owner_passages: [passage()] }),
      template(T_YR, ['T1', 'RC1'], [item(1, { item_id: 'wti_00000000000031', free_text_drill: 'Youth' })]),
      template(T_FT1, ['FT1'], [item(1, { item_id: 'wti_000000000000f1', free_text_drill: 'FT1 only' })]),
    ],
  };
}
const DRAFTS = {
  [T1]: {
    session_type: { value: 'sparring', status: 'INFERRED', basis: 'its PM slot is constrained live', sheets: [] },
    duration_minutes: { value: 90, status: 'UNVERIFIED', basis: 'the same document\'s sheet', sheets: ['LR-218 (wtp_080c41583b3757, written 90 min)'], caveat: 'a caveat' },
  },
  [T2]: { difficulty: { value: 'advanced', status: 'INFERRED', basis: 'the lowest stage it serves is PR1', sheets: [] } },
};
const BLOCKS_BY_TRACK = { [CLASS]: 2 };

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
  for (const record of data.sessions) write(`data/content/sessions/${record.template_id as string}.json`, wrap(record));
  fs.writeFileSync(path.join(dir, 'FREEZE_MANIFEST.json'), JSON.stringify({ files }));
  after?.(dir);
  return dir;
}

const csvText = (header: string[], rows: Row[]) => writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? '')));
/** A committed seed folder: the drill a template names, an FT1 track row and a youth template row (other lanes'). */
function seed(): string {
  const dir = tempDir();
  const put = (name: string, text: string) => {
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  };
  put(DRILLS, csvText(['organization_id', 'drill_id', 'name'], [{ organization_id: ORG, drill_id: D1, name: 'Jab' }]));
  put(TRACKS, csvText(['organization_id', 'track_id', 'lineage_id', 'version', 'name', 'lane', 'status'],
    [{ organization_id: ORG, track_id: FT1_TRACK, lineage_id: FT1_TRACK, version: '1', name: 'FT1', lane: 'standard', status: 'REPORTED' }]));
  put(TEMPLATES, csvText(['organization_id', 'template_id', 'lineage_id', 'version', 'name', 'session_type', 'difficulty', 'duration_minutes', 'intent'],
    [{ organization_id: ORG, template_id: T_YR, lineage_id: T_YR, version: '1', name: 'Youth', session_type: 'technical', difficulty: 'beginner', duration_minutes: '45', intent: 'Youth' }]));
  return dir;
}

interface Run { out: string; status: number | null; stdout: string; stderr: string }
/** Runs the module's export over `dir` into a copy of `from`, with the fixture's tables; exit 1 on an export error, 2 on count differences. */
function exportInto(dir: string, from: string = seed(), options: Json = {}): Run {
  const out = tempDir();
  fs.cpSync(from, out, { recursive: true });
  const code = `
    import fs from 'node:fs';
    import path from 'node:path';
    const { exportAmateurPro } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});
    const [dir, out, options] = JSON.parse(process.argv[1]);
    const existing = (name) => (fs.existsSync(path.join(out, name)) ? fs.readFileSync(path.join(out, name), 'utf8') : undefined);
    try {
      const result = exportAmateurPro(dir, existing, options);
      for (const [name, text] of Object.entries(result.files)) fs.writeFileSync(path.join(out, name), text, 'utf8');
      console.log(JSON.stringify({ counts: result.counts }));
      for (const notice of result.notices) console.log(notice);
      process.exit(result.differences.length ? 2 : 0);
    } catch (error) {
      if (error.constructor.name !== 'ExportError') throw error;
      console.error(error.message);
      process.exit(1);
    }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify([dir, out, { drafts: DRAFTS, blocksByTrack: BLOCKS_BY_TRACK, ...options }])], { encoding: 'utf8' });
  return { out, status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const read = (out: string, name: string) => fs.readFileSync(path.join(out, name), 'utf8');
function rowsOf(text: string): Row[] {
  const table = readCsv(text);
  expect(table.problems).toEqual([]);
  return table.records.map((record) => Object.fromEntries(table.header.map((name, index) => [name, record.cells[index]])));
}
const json = (cell: string) => JSON.parse(cell) as Json;

describe('backbone-export-amateur-pro', () => {
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

  it('takes the amateur and pro records only (not FT1-only, not any with a youth or RC1 stage), and keeps other lanes\' rows first', () => {
    expect(rowsOf(read(first.out, TRACKS)).map((row) => row.track_id)).toEqual([FT1_TRACK, CLASS, LIBRARY]);
    expect(rowsOf(read(first.out, TEMPLATES)).map((row) => row.template_id)).toEqual([T_YR, T1, T2]);
    // The youth row is the committed one, untouched.
    expect(rowsOf(read(first.out, TEMPLATES))[0]).toEqual(expect.objectContaining({ template_id: T_YR, name: 'Youth', duration_minutes: '45' }));
    expect(JSON.parse(first.stdout.split('\n')[0]).counts).toEqual(expect.objectContaining({
      tracks: 2, amateurTracks: 1, proTracks: 1, blocks: 2, blockSessions: 2, templates: 2, amateurTemplates: 1, proTemplates: 1, items: 3, heldTemplates: 0,
      quoteKeys: 2, ownerPassageLists: 2, ownerPassages: 2, sparringMinutes: 1, drafts: 3,
    }));
  });

  it('fills a blank field from its draft, labelled with the marker, its basis and sources, and keeps the frozen label it replaces', () => {
    const [, t1, t2] = rowsOf(read(first.out, TEMPLATES));
    expect([t1.session_type, t1.difficulty, t1.duration_minutes, t1.intent]).toEqual(['sparring', 'advanced', '90', 'Boxing skill']);
    const labelsOf = json(t1.field_labels);
    expect(labelsOf.session_type).toEqual({
      status: 'INFERRED', draft: MARK, basis: 'its PM slot is constrained live', sources: ['LR-231', 'Jason 2026-10-31 (D-PK67-6)', SHEET],
    });
    expect(labelsOf.duration_minutes).toEqual({
      status: 'UNVERIFIED', draft: MARK, basis: 'the same document\'s sheet', caveat: 'a caveat',
      sources: ['LR-231', 'Jason 2026-10-31 (D-PK67-6)', 'LR-218 (wtp_080c41583b3757, written 90 min)', SHEET],
      backbone_label: { status: 'UNVERIFIED', sources: [] },
    });
    expect(labelsOf.name).toEqual({ status: 'REPORTED', sources: ['LR-050'] });
    expect([t2.difficulty, json(t2.field_labels).difficulty]).toEqual(['advanced', expect.objectContaining({ status: 'INFERRED', draft: MARK })]);
    expect(first.stdout).toContain('drafted (OD-2026-11-17-001): difficulty INFERRED x1, duration_minutes UNVERIFIED x1, session_type INFERRED x1');
  });

  it('stops on a blank field with no draft, a draft over a written value, or a draft the checks would refuse', () => {
    const noDraft = exportInto(dir, seed(), { drafts: { [T2]: DRAFTS[T2] } });
    expect(noDraft.status).toBe(1);
    expect(noDraft.stderr).toContain(`template ${T1}: session_type is blank and has no draft`);
    const written = exportInto(dir, seed(), { drafts: { ...DRAFTS, [T2]: { ...DRAFTS[T2], intent: { value: 'x', status: 'INFERRED', basis: 'b', sheets: [] } } } });
    expect(written.stderr).toContain(`template ${T2}: intent is written in the Backbone ("Boxing skill"); a written value is never drafted over`);
    const tooLong = exportInto(dir, seed(), { drafts: { ...DRAFTS, [T1]: { ...DRAFTS[T1], duration_minutes: { ...DRAFTS[T1].duration_minutes, value: 181 } } } });
    expect(tooLong.stderr).toContain('drafted duration_minutes 181 is not a whole number from 1 to 180');
    const badLevel = exportInto(dir, seed(), { drafts: { ...DRAFTS, [T2]: { difficulty: { value: 'expert', status: 'INFERRED', basis: 'b', sheets: [] } } } });
    expect(badLevel.stderr).toContain('drafted difficulty expert is not one of beginner, intermediate, advanced, elite');
    const unlabelled = exportInto(dir, seed(), { drafts: { ...DRAFTS, [T2]: { difficulty: { value: 'advanced', status: 'OBSERVED', basis: 'b', sheets: [] } } } });
    expect(unlabelled.stderr).toContain('the difficulty draft needs value, status (INFERRED or UNVERIFIED), basis and sheets');
    const stray = exportInto(dir, seed(), { drafts: { ...DRAFTS, wtp_000000000000aa: { intent: DRAFTS[T2].difficulty } } });
    expect(stray.stderr).toContain('DRAFTS names template(s) outside this set: wtp_000000000000aa');
  });

  it('keeps every Backbone field: columns as written, the rest whole in details, research quotes dropped, owner passages kept', () => {
    const library = rowsOf(read(first.out, TRACKS)).find((row) => row.track_id === LIBRARY)!;
    expect([library.duration_weeks, library.stage_keys]).toEqual(['', 'PR1|PR2']);
    const details = json(library.details);
    expect(details.groups).toEqual([{ order: 1, section: 'DOC-023 lines 1-2', blocks: [{ type: 'text', text: '  Kept with its spaces  ' }], drill_refs: [] }]);
    expect([details.owner_passages, details.weekly_template, details.part_heading]).toEqual([[passage()], { Monday: 'Skill' }, 'PART 1']);
    for (const name of WRITTEN) expect(read(first.out, name)).not.toContain('A licensed sentence');
    const t2 = rowsOf(read(first.out, TEMPLATES)).find((row) => row.template_id === T2)!;
    expect(json(t2.details)).toEqual({ contact_structure: 'non_contact', owner_passages: [passage()], pass_fail: 'clean exits.' });
    expect(first.stdout).toContain('research excerpt keys dropped: quote 2, quotes 0; sp10 sentences repeating their quote dropped: 0; owner passages carried: 2 in 2 lists');
  });

  it('puts sparring minutes in the item\'s details with the column blank, and an item\'s other keys in details', () => {
    expect(rowsOf(read(first.out, ITEMS)).map((row) => [row.template_id, row.ordinal, row.drill_id, row.free_text_drill, row.duration_minutes, row.contact_level, row.details])).toEqual([
      [T1, '1', D1, '', '', 'none', '{"slot":"AM"}'],
      [T1, '2', '', 'Constrained live', '', 'controlled_sparring', '{"duration_minutes":30,"slot":"PM"}'],
      [T2, '1', '', 'Round 1 mitts', '', 'none', '{"phase":"Round 1"}'],
    ]);
    expect(first.stdout).toContain(`template ${T1} item 2: controlled_sparring with 30 min -> details.duration_minutes`);
  });

  it('takes a track\'s blocks by their own track_id when it carries no block_ids, with the day as written', () => {
    expect(rowsOf(read(first.out, BLOCKS)).map((row) => [row.track_block_id, row.track_id, row.block_order, row.weeks, row.details])).toEqual([
      [B1, CLASS, '1', '', '{"plan_items":["Strength"]}'], [B2, CLASS, '2', '', ''],
    ]);
    expect(rowsOf(read(first.out, SESSIONS)).map((row) => [row.track_id, row.block_order, row.ordinal, row.week, row.day, row.template_lineage_id]))
      .toEqual([[CLASS, '1', '1', '1', 'Monday', T1], [CLASS, '1', '2', '1', '1 (bout day)', T2]]);
  });

  it('stops when a track\'s blocks differ from BLOCKS_BY_TRACK or from its block_ids', () => {
    expect(exportInto(dir, seed(), { blocksByTrack: { [CLASS]: 3 } }).stderr).toContain(`track ${CLASS}: 2 blocks, expected 3 (BLOCKS_BY_TRACK)`);
    const listed = fixture();
    listed.tracks[0] = { ...listed.tracks[0], block_ids: [B2, B1] };
    expect(exportInto(backbone(listed)).stderr).toContain(`track ${CLASS}: block_ids ["${B2}","${B1}"] differ from the blocks in block_order`);
  });

  it('a second run over the first run\'s output is byte-identical', () => {
    const rerun = exportInto(dir, first.out);
    expect(rerun.status).toBe(2);
    for (const name of WRITTEN) expect(read(rerun.out, name)).toBe(read(first.out, name));
  });

  it('a rerun that would change a committed non-blank cell stops, naming it, and writes nothing; --allow-overwrite writes', () => {
    const edited = tempDir();
    fs.cpSync(first.out, edited, { recursive: true });
    const table = readCsv(read(edited, TEMPLATES));
    const cells = table.records.map((record) => [...record.cells]);
    cells[1][table.header.indexOf('intent')] = 'Edited in the repo.';
    fs.writeFileSync(path.join(edited, TEMPLATES), writeCsv(table.header, cells));
    const refused = exportInto(dir, edited);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`${TEMPLATES} template_id ${T1}: changes intent of ${T1}`);
    expect(read(refused.out, TEMPLATES)).toBe(read(edited, TEMPLATES));
    const forced = exportInto(dir, edited, { allowOverwrite: true });
    expect(read(forced.out, TEMPLATES)).toBe(read(first.out, TEMPLATES));
  });

  it('stops on an unknown record key, a manifest mismatch, a drill the drill library lacks, or a block session naming a template outside the set', () => {
    const unknown = fixture();
    unknown.sessions[0] = { ...unknown.sessions[0], new_field: 'x' };
    expect(exportInto(backbone(unknown)).stderr).toContain(`template ${T1}: key "new_field" has no column`);
    const tampered = backbone(fixture(), (folder) => fs.appendFileSync(path.join(folder, `data/content/tracks/${LIBRARY}.json`), ' '));
    expect(exportInto(tampered).stderr).toMatch(/differs from FREEZE_MANIFEST.json/);
    const missingDrill = fixture();
    missingDrill.sessions[1] = template(T2, ['PR1'], [item(1, { item_id: 'wti_00000000000021', drill_id: 'drl_000000000000ff' })], { difficulty: null });
    expect(exportInto(backbone(missingDrill)).stderr).toContain('drill drl_000000000000ff is not in drill-library/seed_drill_library.csv');
    const outside = fixture();
    (outside.blocks[1].session_refs as Json[]).push({ week: 2, day: 'Monday', template_id: T_YR });
    expect(exportInto(backbone(outside)).stderr).toContain(`template ${T_YR} is not in this set`);
  });
});

describe('the committed amateur + pro rows', () => {
  const rows = (name: string) => rowsOf(fs.readFileSync(path.join(SEED_DIR, name), 'utf8'));
  const stages = (row: Row) => (row.stage_keys.startsWith('[') ? (JSON.parse(row.stage_keys) as string[]) : row.stage_keys.split('|'));
  // The exporter's own filter: not exactly ["FT1"], no youth or RC1 stage, an amateur or pro stage.
  const inLane = (row: Row) => !(stages(row).length === 1 && stages(row)[0] === 'FT1') && !stages(row).some((key) => ['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'RC1'].includes(key))
    && stages(row).some((key) => ['T1', 'T2', 'AM1', 'AM2', 'AM3', 'PR1', 'PR2', 'PR3', 'PR4', 'PR5'].includes(key));
  const templates = rows(TEMPLATES).filter(inLane);
  const tracks = rows(TRACKS).filter(inLane);
  const templateIds = new Set(templates.map((row) => row.template_id));
  const trackIds = new Set(tracks.map((row) => row.track_id));
  const items = rows(ITEMS).filter((row) => templateIds.has(row.template_id));

  it('are 66 templates, 162 items, 14 tracks, 16 blocks and 498 block sessions, with blocks 8, 3, 3 and 2 per track', () => {
    expect([templates.length, items.length, tracks.length]).toEqual([66, 162, 14]);
    const blocks = rows(BLOCKS).filter((row) => trackIds.has(row.track_id));
    expect([blocks.length, rows(SESSIONS).filter((row) => trackIds.has(row.track_id)).length]).toEqual([16, 498]);
    const perTrack: Record<string, number> = {};
    for (const row of blocks) perTrack[row.track_id] = (perTrack[row.track_id] ?? 0) + 1;
    expect(perTrack).toEqual({ trk_2e224d9fc9f63c: 3, trk_89c3ba325a7e0d: 2, trk_a5e16184502c0f: 8, trk_eaa2ecb5091bff: 3 });
  });

  // OD-2026-11-17-001: every blank session_type, difficulty, duration_minutes and intent is drafted.
  const DRAFTED = ['session_type', 'difficulty', 'duration_minutes', 'intent'];
  type Label = { status?: string; draft?: string; basis?: string; sources?: string[]; caveat?: string };
  const drafted = templates.flatMap((row) => {
    const labelsOf = JSON.parse(row.field_labels) as Record<string, Label>;
    return DRAFTED.filter((field) => labelsOf[field]?.draft).map((field) => ({ row, field, label: labelsOf[field] }));
  });

  it('fill all four fields on every template, 68 of them drafted: 44 INFERRED, 24 UNVERIFIED, each with the marker, basis and the review sheet', () => {
    for (const row of templates) for (const field of DRAFTED) expect({ id: row.template_id, field, blank: row[field] === '' }).toEqual({ id: row.template_id, field, blank: false });
    const byField = (field: string) => drafted.filter((entry) => entry.field === field).length;
    expect([drafted.length, byField('session_type'), byField('difficulty'), byField('duration_minutes'), byField('intent')]).toEqual([68, 10, 5, 46, 7]);
    for (const { row, field, label } of drafted) {
      expect({ id: row.template_id, field, draft: label.draft, basis: Boolean(label.basis), sheet: label.sources?.at(-1) })
        .toEqual({ id: row.template_id, field, draft: MARK, basis: true, sheet: SHEET });
    }
    expect([drafted.filter(({ label }) => label.status === 'INFERRED').length, drafted.filter(({ label }) => label.status === 'UNVERIFIED').length]).toEqual([44, 24]);
    // Every UNVERIFIED draft names a sheet beyond the template's own sources.
    for (const { row, label } of drafted.filter((entry) => entry.label.status === 'UNVERIFIED')) {
      expect({ id: row.template_id, sheets: (label.sources ?? []).some((source) => /\((wtp|trk)_[0-9a-f]{14}/.test(source)) }).toEqual({ id: row.template_id, sheets: true });
    }
  });

  it('give the five mitt templates 12 minutes and advanced, both UNVERIFIED, with the caveat word for word, the DOC-072 row and the DOC-022 contrary (Overwatch Q-B; difficulty ruling A)', () => {
    const mitts = ['wtp_3ba3110f2428d2', 'wtp_a97e05c665c596', 'wtp_c49ef523671d1d', 'wtp_d2f730ec22b7fb', 'wtp_e2302f73a5d19a'];
    for (const id of mitts) {
      const row = templates.find((candidate) => candidate.template_id === id)!;
      const label = (JSON.parse(row.field_labels) as Record<string, Label>).duration_minutes;
      expect([row.duration_minutes, row.difficulty, label.status, label.caveat]).toEqual(['12', 'advanced', 'UNVERIFIED',
        'pad round length from DOC-072 Workout_Map (W-S10-007); rest between rounds not counted; DOC-022 and DOC-023 state no mitt round length']);
      expect(label.sources?.some((source) => source.startsWith('DOC-072 W-S10-007 via trk_5ca8d83f2a1a66'))).toBe(true);
      expect(label.sources?.some((source) => source.startsWith('DOC-022 (trk_24e2dcbf4b0edc'))).toBe(true);
      // Difficulty: no PR-stage template writes one, so the nearest written stage below (AM1, AM2: all advanced).
      const difficulty = (JSON.parse(row.field_labels) as Record<string, Label>).difficulty;
      expect(difficulty.status).toBe('UNVERIFIED');
      expect(difficulty.sources?.filter((source) => /\((wtp_0b2bb48d17e3be|wtp_060d401d23d474), .*written difficulty advanced\)$/.test(source))).toHaveLength(2);
    }
    expect(drafted.filter(({ label }) => label.caveat !== undefined).map(({ row }) => row.template_id).sort()).toEqual(mitts);
  });

  it('draft each intent as its own items\' text joined by " | ", and session_type rest only on rest days', () => {
    for (const { row } of drafted.filter((entry) => entry.field === 'intent')) {
      const own = items.filter((candidate) => candidate.template_id === row.template_id).sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
      expect(row.intent).toBe(own.map((candidate) => candidate.free_text_drill).join(' | '));
    }
    const types = drafted.filter((entry) => entry.field === 'session_type').map(({ row }) => row.session_type);
    expect(types.sort()).toEqual([...Array(9).fill('rest'), 'warmup']);
  });

  it('keep the three sparring minutes in item details, the column blank (OD-2026-11-17-002)', () => {
    const sparring = items.filter((row) => !['none', 'light_technical'].includes(row.contact_level) && row.details.includes('"duration_minutes"'));
    expect(sparring.map((row) => [row.template_id, row.ordinal, row.duration_minutes, json(row.details).duration_minutes])).toEqual([
      ['wtp_25a003f73a472c', '2', '', 55], ['wtp_a2d9f97418ec52', '4', '', 30], ['wtp_bc964fe230d8f3', '6', '', 30],
    ]);
    expect(items.filter((row) => !['none', 'light_technical'].includes(row.contact_level) && row.duration_minutes !== '')).toEqual([]);
  });

  it('hold no research quote, and every owner passage is DOC-027 or DOC-072', () => {
    const blocks = rows(BLOCKS).filter((row) => trackIds.has(row.track_id));
    const cells = [...templates, ...tracks, ...blocks, ...items].flatMap((row) => [row.details, row.evidence, row.field_labels]).filter(Boolean).map((cell) => json(cell));
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
    expect([keys.has('quote'), keys.has('quotes')]).toEqual([false, false]);
    expect([...docs].sort()).toEqual(['DOC-027', 'DOC-072']);
  });

  it('name only drills, templates and tracks the committed seed holds', () => {
    const ids = (name: string, column: string) => new Set(rows(name).map((row) => row[column]));
    const tables: [RegExp, Set<string>][] = [
      [/\bdrl_[0-9a-f]{14}\b/g, ids(DRILLS, 'drill_id')],
      [/\bwtp_[0-9a-f]{14}\b/g, ids(TEMPLATES, 'template_id')],
      [/\btrk_[0-9a-f]{14}\b/g, ids(TRACKS, 'track_id')],
    ];
    const text = [...templates, ...tracks, ...items].map((row) => [row.details, row.drill_id, row.field_labels].join(' ')).join('\n');
    for (const [pattern, known] of tables) {
      const missing = [...new Set(text.match(pattern) ?? [])].filter((id) => !known.has(id));
      expect({ pattern: pattern.source, missing }).toEqual({ pattern: pattern.source, missing: [] });
    }
  });

  const haveFrozen = fs.existsSync(path.join(FROZEN, 'FREEZE_MANIFEST.json'));
  (haveFrozen ? it : it.skip)('regenerate byte for byte from the frozen Backbone, drafts included (skipped where that folder is absent)', () => {
    const out = tempDir();
    fs.cpSync(SEED_DIR, out, { recursive: true });
    const result = spawnSync(process.execPath, [SCRIPT, FROZEN, '--out', out], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('counts: drafts 68, sparringMinutes 3, tracks 14, amateurTracks 7, proTracks 7, blocks 16, blockSessions 498, templates 66, amateurTemplates 61, '
      + 'proTemplates 5, items 162, heldTemplates 0, quoteKeys 193, ownerPassageLists 22, ownerPassages 202, sp10Sentences 0');
    for (const name of WRITTEN) expect(read(out, name)).toBe(fs.readFileSync(path.join(SEED_DIR, name), 'utf8'));
  });
});
