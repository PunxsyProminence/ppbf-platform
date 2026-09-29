import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPrepare } from './contentImport/cli';
import { readCsv, writeCsv } from './contentImport/csv';
import { MINT } from './contentImport/ids';
import { loadOfflineReferenceSets, readCommittedBaseline } from './contentImport/referenceSets';
import { fileSpecByName } from './contentImport/specs';
import { validateParsed } from './contentImport/validate';

/*
  `content:prepare` against a TEMPORARY COPY of the committed seed data, never
  the real folder. It must MERGE: replace rows it names, add new ones, replace
  a parent's child rows only where the package lists that parent, and never
  drop a row the package leaves out -- copying a subset over the committed
  CSVs would silently delete the rest (CRITIQUE, missing).
*/

const REAL_SEED_DATA = path.resolve(__dirname, '../../../seed-data');
const DATASET_FOLDERS = ['multidiscipline', 'competence-cohorts', 'drill-library', 'workout-templates', 'session-scripts', 'transfer-claims'];
const CHUNKS = 'shadow-research/2026-08-07/seed_shadow_library_chunks.csv';

const REVISED_DRILL = 'drl_7f812fecacfee4'; // Touch to Reposition: 3 scale rows, 10 stop rules
const TEMPLATE = 'wtp_216dfa4227233d'; // Intro to Boxing -- Session 1: 7 items

let root: string;
let seedData: string;
let handoff: string;

function copySeedData(target: string): void {
  for (const folder of DATASET_FOLDERS) fs.cpSync(path.join(REAL_SEED_DATA, folder), path.join(target, folder), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(target, CHUNKS)), { recursive: true });
  fs.copyFileSync(path.join(REAL_SEED_DATA, CHUNKS), path.join(target, CHUNKS));
}

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[path.relative(dir, abs).replace(/\\/g, '/')] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function table(relative: string, dir = seedData) {
  const parsed = readCsv(fs.readFileSync(path.join(dir, relative), 'utf8'));
  return parsed.records.map((record) => Object.fromEntries(parsed.header.map((name, i) => [name, record.cells[i]])));
}

/** A package file with every column its spec defines. */
function writePackageFile(file: string, rows: Record<string, string>[]): void {
  const spec = fileSpecByName(file);
  if (!spec) throw new Error(`no spec ${file}`);
  const header = spec.columns.map((column) => column.name);
  fs.mkdirSync(path.join(handoff, spec.folder), { recursive: true });
  fs.writeFileSync(path.join(handoff, spec.folder, file), writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? ''))));
}

function prepare(write: boolean): { code: number; output: string } {
  const lines: string[] = [];
  const code = runPrepare({ packageDir: handoff, seedDataDir: seedData, write }, { log: (line) => lines.push(line) });
  return { code, output: lines.join('\n') };
}

/** The committed drill row, revised: one content field changed, every tool-decided column left blank. */
function revisedDrill(): Record<string, string> {
  const committed = table('drill-library/seed_drill_library.csv', REAL_SEED_DATA).find((row) => row.drill_id === REVISED_DRILL);
  if (!committed) throw new Error('fixture drill missing');
  return { ...committed, purpose: 'Score clean, then leave on an angle. Revised.', lineage_id: '', version: '', active: '', created_by_account_id: '', organization_id: '' };
}

function newDrill(): Record<string, string> {
  return {
    drill_id: 'new:mirror-jab',
    name: 'Mirror Jab',
    discipline: 'boxing',
    category: 'technical',
    skill_id: 'SK-JAB-01',
    target_behavior: 'The jab comes home before the feet move.',
    purpose: 'Build a jab that returns to the chin.',
    standard_setup: 'Mirror; stance width marked on the floor.',
    execution: 'Jab, return, step, repeat.',
    what_good_looks_like: 'Hand back to the chin before the next step.',
    contact_level: 'none',
    requires_coach_authorization: 'false',
    content_class: 'COACHING CRAFT - PPBF source manual v3',
    difficulty: 'beginner',
    grounding_claim_ids: 'A2-063 | A2-068',
    field_provenance: 'PPBF source manual v3',
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-content-prepare-'));
  seedData = path.join(root, 'seed-data');
  handoff = path.join(root, 'handoff');
  fs.mkdirSync(handoff);
  copySeedData(seedData);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('content:prepare merges a hand-off into the committed files', () => {
  beforeEach(() => {
    writePackageFile('seed_drill_library.csv', [revisedDrill(), newDrill()]);
    writePackageFile('seed_drill_scale_levels.csv', [
      { drill_id: 'new:mirror-jab', scale_level: 'A', is_starting_point: 'false', demand_description: 'Slow, against the mirror.' },
      { drill_id: 'new:mirror-jab', scale_level: 'B', is_starting_point: 'true', demand_description: 'At working pace.' },
      { drill_id: 'new:mirror-jab', scale_level: 'C', is_starting_point: 'false', demand_description: 'Partner calls the step.' },
    ]);
    writePackageFile('seed_drill_stop_rules.csv', [
      { drill_id: REVISED_DRILL, ordinal: '1', condition_text: 'Stop when exits become late on consecutive reps.', rule_kind: 'technique_degradation' },
      { drill_id: REVISED_DRILL, ordinal: '2', condition_text: 'Stop when fatigue makes balance recovery unreliable.', rule_kind: 'fatigue' },
      { drill_id: 'new:mirror-jab', ordinal: '1', condition_text: 'Stop when the hand stays out.', rule_kind: 'technique_degradation' },
    ]);
    writePackageFile('seed_workout_template_items.csv', [
      { template_id: TEMPLATE, ordinal: '1', block: 'warmup', drill_id: 'drl_dbb0347500e7eb', duration_minutes: '8', contact_level: 'none' },
      { template_id: TEMPLATE, ordinal: '2', block: 'technical', drill_id: 'new:mirror-jab', duration_minutes: '10', contact_level: 'none' },
    ]);
  });

  it('without --write it reports the merge and writes nothing', () => {
    const before = hashTree(seedData);
    const { code, output } = prepare(false);
    expect(code).toBe(0);
    expect(output).toContain('RESULT: DRY RUN');
    expect(hashTree(seedData)).toEqual(before);
  });

  it('mints the new drill by the committed formula and rewrites every reference to it', () => {
    const { code, output } = prepare(true);
    expect(code).toBe(0);
    const minted = MINT.drill('boxing', 'Mirror Jab');
    expect(output).toContain(`drill new:mirror-jab -> ${minted}`);

    const drills = table('drill-library/seed_drill_library.csv');
    const added = drills.find((row) => row.drill_id === minted);
    expect(added).toMatchObject({
      lineage_id: minted,
      version: '1',
      active: 'true',
      organization_id: '{{PPBF_ORG_ID}}',
      created_by_account_id: '{{SEED_ACCOUNT_ID}}',
      grounding_claim_ids: 'A2-063|A2-068',
    });
    expect(table('drill-library/seed_drill_scale_levels.csv').filter((row) => row.drill_id === minted).map((row) => row.scale_id)).toEqual([
      MINT.scale(minted, 'A'),
      MINT.scale(minted, 'B'),
      MINT.scale(minted, 'C'),
    ]);
    expect(table('workout-templates/seed_workout_template_items.csv').find((row) => row.template_id === TEMPLATE && row.ordinal === '2')?.drill_id).toBe(minted);
    for (const relative of ['drill-library/seed_drill_scale_levels.csv', 'drill-library/seed_drill_stop_rules.csv', 'workout-templates/seed_workout_template_items.csv']) {
      expect(fs.readFileSync(path.join(seedData, relative), 'utf8')).not.toContain('new:');
    }
  });

  it('puts the minted ids into the hand-off files, so preparing the same folder again changes nothing', () => {
    expect(prepare(true).code).toBe(0);
    const minted = MINT.drill('boxing', 'Mirror Jab');
    const handoffLibrary = fs.readFileSync(path.join(handoff, 'drill-library/seed_drill_library.csv'), 'utf8');
    expect(handoffLibrary).toContain(minted);
    expect(handoffLibrary).not.toContain('new:');

    // Before the write-back, a second run refused every new: item because its
    // minted id now exists in the committed library (minted_id_exists).
    const afterFirst = hashTree(seedData);
    const second = prepare(true);
    expect(second.output).toContain('BLOCKING: 0');
    expect(second.code).toBe(0);
    expect(hashTree(seedData)).toEqual(afterFirst);
  });

  it('replaces a revised row in place and keeps its committed id, lineage, version and placeholders', () => {
    const before = table('drill-library/seed_drill_library.csv', REAL_SEED_DATA);
    expect(prepare(true).code).toBe(0);
    const after = table('drill-library/seed_drill_library.csv');

    const index = before.findIndex((row) => row.drill_id === REVISED_DRILL);
    expect(after[index]).toMatchObject({
      drill_id: REVISED_DRILL,
      lineage_id: REVISED_DRILL,
      version: '1',
      active: 'True',
      organization_id: '{{PPBF_ORG_ID}}',
      created_by_account_id: '{{SEED_ACCOUNT_ID}}',
      purpose: 'Score clean, then leave on an angle. Revised.',
    });
    expect(after).toHaveLength(before.length + 1);
  });

  it("replaces a drill's child rows only where the package lists that drill, and never drops anything it leaves out", () => {
    const beforeStops = table('drill-library/seed_drill_stop_rules.csv', REAL_SEED_DATA);
    const beforeScale = table('drill-library/seed_drill_scale_levels.csv', REAL_SEED_DATA);
    expect(prepare(true).code).toBe(0);
    const afterStops = table('drill-library/seed_drill_stop_rules.csv');

    // The revised drill's 10 committed stop rules become the package's 2; its
    // committed ids are kept where (drill, ordinal) matches.
    const revised = afterStops.filter((row) => row.drill_id === REVISED_DRILL);
    expect(beforeStops.filter((row) => row.drill_id === REVISED_DRILL)).toHaveLength(10);
    expect(revised.map((row) => [row.ordinal, row.stop_rule_id])).toEqual(
      beforeStops.filter((row) => row.drill_id === REVISED_DRILL && ['1', '2'].includes(row.ordinal)).map((row) => [row.ordinal, row.stop_rule_id]),
    );
    expect(revised.map((row) => row.condition_text)).toEqual([
      'Stop when exits become late on consecutive reps.',
      'Stop when fatigue makes balance recovery unreliable.',
    ]);
    expect(afterStops).toHaveLength(beforeStops.length - 10 + 2 + 1);

    // Every other drill's rows are exactly what they were.
    const untouched = (rows: Record<string, string>[]) => rows.filter((row) => row.drill_id !== REVISED_DRILL && row.drill_id !== MINT.drill('boxing', 'Mirror Jab'));
    expect(untouched(afterStops)).toEqual(untouched(beforeStops));
    // The package listed no scale rows for the revised drill, so it keeps its three.
    expect(table('drill-library/seed_drill_scale_levels.csv').filter((row) => row.drill_id === REVISED_DRILL)).toEqual(
      beforeScale.filter((row) => row.drill_id === REVISED_DRILL),
    );
    // No committed drill id disappeared from any drill file.
    for (const relative of ['drill-library/seed_drill_library.csv', 'drill-library/seed_drill_scale_levels.csv', 'drill-library/seed_drill_cues.csv']) {
      const beforeIds = new Set(table(relative, REAL_SEED_DATA).map((row) => row.drill_id));
      const afterIds = new Set(table(relative).map((row) => row.drill_id));
      expect([...beforeIds].filter((id) => !afterIds.has(id))).toEqual([]);
    }
  });

  it("replaces a template's items as one set and leaves the other templates' items alone", () => {
    const before = table('workout-templates/seed_workout_template_items.csv', REAL_SEED_DATA);
    expect(prepare(true).code).toBe(0);
    const after = table('workout-templates/seed_workout_template_items.csv');
    expect(after.filter((row) => row.template_id === TEMPLATE).map((row) => row.item_id)).toEqual([
      before.find((row) => row.template_id === TEMPLATE && row.ordinal === '1')?.item_id,
      MINT.templateItem(TEMPLATE, '2'),
    ]);
    expect(after.filter((row) => row.template_id !== TEMPLATE)).toEqual(before.filter((row) => row.template_id !== TEMPLATE));
  });

  it('leaves every file the package does not touch byte for byte, and the merged data still meets the contract', () => {
    const before = hashTree(seedData);
    expect(prepare(true).code).toBe(0);
    const after = hashTree(seedData);
    const changed = Object.keys(before).filter((file) => before[file] !== after[file]).sort();
    expect(changed).toEqual([
      'drill-library/seed_drill_library.csv',
      'drill-library/seed_drill_scale_levels.csv',
      'drill-library/seed_drill_stop_rules.csv',
      'workout-templates/seed_workout_template_items.csv',
    ]);

    const baseline = readCommittedBaseline(seedData);
    const blocking = validateParsed(baseline, { references: loadOfflineReferenceSets(seedData, baseline), baseline }).blocking;
    expect(blocking.every((finding) => finding.file === 'transfer-claims/seed_transfer_claims.csv')).toBe(true);
    expect(blocking).toHaveLength(173);
  });
});

describe('content:prepare refuses', () => {
  it('a package with a blocking finding, and writes nothing', () => {
    writePackageFile('seed_drill_library.csv', [{ ...newDrill(), contact_level: 'light-technical' }]);
    const before = hashTree(seedData);
    const { code, output } = prepare(true);
    expect(code).toBe(1);
    expect(output).toContain('[unknown_value]');
    expect(hashTree(seedData)).toEqual(before);
  });

  it('a merge that would leave a blocking problem the committed files do not have', () => {
    // The package is valid on its own: one drill's A/B/C with B as the start.
    // But its A row reuses a scale_id another committed drill already holds,
    // which only the merged file shows -- and the fast guard would then fail
    // the PR. prepare refuses it before writing.
    const otherId = table('drill-library/seed_drill_scale_levels.csv', REAL_SEED_DATA).find((row) => row.drill_id !== REVISED_DRILL)?.scale_id ?? '';
    writePackageFile('seed_drill_scale_levels.csv', [
      { drill_id: REVISED_DRILL, scale_id: otherId, scale_level: 'A', is_starting_point: 'false', demand_description: 'A.' },
      { drill_id: REVISED_DRILL, scale_level: 'B', is_starting_point: 'true', demand_description: 'B.' },
      { drill_id: REVISED_DRILL, scale_level: 'C', is_starting_point: 'false', demand_description: 'C.' },
    ]);
    const before = hashTree(seedData);
    const { code, output } = prepare(true);
    expect(code).toBe(1);
    expect(output).toContain('RESULT: REFUSED');
    expect(output).toContain('[duplicate_id]');
    expect(hashTree(seedData)).toEqual(before);
  });
});

describe('re-sending committed rows unchanged', () => {
  it('is reported as unchanged and rewrites nothing', () => {
    const committed = table('workout-templates/seed_workout_templates.csv', REAL_SEED_DATA).slice(0, 2);
    writePackageFile('seed_workout_templates.csv', committed);
    const before = hashTree(seedData);
    const { code, output } = prepare(true);
    expect(code).toBe(0);
    expect(output).toContain('workout-templates/seed_workout_templates.csv: no change');
    expect(output).toContain('unchanged: 2');
    expect(hashTree(seedData)).toEqual(before);
  });
});
