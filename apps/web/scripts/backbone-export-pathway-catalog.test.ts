import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readCsv, writeCsv } from '../src/server/pilot/contentImport/csv';
import { loadOfflineReferenceSets } from '../src/server/pilot/contentImport/referenceSets';
import { FILE_SPECS } from '../src/server/pilot/contentImport/specs';
import { validatePackage } from '../src/server/pilot/contentImport/validate';

// Lane BB-1c: the Backbone -> pathway-catalog exporter, over a small fixture
// Backbone (3 stages, 3 links, 3 defaults and one held out; one lane:non_contact
// default; one stage field without status, one with neither status nor sources).

const SCRIPT = path.resolve(__dirname, 'backbone-export-pathway-catalog.mjs');
const FIXTURE = path.resolve(__dirname, '__fixtures__/backbone-mini');
const SEED_DATA_DIR = path.resolve(__dirname, '../seed-data');
const SPINE = 'data/spine/spine.json';
const CATALOGS = 'working/design-2026-10-25/design_catalogs.json';
const STAGES = 'seed_pathway_stages.csv';
const LINKS = 'seed_pathway_stage_links.csv';
const DEFAULTS = 'seed_pathway_stage_defaults.csv';
const SPINE_TIME = new Date('2026-11-08T23:18:05Z');
const CATALOGS_TIME = new Date('2026-11-09T13:32:02Z');

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-backbone-export-test-'));
  temps.push(dir);
  return dir;
}

/** A copy of the fixture Backbone with fixed modification times, optionally edited. */
/** The parts of the two Backbone files the edits below touch; values are loose on purpose (the refusals feed bad ones). */
interface SpineEdit { stages: { who: { status: unknown } }[] }
interface CatalogsEdit { default_rules: { status: unknown; sources: unknown; value_max: unknown; field_labels?: unknown; evidence: Record<string, unknown>[] }[] }

function backbone(edit?: { spine?: (data: SpineEdit) => void; catalogs?: (data: CatalogsEdit) => void }): string {
  const dir = tempDir();
  fs.cpSync(FIXTURE, dir, { recursive: true });
  for (const [file, change] of [[SPINE, edit?.spine], [CATALOGS, edit?.catalogs]] as const) {
    const full = path.join(dir, file);
    if (change) {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      (change as (parsed: unknown) => void)(data);
      fs.writeFileSync(full, JSON.stringify(data, null, 2));
    }
  }
  fs.utimesSync(path.join(dir, SPINE), SPINE_TIME, SPINE_TIME);
  fs.utimesSync(path.join(dir, CATALOGS), CATALOGS_TIME, CATALOGS_TIME);
  return dir;
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Export a Backbone folder; returns the written files' text by name. */
function exported(dir: string): Record<string, string> {
  const out = tempDir();
  const result = run([dir, '--out', out]);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return Object.fromEntries(fs.readdirSync(out).sort().map((name) => [name, fs.readFileSync(path.join(out, name), 'utf8')]));
}

function rowsOf(text: string): Record<string, string>[] {
  const table = readCsv(text);
  expect(table.problems).toEqual([]);
  return table.records.map((record) => Object.fromEntries(table.header.map((name, index) => [name, record.cells[index]])));
}

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

/** Evaluate an expression against the exporter module in a plain node process (it is ESM). */
function evaluate(expression: string) {
  const script = `import * as m from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
    process.stdout.write(JSON.stringify(await (${expression})));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }));
}

describe('backbone-export-pathway-catalog', () => {
  const dir = backbone();
  const files = exported(dir);
  const stages = rowsOf(files[STAGES]);
  const links = rowsOf(files[LINKS]);
  const defaults = rowsOf(files[DEFAULTS]);
  const VERSION = `spine ${sha(path.join(dir, SPINE))} / catalogs ${sha(path.join(dir, CATALOGS))} / 2026-11-08T23:18:05Z, 2026-11-09T13:32:02Z`;

  it('writes exactly the three package files, each header the spec\'s column list in order', () => {
    expect(Object.keys(files)).toEqual([DEFAULTS, LINKS, STAGES]);
    for (const name of [STAGES, LINKS, DEFAULTS]) {
      const spec = FILE_SPECS.find((file) => file.file === name);
      expect(readCsv(files[name]).header).toEqual(spec?.columns.map((column) => column.name));
    }
  });

  it('the package it writes validates offline with no blocking finding', () => {
    const result = validatePackage(
      Object.entries(files).map(([name, text]) => ({ path: `pathway-catalog/${name}`, text })),
      { references: loadOfflineReferenceSets(SEED_DATA_DIR) },
    );
    expect(result.blocking).toEqual([]);
  });

  it('prints the counts and the backbone_version, and stamps that version on every row', () => {
    const result = run([dir, '--out', tempDir()]);
    expect(result.stdout).toContain(`backbone_version: ${VERSION}`);
    expect(result.stdout).toContain('stages 3, links 3, defaults 3 (1 held)');
    // Held by rule: a sources key holding a list separator (PR #1895 Q5); printed with its id, not exported.
    expect(result.stdout).toContain('held (a sources key holds a list separator | ; or ,): 1 rows: dft_b8c1b8001eea2b');
    expect(files[DEFAULTS]).not.toContain('dft_b8c1b8001eea2b');
    expect(files[DEFAULTS]).not.toContain('HELD-ROW-TEXT');
    // A default's field labels that are not {status, sources} (here two strings) are left blank and counted, never mapped.
    expect(result.stdout).toContain('field_labels not in {status, sources} shape: 1 rows, 2 cells, left blank');
    // Licensed excerpts never reach the public repository (OD-2026-10-02-013 2A; PR #1895 Q6).
    expect(result.stdout).toContain("evidence 'quotes' (licensed excerpts, OD-2026-10-02-013 2A) not carried: 2 keys on 1 rows");
    expect(files[DEFAULTS]).not.toContain('QUOTED-EXCERPT-TEXT');
    expect(files[DEFAULTS]).not.toContain('NESTED-EXCERPT-TEXT');
    for (const row of [...stages, ...links, ...defaults]) {
      expect(row.backbone_version).toBe(VERSION);
      expect(row.organization_id).toBe('{{PPBF_ORG_ID}}');
      expect(row.active_flag).toBe('true');
      expect(row.stage_keys).toBe('');
    }
  });

  it('stages: ordered by order; text copied (NFC, trimmed); spine fields P1 has no column for are not exported', () => {
    expect(stages.map((row) => [row.stage_key, row.segment, row.ordinal, row.contact_default])).toEqual([
      ['Y1', 'youth', '1', 'none'],
      ['RC1', 'recreational', '2', 'light_technical'],
      ['EX1', 'exit', '3', 'none'],
    ]);
    const y1 = stages[0];
    expect(y1.name).toBe('Café Introduction');
    expect(y1.who_text).toBe('Ages 5-8, "a guide", never a gate');
    expect([y1.ppbf_name, y1.ppbf_name_meaning, y1.ppbf_name_language]).toEqual(['AURORA', 'dawn', 'Latin']);
    expect(y1.age_band_guide_text).toBe('');
    expect(y1.evidence).toBe('');
    expect(stages[2].ppbf_name_meaning).toBe('');
    for (const text of ['not exported', 'Recreation-lane', 'contact-track']) expect(files[STAGES]).not.toContain(text);
  });

  it('stages: field_labels keyed by column, each the spine field\'s own status and sources; a field with neither gets no entry', () => {
    expect(JSON.parse(stages[0].field_labels)).toEqual({
      who_text: { status: 'OBSERVED', sources: ['FIX-1', 'Owner 2026-10-23'] },
      develops_text: { status: 'REPORTED', sources: ['FIX-1'] },
      typical_duration_text: { status: 'REPORTED', sources: ['FIX-1'] },
      contact_default: { status: 'REPORTED', sources: ['FIX-1'] },
      competition_text: { status: 'REPORTED', sources: ['FIX-1'] },
      ppbf_name: { status: 'REPORTED', sources: ['Owner 2026-10-24'] },
      ppbf_name_meaning: { status: 'REPORTED', sources: ['Owner 2026-10-24'] },
      ppbf_name_language: { status: 'REPORTED', sources: ['Owner 2026-10-24'] },
    });
    // EX1: develops has no status and no sources (no entry); competition has sources and no status;
    // there is no PPBF name meaning or language to label.
    expect(JSON.parse(stages[2].field_labels)).toEqual({
      who_text: { status: 'REPORTED', sources: ['FIX-1'] },
      typical_duration_text: { status: 'INFERRED', sources: ['FIX-1'] },
      contact_default: { status: 'REPORTED', sources: ['FIX-1'] },
      competition_text: { sources: ['FIX-1'] },
      ppbf_name: { status: 'REPORTED', sources: ['Owner 2026-10-24'] },
    });
    expect(stages[2].develops_text).toBe('Transition');
    // Key-sorted JSON (canonical.ts compares JSON cells this way).
    expect(stages[2].field_labels.indexOf('"competition_text"')).toBeLessThan(stages[2].field_labels.indexOf('"contact_default"'));
  });

  it('links: one per next_stages entry, ordered by from then to, no labels of their own', () => {
    expect(links.map((row) => [row.from_stage_key, row.to_stage_key, row.link_kind])).toEqual([
      ['EX1', 'RC1', 'lateral'],
      ['Y1', 'EX1', 'exit'],
      ['Y1', 'RC1', 'lateral'],
    ]);
    for (const row of links) expect([row.field_labels, row.evidence]).toEqual(['', '']);
  });

  it('link_kind: exit to EX1; lateral within one segment and lane, or into RC1/FT1 from outside recreational; branch for more than one other; else progression', () => {
    const stage = (stage_id: string, segment: string, next_stages: string[], lane?: string) => ({ stage_id, segment, next_stages, ...(lane ? { lane } : {}) });
    const kinds = evaluate(`m.linkKinds(${JSON.stringify([
      stage('Y4', 'youth', ['Y5', 'RC1', 'EX1']),
      stage('Y5', 'youth', ['T2', 'AM1', 'RC1', 'EX1', 'FT1']),
      stage('T2', 'trunk', ['AM1']),
      stage('RC1', 'recreational', ['T1', 'T2', 'FT1', 'EX1'], 'Recreation'),
      stage('FT1', 'recreational', ['RC1', 'T1'], 'Recreation'),
      stage('EX1', 'exit', ['RC1', 'FT1']),
    ])})`);
    expect(kinds.map((link: { from: string; to: string; kind: string }) => `${link.from}>${link.to} ${link.kind}`)).toEqual([
      // Same segment, no lane: a progression, not a lateral move.
      'Y4>Y5 progression', 'Y4>RC1 lateral', 'Y4>EX1 exit',
      'Y5>T2 branch', 'Y5>AM1 branch', 'Y5>RC1 lateral', 'Y5>EX1 exit', 'Y5>FT1 lateral',
      'T2>AM1 progression',
      // RC1 and FT1: the same segment and the same lane, lateral to each other (PR #1895 Q3 B).
      'RC1>T1 branch', 'RC1>T2 branch', 'RC1>FT1 lateral', 'RC1>EX1 exit',
      'FT1>RC1 lateral', 'FT1>T1 progression',
      'EX1>RC1 lateral', 'EX1>FT1 lateral',
    ]);
  });

  it('defaults: ordered by default_id, kept exactly; value columns, sources and phases copied; keys with no column not exported', () => {
    expect(defaults.map((row) => [row.default_id, row.scope, row.default_key, row.kind, row.status])).toEqual([
      ['dft_7229a7f8553bd2', 'RC1', 'recreation_lane_track', 'owner_rule', 'OBSERVED'],
      ['dft_d2df806b992416', 'lane:non_contact', 'contact_level_ceiling', 'default_rule', 'INFERRED'],
      ['dft_d8e8cc1831f1f0', 'Y1', 'sparring_rounds_per_7d_max', 'default_rule', 'REPORTED'],
    ]);
    const [rc1, lane, y1] = defaults;
    expect([y1.value_min, y1.value_max, y1.unit, y1.window_days, y1.sparring_type, y1.composite_parent]).toEqual(['0.5', '2', 'rounds', '7', 'technical', 'LR-140']);
    expect(y1.display_text).toBe('Max 2 rounds, 7 days, "technical" only');
    expect(y1.sources).toBe('LR-140|FIX-1');
    expect([lane.value_text, lane.value_vocabulary, lane.phases]).toEqual(['light_technical', 'none|light_technical', '']);
    expect(rc1.phases).toBe('[{"months_in_stage":"0-12","value_max":0},{"months_in_stage":"12+","value_max":2}]');
    for (const row of defaults) expect(row.field_labels).toBe('');
    for (const text of ['not exported', 'D-FIX', 'allowed']) expect(files[DEFAULTS]).not.toContain(text);
  });

  it('defaults: evidence is the row\'s whole list, every entry and every key but quotes kept as written, key-sorted; an empty list is blank', () => {
    const [rc1, , y1] = defaults;
    expect(JSON.parse(y1.evidence)).toEqual([
      { evidence_label: 'CONVENTION', evidence_category: 'convention', check_state: 'unchecked', basis: 'fixture, kept as written', zeta_extra: [3, 1] },
      {
        evidence_category: 'research', evidence_label: 'EMERGING', check_state: 'checked', source_key: 'FIX-2',
        // A nested part passes through as written, its "n/a" label included (PR #1895 Q8); only its quotes are dropped.
        beside: [{ source: 'FIX-3', location: 'Table 1', evidence_label: 'n/a', role: 'related' }],
      },
    ]);
    expect(y1.evidence.startsWith('[{"basis":"fixture, kept as written","check_state"')).toBe(true);
    expect(rc1.evidence).toBe('');
  });

  it('writes each file exactly as contentImport/csv.ts writeCsv would (what content:prepare commits)', () => {
    for (const text of Object.values(files)) {
      const table = readCsv(text);
      expect(writeCsv(table.header, table.records.map((record) => record.cells))).toBe(text);
    }
  });

  it('holds out, by rule, a default whose sources key holds any list separator: | ; or ,', () => {
    for (const key of ['FIX|A', 'FIX;A', 'FIX,A']) {
      const result = run([backbone({ catalogs: (data) => { data.default_rules[2].sources = ['FIX-1', key]; } }), '--out', tempDir()]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('2 rows: dft_7229a7f8553bd2, dft_b8c1b8001eea2b');
    }
  });

  it('is deterministic: two runs over the same files are byte-identical, LF only, UTF-8 without BOM', () => {
    const again = exported(dir);
    expect(again).toEqual(files);
    for (const text of Object.values(files)) {
      expect(text.includes('\r')).toBe(false);
      expect(text.charCodeAt(0)).not.toBe(0xfeff);
      expect(text.endsWith('\n')).toBe(true);
    }
    // Input order does not leak into output order.
    const shuffled = exported(backbone({ spine: (data) => data.stages.reverse(), catalogs: (data) => data.default_rules.reverse() }));
    expect(shuffled[STAGES].split('\n').slice(1).map((line) => line.split(',')[1])).toEqual(files[STAGES].split('\n').slice(1).map((line) => line.split(',')[1]));
    expect(shuffled[DEFAULTS].split('\n').map((line) => line.split(',')[1])).toEqual(files[DEFAULTS].split('\n').map((line) => line.split(',')[1]));
  });

  it('refuses a missing or extra argument with the usage line, and a folder without the two files', () => {
    // Every case names a temporary --out, so a broken argument check can never write into seed-data.
    const out = tempDir();
    for (const args of [['--out', out], [dir, dir, '--out', out], [dir, '--bogus', '--out', out]]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('usage: node scripts/backbone-export-pathway-catalog.mjs <backbone-folder>');
    }
    const empty = run([tempDir(), '--out', tempDir()]);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('not found');
  });

  it('refuses, by name and without mapping, a status or evidence_label outside the vocabularies, and a non-number', () => {
    const cases: [Parameters<typeof backbone>[0], string][] = [
      [{ spine: (data) => { data.stages[1].who.status = 'Reported'; } }, 'stage Y1 who: status "Reported" is not one of OBSERVED, REPORTED, INFERRED, UNVERIFIED'],
      [{ catalogs: (data) => { data.default_rules[1].status = 'CONFIRMED'; } }, 'default dft_d2df806b992416: status "CONFIRMED" is not one of'],
      [{ catalogs: (data) => { data.default_rules[0].evidence[1].evidence_label = 'STRONG'; } }, 'default dft_d8e8cc1831f1f0: evidence entry 2 evidence_label "STRONG" is not one of'],
      [{ catalogs: (data) => { data.default_rules[0].field_labels = { unit: { status: 'GUESS' } }; } }, 'field_labels.unit: status "GUESS" is not one of'],
      [{ catalogs: (data) => { data.default_rules[0].value_max = '2'; } }, 'default dft_d8e8cc1831f1f0 value_max is "2", not a number'],
    ];
    for (const [edit, message] of cases) {
      const result = run([backbone(edit), '--out', tempDir()]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    }
  });

  it('a default carrying per-field labels in the {status, sources} shape keeps them, key-sorted (sources alone too, as on a stage)', () => {
    const labelled = exported(backbone({
      catalogs: (data) => { data.default_rules[0].field_labels = { value_max: { sources: ['LR-140'], status: 'INFERRED' }, unit: { sources: ['LR-140'] } }; },
    }));
    const row = rowsOf(labelled[DEFAULTS]).find((r) => r.default_id === 'dft_d8e8cc1831f1f0');
    expect(row?.field_labels).toBe('{"unit":{"sources":["LR-140"]},"value_max":{"sources":["LR-140"],"status":"INFERRED"}}');
  });
});
