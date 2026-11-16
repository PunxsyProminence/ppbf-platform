import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCsv, writeCsv } from '../src/server/pilot/contentImport/csv';
import { FILE_SPECS } from '../src/server/pilot/contentImport/specs';

// Lane L2b: the Backbone -> drill-library (lane 2) exporter, over a small fixture Backbone built here:
// one FT1 drill (stage_keys exactly ["FT1"], never exported here), one Long Road drill, one DOC-152
// drill and one DOC-023 drill, with its own manifest.

const SCRIPT = path.resolve(__dirname, 'backbone-export-drill-library.mjs');
const ORG = '{{PPBF_ORG_ID}}';
const FT1 = 'drl_000000000000f1';
const LR = 'drl_000000000000a1';
const YS = 'drl_000000000000a2';
const D23 = 'drl_000000000000a3';
const DOC023_PROVENANCE = 'PPBF owner-authored (DOC-023 first; DOC-022 for the fields DOC-023 lacks, labelled per field)';
const DRILLS = 'drill-library/seed_drill_library.csv';
const CUES = 'drill-library/seed_drill_cues.csv';
const STOPS = 'drill-library/seed_drill_stop_rules.csv';

type Json = Record<string, unknown>;
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-lane2-export-test-'));
  temps.push(dir);
  return dir;
}
const sha16 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const labels = (fields: string[]) => Object.fromEntries(fields.map((field) => [field, { status: 'OBSERVED', sources: ['LR-213'] }]));

function drill(id: string, extra: Json = {}): Json {
  return {
    organization_id: ORG, drill_id: id, lineage_id: id, name: `Drill ${id}`, discipline: 'boxing', category: 'sparring', target_behavior: 'Reading and countering', purpose: null,
    standard_setup: 'Boxer may never lead', execution: null, what_good_looks_like: null, what_bad_looks_like: null, common_errors: ['Leading early', 'Admiring the counter'],
    corrections: null, transfer: null, contact_level: 'controlled_sparring', equipment_needed: null, requires_coach_authorization: false,
    content_class: 'Long Road practice text (DOC-001, The Long Road, Second Edition)', source_ref: 'LR-213: The Long Road, Part 9, 5. Defensive Drills', grounding_claim_ids: [],
    cues: [], coaching_notes: [], stop_rules: [], scale_levels: [], library_group: '5. Defensive Drills', prescription: '5 x 2 min, R6', coupling_rung: 'R6',
    active: true, status: 'REPORTED', sources: ['LR-213'], stage_keys: ['T1', 'T2'], stage_links: [{ target_kind: 'drill', target_lineage_id: id, stage_key: 'T1', role: 'core', lane: null }],
    evidence: [{ evidence_label: 'UNTIERED', covers: ['CL-1'], source: 'LR-213', quote: 'a licensed passage' }], field_provenance: 'Long Road practice',
    field_labels: { ...labels(['name', 'target_behavior']), owner_passages: { status: 'REPORTED', sources: ['DOC-027'] } },
    owner_passages: [{ doc: 'DOC-027', lines: ['An owner line that stays out of the repo.'] }],
    ...extra,
  };
}
function fixture(): Json[] {
  return [
    drill(FT1, { stage_keys: ['FT1'], field_provenance: 'PPBF owner-authored', content_class: 'PPBF class material' }),
    drill(LR),
    drill(YS, {
      name: 'Jab-Only Round', field_provenance: 'PPBF owner-authored', content_class: 'PPBF youth class material - DOC-152 Youth Sparring Drill Manual',
      execution: 'Both athletes may throw jabs only.\nNo rear-hand punches allowed.', common_errors: null, stage_keys: ['Y3'],
      cues: [{ cue_id: 'cue_00000000000001', cue_text: 'Step with jab.', focus_type: 'unspecified', source_ref: 'DOC-152' }],
    }),
    drill(D23, {
      name: 'Set-It-Then-Send-It', field_provenance: DOC023_PROVENANCE, content_class: 'PPBF owner-authored text (DOC-023)', contact_level: 'light_technical', difficulty: 'beginner',
      field_labels: { field_provenance: { status: 'OBSERVED', sources: ['Jason 2026-10-30 (D-PK56)'] } },
      stop_rules: [{ stop_rule_id: 'stp_00000000000001', ordinal: 1, condition_text: 'squared stance cannot be corrected.', scope: 'drill_specific' }],
    }),
  ];
}

/** Write a Backbone folder with a manifest; `after` may tamper with files once the manifest is written. */
function backbone(drills: Json[] = fixture(), after?: (dir: string) => void): string {
  const dir = tempDir();
  const files: { path: string; sha256_16: string }[] = [];
  for (const record of drills) {
    const rel = `data/content/drills/${record.drill_id as string}.json`;
    const text = JSON.stringify({ status_line: 'Status: DRAFT', record_kind: 'drill', gaps: ['purpose'], review_notes: [], conversion: {}, record }, null, 2);
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
    files.push({ path: rel, sha256_16: sha16(text) });
  }
  fs.writeFileSync(path.join(dir, 'FREEZE_MANIFEST.json'), JSON.stringify({ files }));
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
const read = (out: string, name: string) => fs.readFileSync(path.join(out, name), 'utf8');
const snapshot = (out: string) => Object.fromEntries([DRILLS, CUES, STOPS].map((name) => [name, fs.existsSync(path.join(out, name)) ? read(out, name) : undefined]));
function rowsOf(text: string): Record<string, string>[] {
  const table = readCsv(text);
  expect(table.problems).toEqual([]);
  return table.records.map((record) => Object.fromEntries(table.header.map((name, index) => [name, record.cells[index]])));
}

/** A committed folder holding one drill outside lane 2 (with a cue and a stop rule) in the spec's columns. */
function committedSeed(): string {
  const seed = tempDir();
  fs.mkdirSync(path.join(seed, 'drill-library'), { recursive: true });
  const header = (file: string) => FILE_SPECS.find((spec) => spec.file === path.basename(file))!.columns.map((column) => column.name);
  const row = (file: string, values: Record<string, string>) => header(file).map((column) => values[column] ?? '');
  fs.writeFileSync(path.join(seed, DRILLS), writeCsv(header(DRILLS), [row(DRILLS, {
    organization_id: ORG, drill_id: 'drl_0000000000aaaa', lineage_id: 'drl_0000000000aaaa', version: '1', name: 'Committed drill, "quoted", with a comma', discipline: 'boxing',
    category: 'footwork', target_behavior: 't', purpose: 'p', contact_level: 'none', requires_coach_authorization: 'false', content_class: 'c', active: 'true', difficulty: 'beginner',
    field_provenance: 'PPBF owner-authored',
  })]));
  fs.writeFileSync(path.join(seed, CUES), writeCsv(header(CUES), [row(CUES, { organization_id: ORG, cue_id: 'cue_0000000000aaaa', drill_id: 'drl_0000000000aaaa', cue_text: 'Get set first.' })]));
  fs.writeFileSync(path.join(seed, STOPS), writeCsv(header(STOPS), [row(STOPS, {
    organization_id: ORG, stop_rule_id: 'stp_0000000000aaaa', drill_id: 'drl_0000000000aaaa', ordinal: '1', condition_text: 'Stop when x.', scope: 'drill_specific', rule_kind: 'fatigue',
  })]));
  return seed;
}

describe('backbone-export-drill-library (lane 2)', () => {
  const dir = backbone();
  const first = exportInto(dir);

  it('writes the three drill-library files, each header the spec\'s column list in order, and no scale-level file', () => {
    expect(first.stderr).toBe('');
    expect(first.status).toBe(2); // the fixture is small on purpose: counts differ from the brief's
    for (const name of [DRILLS, CUES, STOPS]) {
      const spec = FILE_SPECS.find((file) => file.file === path.basename(name));
      expect(readCsv(read(first.out, name)).header).toEqual(spec!.columns.map((column) => column.name));
    }
    expect(fs.existsSync(path.join(first.out, 'drill-library/seed_drill_scale_levels.csv'))).toBe(false);
  });

  it('reports each count that differs from the brief, by name', () => {
    expect(first.stdout).toContain('COUNTS DIFFER FROM THE BRIEF');
    expect(first.stdout).toContain('drills: brief 256, observed 3');
    expect(first.stdout).toContain('drill files read: 4 (lane 2: 3)');
  });

  it('exports every drill whose stage_keys is not exactly ["FT1"], and never the FT1 drill', () => {
    const rows = rowsOf(read(first.out, DRILLS));
    expect(rows.map((row) => row.drill_id)).toEqual([LR, YS, D23]);
    expect(read(first.out, DRILLS)).not.toContain(FT1);
    expect(rows[0]).toMatchObject({ organization_id: ORG, version: '1', purpose: '', execution: '', field_provenance: 'Long Road practice', stage_keys: 'T1|T2', active: 'true' });
  });

  it('writes a list-valued text field one element per line, each as written', () => {
    const rows = rowsOf(read(first.out, DRILLS));
    expect(rows[0].common_errors).toBe('Leading early\nAdmiring the counter');
    expect(rows[1].execution).toBe('Both athletes may throw jabs only.\nNo rear-hand punches allowed.');
  });

  it('loads the long DOC-023 provenance as PPBF owner-authored and keeps the long value in field_labels (PK-201 A)', () => {
    const row = rowsOf(read(first.out, DRILLS)).find((candidate) => candidate.drill_id === D23)!;
    expect(row.field_provenance).toBe('PPBF owner-authored');
    expect(JSON.parse(row.field_labels).field_provenance).toEqual({ status: 'OBSERVED', sources: ['Jason 2026-10-30 (D-PK56)'], backbone_value: DOC023_PROVENANCE });
    expect(row.difficulty).toBe('beginner');
  });

  it('writes cues and stop rules as the record has them, a missing rule_kind as a blank cell (never invented)', () => {
    expect(rowsOf(read(first.out, CUES)).map((row) => [row.drill_id, row.cue_text])).toEqual([[YS, 'Step with jab.']]);
    expect(rowsOf(read(first.out, STOPS))).toEqual([{ organization_id: ORG, stop_rule_id: 'stp_00000000000001', drill_id: D23, ordinal: '1', condition_text: 'squared stance cannot be corrected.', scope: 'drill_specific', rule_kind: '' }]);
  });

  it('keeps owner passages and quotes out, keeps citations, and prints every key it does not carry', () => {
    const text = read(first.out, DRILLS);
    expect(text).not.toMatch(/licensed passage|An owner line|"owner_passages"|"quote"/);
    expect(text).toContain('LR-213');
    expect(first.stdout).toContain('drill.owner_passages x3');
    expect(first.stdout).toContain('drill.library_group x3');
    expect(first.stdout).toContain('drill.prescription x3');
    expect(first.stdout).toContain('drill.coaching_notes x3');
    expect(first.stdout).toContain('dropped inside carried cells: 5');
  });

  it('a second run over the first run\'s output is byte-identical', () => {
    const before = snapshot(first.out);
    expect(run([dir, '--out', first.out]).status).toBe(2);
    expect(snapshot(first.out)).toEqual(before);
  });

  it('keeps every committed row outside lane 2 byte for byte, in its place, and appends the lane-2 rows', () => {
    const seed = committedSeed();
    const out = exportInto(dir, seed).out;
    for (const name of [DRILLS, CUES, STOPS]) expect(read(out, name).startsWith(read(seed, name))).toBe(true);
    expect(rowsOf(read(out, DRILLS)).map((row) => row.drill_id)).toEqual(['drl_0000000000aaaa', LR, YS, D23]);
    run([dir, '--out', out]);
    expect(rowsOf(read(out, DRILLS))).toHaveLength(4);
  });

  it('will not put the frozen blanks back over drafted lane-2 fields, cues, stop rules or rule kinds unless --allow-overwrite, and then lists them', () => {
    const seed = exportInto(dir, committedSeed()).out;
    const table = readCsv(read(seed, DRILLS));
    const at = (name: string) => table.header.indexOf(name);
    const rows = table.records.map((record) => [...record.cells]);
    const lr = rows.find((cells) => cells[at('drill_id')] === LR)!;
    lr[at('purpose')] = 'Teaches the boxer to read before acting.';
    lr[at('difficulty')] = 'intermediate';
    fs.writeFileSync(path.join(seed, DRILLS), writeCsv(table.header, rows));
    fs.appendFileSync(path.join(seed, CUES), `${ORG},cue_0000000000bbbb,${LR},"See first, then score or leave.",,unspecified,,DOC-027\n`);
    fs.appendFileSync(path.join(seed, STOPS), `${ORG},stp_0000000000bbbb,${LR},1,Stop the round when the roles break down.,drill_specific,intent_drift\n`);
    const stops = readCsv(read(seed, STOPS));
    const kind = stops.header.indexOf('rule_kind');
    fs.writeFileSync(path.join(seed, STOPS), writeCsv(stops.header, stops.records.map(({ cells }) => (cells[0 + stops.header.indexOf('drill_id')] === D23 ? cells.map((cell, i) => (i === kind ? 'technique_degradation' : cell)) : cells))));

    const refused = exportInto(dir, seed);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('refused: this run would change or remove 4 committed lane-2 row(s)');
    expect(refused.stderr).toContain(`${DRILLS} drill_id ${LR}: changes purpose, difficulty\n`);
    expect(refused.stderr).toContain(`${CUES} drill_id ${LR}: removes cue_0000000000bbbb\n`);
    expect(refused.stderr).toContain(`${STOPS} drill_id ${LR}: removes stp_0000000000bbbb\n`);
    expect(refused.stderr).toContain(`${STOPS} drill_id ${D23}: changes rule_kind of stp_00000000000001\n`);
    expect(refused.stderr).toContain('Nothing was written.');
    expect(refused.stderr).not.toContain('drl_0000000000aaaa');
    expect(snapshot(refused.out)).toEqual(snapshot(seed));

    const forced = exportInto(dir, seed, ['--allow-overwrite']);
    expect(forced.status).toBe(2);
    expect(forced.stdout).toContain('--allow-overwrite: changed or removed 4 committed row(s)');
    expect(rowsOf(read(forced.out, DRILLS)).find((row) => row.drill_id === LR)?.purpose).toBe('');
    expect(read(forced.out, DRILLS).startsWith(read(committedSeed(), DRILLS))).toBe(true);
  });

  it('stops on a lane-2 drill named like a committed drill of the same discipline, writing nothing', () => {
    const seed = committedSeed();
    const named = fixture();
    named[1].name = 'Committed drill, "quoted", with a comma';
    const result = exportInto(backbone(named), seed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`drill ${LR} "Committed drill, "quoted", with a comma" has the name of committed drill drl_0000000000aaaa`);
    expect(snapshot(result.out)).toEqual(snapshot(seed));
  });

  it('stops on a file whose hash differs from the manifest, or that the manifest does not list', () => {
    const tampered = backbone(fixture(), (root) => fs.appendFileSync(path.join(root, `data/content/drills/${LR}.json`), ' '));
    expect(exportInto(tampered).stderr).toContain(`data/content/drills/${LR}.json: hash`);
    const extra = backbone(fixture(), (root) => fs.writeFileSync(path.join(root, 'data/content/drills/drl_ffffffffffffff.json'), '{"record":{}}'));
    expect(exportInto(extra).stderr).toContain('is not in FREEZE_MANIFEST.json');
  });

  it('stops on a record key that has no column and is not on the not-carried list, and on a drill in no source group', () => {
    const data = fixture();
    data[1].surprise_field = 'x';
    expect(exportInto(backbone(data)).stderr).toContain('key "surprise_field" has no column');
    const orphan = fixture();
    orphan[2].content_class = 'some other material';
    expect(exportInto(backbone(orphan)).stderr).toContain('belong to no source group');
  });
});
