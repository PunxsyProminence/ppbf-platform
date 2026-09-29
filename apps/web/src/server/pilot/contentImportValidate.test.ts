import { canonicalCell, unitContentHash } from './contentImport/canonical';
import { writeCsv } from './contentImport/csv';
import { MINT, REGISTRY_CLAIM_ID_PATTERN } from './contentImport/ids';
import { datasetSpec, fileSpecByName } from './contentImport/specs';
import type { FileSpec, FindingCode, PackageFileInput, ParsedPackage, ReferenceSets, WarningCode } from './contentImport/types';
import { parsePackage, validatePackage, type ValidationResult } from './contentImport/validate';
import { splitList } from './contentImport/values';
import { VOCABULARIES } from './contentImport/vocabularies';
import { COMPETENCE_DOMAINS } from './competenceCohorts';

/*
  The offline content-import validator, rule by rule, on small hand-built
  packages. Each case names the failure the rule exists for; most of them
  are things the old loaders let through silently or only discovered as a
  database error half way through a seed run.

  The reference sets are built here rather than read from the committed files
  so a case depends only on what it states. contentPackageContract.test.ts runs
  the same validator over the real committed data.
*/

const EXISTING_DRILL = MINT.drill('boxing', 'Touch to Reposition');
const EXISTING_TEMPLATE = MINT.template('Beginner Footwork');

const references: ReferenceSets = {
  claimIds: new Set(['A1-001', 'A2-002', 'PS-001']),
  skillCodes: new Set(['SK-STANCE-01', 'SK-GUARD-02', 'SK-FW-04']),
  disciplines: new Set(['boxing', 'conditioning']),
  levelOrdinals: new Set([1, 2, 3, 4, 5, 6]),
  drills: new Map([[EXISTING_DRILL, { discipline: 'boxing', name: 'Touch to Reposition', skillId: 'SK-FW-04' }]]),
  templates: new Set([EXISTING_TEMPLATE]),
  scripts: new Set(),
  blocks: new Set(),
};

function spec(file: string): FileSpec {
  const found = fileSpecByName(file);
  if (!found) throw new Error(`no spec ${file}`);
  return found;
}

/** A CSV with every column the spec defines, blanks where a row says nothing. */
function csvFor(file: string, rows: Record<string, string>[], header = spec(file).columns.map((c) => c.name)): string {
  return writeCsv(header, rows.map((row) => header.map((name) => row[name] ?? '')));
}

function input(file: string, rows: Record<string, string>[], folder = 'drill-library'): PackageFileInput {
  return { path: `${folder}/${file}`, text: csvFor(file, rows) };
}

function drill(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    organization_id: '{{PPBF_ORG_ID}}',
    drill_id: 'new:mirror-jab',
    name: 'Mirror Jab',
    discipline: 'boxing',
    category: 'technical',
    skill_id: 'SK-STANCE-01',
    target_behavior: 'Jab lands and the guard returns before the next step.',
    purpose: 'Build a jab that comes home.',
    standard_setup: 'Mirror, stance width marked on the floor.',
    execution: 'Jab, return, step, repeat.',
    what_good_looks_like: 'Hand back to the chin before the feet move.',
    contact_level: 'none',
    requires_coach_authorization: 'false',
    content_class: 'COACHING CRAFT - PPBF source manual v3',
    created_by_account_id: '{{SEED_ACCOUNT_ID}}',
    difficulty: 'beginner',
    grounding_claim_ids: 'A1-001',
    field_provenance: 'PPBF source manual v3',
    ...overrides,
  };
}

function scale(drillId: string, level: string, start: boolean, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    drill_id: drillId,
    scale_level: level,
    is_starting_point: start ? 'true' : 'false',
    demand_description: `Level ${level} demand.`,
    ...overrides,
  };
}

function stop(drillId: string, ordinal: string, overrides: Record<string, string> = {}): Record<string, string> {
  return { drill_id: drillId, ordinal, condition_text: 'Stop when the guard stays down.', rule_kind: 'technique_degradation', ...overrides };
}

/** A complete, valid new drill: library row, A/B/C with B as the start, one stop rule of its own. */
function goodDrillPackage(drillOverrides: Record<string, string> = {}): PackageFileInput[] {
  const id = drillOverrides.drill_id ?? 'new:mirror-jab';
  return [
    input('seed_drill_library.csv', [drill(drillOverrides)]),
    input('seed_drill_scale_levels.csv', [scale(id, 'A', false), scale(id, 'B', true), scale(id, 'C', false)]),
    input('seed_drill_stop_rules.csv', [stop(id, '1')]),
  ];
}

function run(inputs: PackageFileInput[], baseline?: ParsedPackage): ValidationResult {
  return validatePackage(inputs, { references, baseline });
}

function codes(result: ValidationResult): FindingCode[] {
  return result.blocking.map((finding) => finding.code);
}

function warningCodes(result: ValidationResult): WarningCode[] {
  return result.warnings.map((warning) => warning.code);
}

describe('a valid package', () => {
  it('has no blocking findings, so every case below fails for the reason it names', () => {
    const result = run(goodDrillPackage());
    expect(result.blocking).toEqual([]);
    expect(result.parsed.files.map((file) => file.rows.length)).toEqual([1, 3, 1]);
  });
});

describe('lists', () => {
  it("grounding_claim_ids 'A1-001|A2-002' yields two ids, not one", () => {
    // The old loader split on ; and , only (the retired seed-drill-library.mjs),
    // so 'A1-001|A2-002' became ONE array element and 82 of the 119 committed
    // drills were stored that way. Each id must be its own element.
    expect(splitList('A1-001|A2-002', '|')).toEqual(['A1-001', 'A2-002']);

    // And each is checked on its own: the loaded one passes, the unloaded one is named.
    const result = run(goodDrillPackage({ grounding_claim_ids: 'A1-001 | A9-999' }));
    expect(result.blocking).toEqual([
      expect.objectContaining({ code: 'orphan_reference', column: 'grounding_claim_ids', message: expect.stringContaining('A9-999') }),
    ]);
  });

  it('a database element holding the old joined value hashes the same as the two ids, so it never reads as a revision', () => {
    const column = spec('seed_drill_library.csv').columns.find((c) => c.name === 'grounding_claim_ids');
    if (!column) throw new Error('no grounding_claim_ids column');
    expect(canonicalCell(column, ['A1-001|A2-002'])).toBe(canonicalCell(column, ['A1-001', 'A2-002']));
    expect(canonicalCell(column, 'A1-001 |A2-002')).toBe('A1-001|A2-002');
  });

  it("a blank cell and its column's default are the same content, so a re-sent drill is not a revision", () => {
    // The loader stores 'none' / 'authored' for a blank (as the retired seed-drill-library.mjs did),
    // so a database row and the file that loaded it must hash the same.
    const dataset = datasetSpec('drill-library');
    const scaleRow = (contact: string, state: string) => ({
      scale_level: 'B',
      is_starting_point: 'true',
      demand_description: 'd',
      contact_level: contact,
      authoring_state: state,
    });
    const unit = (row: Record<string, string>) => ({ root: { name: 'x' }, children: { 'seed_drill_scale_levels.csv': [row] } });
    expect(unitContentHash(dataset, unit(scaleRow('', '')))).toBe(unitContentHash(dataset, unit(scaleRow('none', 'authored'))));
    expect(unitContentHash(dataset, unit(scaleRow('', '')))).not.toBe(unitContentHash(dataset, unit(scaleRow('light_technical', ''))));

    const athleteFacing = spec('seed_transfer_claims.csv').columns.find((c) => c.name === 'athlete_facing');
    if (!athleteFacing) throw new Error('no athlete_facing column');
    expect(canonicalCell(athleteFacing, '')).toBe(canonicalCell(athleteFacing, true));
    expect(canonicalCell(athleteFacing, 'TRUE')).toBe('true');
  });

  it.each([
    ['A1-001;A2-002'],
    ['A1-001,A2-002'],
  ])('a %s separator inside grounding_claim_ids is blocking, not silently split or mashed', (value) => {
    const result = run(goodDrillPackage({ grounding_claim_ids: value }));
    expect(codes(result)).toEqual(['bad_separator']);
  });

  it("cohort required_domains keeps its stored ',' separator; a '|' there is blocking, and each domain is checked", () => {
    const cohort = (overrides: Record<string, string>) => ({
      cohort_id: 'new:sparring-room',
      cohort_name: 'Sparring Room',
      discipline: 'boxing',
      ...overrides,
    });
    const ok = run([input('seed_cohort_definitions.csv', [cohort({ required_domains: 'defense, composure' })], 'competence-cohorts')]);
    expect(ok.blocking).toEqual([]);

    const wrong = run([input('seed_cohort_definitions.csv', [cohort({ required_domains: 'defense|composure' })], 'competence-cohorts')]);
    expect(codes(wrong)).toEqual(['bad_separator']);

    const unknown = run([input('seed_cohort_definitions.csv', [cohort({ tenure_bands: 'introduction,veteran' })], 'competence-cohorts')]);
    expect(unknown.blocking).toEqual([expect.objectContaining({ code: 'unknown_value', message: expect.stringContaining('veteran') })]);
  });
});

describe('vocabularies are refused before any database write', () => {
  it('an unknown contact_level is blocking', () => {
    // The old loader passed it through to the CHECK, which failed mid-run.
    const result = run(goodDrillPackage({ contact_level: 'light-technical' }));
    expect(result.blocking).toEqual([expect.objectContaining({ code: 'unknown_value', column: 'contact_level' })]);
  });

  it('an unknown rule_kind is blocking', () => {
    const inputs = goodDrillPackage();
    inputs[2] = input('seed_drill_stop_rules.csv', [stop('new:mirror-jab', '1', { rule_kind: 'injury' })]);
    const result = run(inputs);
    expect(result.blocking).toEqual([expect.objectContaining({ code: 'unknown_value', column: 'rule_kind' })]);
  });

  it('warmup_decay, added by the vocabulary widening migration, is accepted', () => {
    const inputs = goodDrillPackage();
    inputs[2] = input('seed_drill_stop_rules.csv', [stop('new:mirror-jab', '1', { rule_kind: 'warmup_decay' })]);
    expect(run(inputs).blocking).toEqual([]);
  });

  it('the competence domains match the list competenceCohorts.ts reads cohorts against', () => {
    expect([...VOCABULARIES.competence_domain.values]).toEqual([...COMPETENCE_DOMAINS]);
  });
});

describe('keys and ids', () => {
  it('a duplicate drill key is blocking', () => {
    const result = run([input('seed_drill_library.csv', [drill(), drill({ name: 'Mirror Jab Two' })])]);
    expect(codes(result)).toContain('duplicate_key');
  });

  it('two stop rules at the same (drill, ordinal) are blocking', () => {
    const inputs = goodDrillPackage();
    inputs[2] = input('seed_drill_stop_rules.csv', [stop('new:mirror-jab', '1'), stop('new:mirror-jab', '1', { condition_text: 'Stop when feet cross.' })]);
    const result = run(inputs);
    expect(result.blocking).toEqual([expect.objectContaining({ code: 'duplicate_key', key: 'new:mirror-jab / 1' })]);
  });

  it.each([
    ['drl_XYZ', 'drill_id'],
    ['new:Mirror_Jab', 'drill_id'],
  ])('%s is a bad id shape', (value, column) => {
    const result = run(goodDrillPackage({ drill_id: value }));
    expect(result.blocking).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'bad_id', column })]));
  });

  it('SKILL-02 in a skill column is blocking; family ids are derived, never stored (D2-B)', () => {
    const result = run(goodDrillPackage({ skill_id: 'SKILL-02' }));
    expect(result.blocking).toEqual([expect.objectContaining({ code: 'skill_family_in_skill_column', column: 'skill_id' })]);
  });

  it('a malformed skill code is blocking', () => {
    expect(codes(run(goodDrillPackage({ skill_id: 'sk-guard-2' })))).toEqual(['bad_id']);
  });

  it('a well-formed SK code skillFamilies.ts does not list is a WARNING naming the edit, not a block', () => {
    const result = run(goodDrillPackage({ skill_id: 'SK-GARD-02' }));
    expect(result.blocking).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unmapped_skill_code', message: expect.stringContaining('UNMAPPED_SKILL_CODES') })]),
    );
  });

  it('the registry claim pattern takes every track shape the registry uses and nothing looser', () => {
    for (const id of ['A1-001', 'B6-012', 'PS-001', 'CB-008']) expect(REGISTRY_CLAIM_ID_PATTERN.test(id)).toBe(true);
    for (const id of ['A1-01', 'a1-001', 'A1-0001', 'SKILL-01', 'A5-T01']) expect(REGISTRY_CLAIM_ID_PATTERN.test(id)).toBe(false);
  });

  it('a new drill whose minted id is already a committed drill is blocking: revise it by its id instead', () => {
    const baseline = parsePackage([input('seed_drill_library.csv', [drill({ drill_id: EXISTING_DRILL, name: 'Touch to Reposition' })])]).parsed;
    const result = run(goodDrillPackage({ name: 'Touch to Reposition' }), baseline);
    expect(codes(result)).toEqual(expect.arrayContaining(['minted_id_exists', 'duplicate_value']));
  });

  it('lineage_id written as the same new:<name> as drill_id is accepted', () => {
    // The contract allows lineage_id "blank or the same as drill_id"; prepare
    // must then resolve it too (contentImportPrepare.test.ts).
    expect(run(goodDrillPackage({ lineage_id: 'new:mirror-jab' })).blocking).toEqual([]);
  });
});

describe('the minting formulas reproduce real committed ids', () => {
  // Fixed (inputs, id) pairs copied from the committed CSVs. When ids.ts was
  // written every committed row matched its formula (119 drills, 12 templates,
  // 6 cohorts, 82 items, 65 blocks, 4 renderings); these pin the formulas
  // themselves, so an edit to one fails here. They are not re-derived from
  // the live files: a renamed item keeps its id, so its current name no
  // longer mints it, and that is the contract working (review S1).
  it.each([
    ['boxing', 'Touch to Reposition', 'drl_7f812fecacfee4'],
    ['conditioning', 'Guard Through Fatigue', 'drl_d418eb017730d7'],
    ['conditioning', 'Footwork Under Accumulated Fatigue', 'drl_47e30881c7b416'],
  ])('drl_: %s / %s -> %s', (discipline, name, id) => {
    expect(MINT.drill(discipline, name)).toBe(id);
  });

  it('wtp_, coh_, wti_, blk_ and rnd_', () => {
    expect(MINT.template('Beginner Footwork')).toBe('wtp_98af8ee68020d0');
    expect(MINT.template('Intro to Boxing — Session 1')).toBe('wtp_216dfa4227233d');
    expect(MINT.cohort('Open Floor')).toBe('coh_bac0c06f582b46');
    expect(MINT.cohort('Working Group')).toBe('coh_ee6dbaa7f0edbd');
    expect(MINT.templateItem('wtp_216dfa4227233d', '1')).toBe('wti_78e9602c406a6f');
    expect(MINT.templateItem('wtp_98af8ee68020d0', '2')).toBe('wti_25c92d8e809246');
    expect(MINT.block('scr_0d0c3b6389e8d1', '1')).toBe('blk_989cbc8e4523e0');
    expect(MINT.block('scr_0d0c3b6389e8d1', '42')).toBe('blk_00c9e915ac9318');
    expect(MINT.rendering('scr_e2ed38b1a19670', 'cheat_sheet')).toBe('rnd_9c378b9c06cd21');
    expect(MINT.rendering('scr_e2ed38b1a19670', 'class_plan')).toBe('rnd_d4cc60f799b849');
  });
});

describe('a blank transfer_id is the whole key, so it is resolved before it is compared', () => {
  const claim = (overrides: Record<string, string> = {}) => ({
    transfer_id: '',
    drill_id: EXISTING_DRILL,
    claim_kind: 'life_skill_transfer',
    statement: 'Reset after mistakes and continue.',
    evidence_class: 'COACHING INTENT',
    ...overrides,
  });
  const claims = (rows: Record<string, string>[]) => input('seed_transfer_claims.csv', rows, 'transfer-claims');

  it('two blank rows describing the same claim are a duplicate, not a silent overwrite', () => {
    // Before: no finding, and prepare kept only the second row.
    const result = run([claims([claim(), claim({ evidence_class: 'EVIDENCE-SUPPORTED', registry_claim_id: 'A1-001' })])]);
    expect(result.blocking).toEqual([expect.objectContaining({ code: 'duplicate_key', column: 'transfer_id', line: 3 })]);
  });

  it('a blank row with the same target, claim_kind and statement as a committed claim takes its id', () => {
    const legacyId = 'txf_0000000000abcd'; // committed ids are not reproducible by any formula (ids.ts)
    const baseline = parsePackage([claims([claim({ transfer_id: legacyId })])]).parsed;
    const result = run([claims([claim({ evidence_class: 'EVIDENCE-SUPPORTED', registry_claim_id: 'A1-001' })])], baseline);
    expect(result.blocking).toEqual([]);
    expect([...result.blankKeyIds.values()]).toEqual([legacyId]);
  });

  it('a blank row whose minted id is a committed claim that has since been reworded is refused', () => {
    const minted = MINT.transfer(EXISTING_DRILL, 'life_skill_transfer', 'Reset after mistakes and continue.');
    const baseline = parsePackage([claims([claim({ transfer_id: minted, statement: 'Reset, then continue.' })])]).parsed;
    expect(codes(run([claims([claim()])], baseline))).toEqual(['minted_id_exists']);
  });
});

describe('references', () => {
  it('a transfer claim whose drill is in neither the package nor the reference set is an orphan', () => {
    const claim = (drillId: string) => ({
      transfer_id: '',
      drill_id: drillId,
      claim_kind: 'life_skill_transfer',
      statement: 'Reset after mistakes and continue.',
      evidence_class: 'COACHING INTENT',
    });
    const orphan = run([input('seed_transfer_claims.csv', [claim('drl_0871d69fccd12f')], 'transfer-claims')]);
    expect(orphan.blocking).toEqual([expect.objectContaining({ code: 'orphan_reference', column: 'drill_id' })]);

    const known = run([input('seed_transfer_claims.csv', [claim(EXISTING_DRILL)], 'transfer-claims')]);
    expect(known.blocking).toEqual([]);
  });

  it('a new:<name> reference resolves to an item of the same package, and to nothing else', () => {
    const item = (drillId: string) => ({ template_id: EXISTING_TEMPLATE, ordinal: '1', block: 'technical', drill_id: drillId });
    const resolved = run([...goodDrillPackage(), input('seed_workout_template_items.csv', [item('new:mirror-jab')], 'workout-templates')]);
    expect(resolved.blocking).toEqual([]);

    const ghost = run([...goodDrillPackage(), input('seed_workout_template_items.csv', [item('new:ghost-drill')], 'workout-templates')]);
    expect(ghost.blocking).toEqual([expect.objectContaining({ code: 'orphan_reference', message: expect.stringContaining('new:ghost-drill') })]);
  });

  it('an inline claim tag in prose must name a loaded claim', () => {
    const result = run(goodDrillPackage({ corrections: 'Shorten the step [A2-002], then [ZZ-123].' }));
    expect(result.blocking).toEqual([expect.objectContaining({ code: 'orphan_reference', message: expect.stringContaining('[ZZ-123]') })]);
  });
});

describe('organization, placeholders, media and tool-decided columns', () => {
  it('a literal organization_id is refused', () => {
    expect(codes(run(goodDrillPackage({ organization_id: 'punxsy_prominence' })))).toEqual(['literal_organization']);
  });

  it('a literal created_by_account_id is refused', () => {
    expect(codes(run(goodDrillPackage({ created_by_account_id: 'ppbf@punxsyprominence.org' })))).toEqual(['literal_account']);
  });

  it('any other {{ text is refused, including the right placeholder in the wrong column', () => {
    expect(codes(run(goodDrillPackage({ purpose: 'Build a {{JAB}}.' })))).toEqual(['stray_placeholder']);
    expect(codes(run(goodDrillPackage({ organization_id: '{{SEED_ACCOUNT_ID}}' })))).toEqual(['stray_placeholder']);
  });

  it('video, photos and archives are refused by name, whatever they contain', () => {
    const result = run([
      ...goodDrillPackage(),
      { path: 'drill-library/mirror-jab.MP4', text: '' },
      { path: 'stills/guard.jpg', text: '' },
      { path: 'everything.zip', text: '' },
    ]);
    expect(codes(result).sort()).toEqual(['archive_file', 'media_file', 'media_file']);
  });

  it.each([
    ['version', '2'],
    ['active', 'false'],
    ['superseded_at', '2026-09-29'],
    ['lineage_id', 'drl_0000000000abcd'],
  ])('%s set to %s is refused: the tool decides it', (column, value) => {
    expect(run(goodDrillPackage({ [column]: value })).blocking).toEqual([
      expect.objectContaining({ code: 'system_column_set', column }),
    ]);
  });

  it("today's defaults (version 1, active True, lineage = the id) are accepted", () => {
    const result = run(goodDrillPackage({ drill_id: EXISTING_DRILL, name: 'Touch to Reposition', version: '1', active: 'True', lineage_id: EXISTING_DRILL }));
    expect(result.blocking).toEqual([]);
  });

  it('a created_at column carried over from an export must be blank', () => {
    const header = [...spec('seed_drill_library.csv').columns.map((c) => c.name), 'created_at'];
    const text = csvFor('seed_drill_library.csv', [{ ...drill(), created_at: '2026-09-29T10:00:00Z' }], header);
    expect(codes(run([{ path: 'seed_drill_library.csv', text }]))).toEqual(['system_column_set']);
  });
});

describe('file shape', () => {
  it('a missing required value, a missing required column and an unknown column are each blocking', () => {
    expect(codes(run(goodDrillPackage({ purpose: '' })))).toEqual(['missing_required']);

    const noPurpose = spec('seed_drill_library.csv').columns.map((c) => c.name).filter((name) => name !== 'purpose');
    expect(codes(run([{ path: 'seed_drill_library.csv', text: csvFor('seed_drill_library.csv', [drill()], noPurpose) }]))).toEqual([
      'missing_column',
      'missing_required',
    ]);

    const extra = [...spec('seed_drill_library.csv').columns.map((c) => c.name), 'coach_mood'];
    expect(codes(run([{ path: 'seed_drill_library.csv', text: csvFor('seed_drill_library.csv', [drill()], extra) }]))).toEqual(['unknown_column']);
  });

  it('a row with one cell too many is blocking with its line, instead of shifting every later value', () => {
    // The old loaders pad or drop cells by position (row[i] ?? ''), so a stray
    // comma moves every later field one column over without a word.
    const text = `${csvFor('seed_drill_scale_levels.csv', [scale('new:mirror-jab', 'B', true)])}${'x,'.repeat(10)}x\n`;
    const result = run([input('seed_drill_library.csv', [drill()]), { path: 'seed_drill_scale_levels.csv', text }]);
    expect(result.blocking).toEqual([expect.objectContaining({ code: 'column_count', line: 3 })]);
  });

  it('a file the CSV reader cannot read is one blocking finding, not a crash', () => {
    const result = run([{ path: 'seed_drill_cues.csv', text: 'drill_id,cue_text\ndrl_7f812fecacfee4,"Touch and go\n' }]);
    expect(codes(result)).toEqual(['csv_unreadable']);
  });

  it('a CSV the contract does not know is blocking; any other file is reported and ignored', () => {
    const result = run([...goodDrillPackage(), { path: 'drill-library/seed_drills.csv', text: 'a,b\n1,2\n' }, { path: 'notes/README.md', text: '' }]);
    expect(codes(result)).toEqual(['unknown_file']);
    expect(warningCodes(result)).toContain('ignored_file');
  });

  it('reads a BOM and CRLF line endings, as a spreadsheet export writes them', () => {
    const [library, ...rest] = goodDrillPackage();
    const crlf = `﻿${library.text.replace(/\n/g, '\r\n')}`;
    expect(run([{ ...library, text: crlf }, ...rest]).blocking).toEqual([]);
  });
});

describe('row and group rules', () => {
  it('scale levels: two starting points are blocking', () => {
    const inputs = goodDrillPackage();
    inputs[1] = input('seed_drill_scale_levels.csv', [scale('new:mirror-jab', 'A', true), scale('new:mirror-jab', 'B', true), scale('new:mirror-jab', 'C', false)]);
    expect(codes(run(inputs))).toEqual(['scale_rule']);
  });

  it('scale levels: starting anywhere but B is blocking', () => {
    const inputs = goodDrillPackage();
    inputs[1] = input('seed_drill_scale_levels.csv', [scale('new:mirror-jab', 'A', true), scale('new:mirror-jab', 'B', false), scale('new:mirror-jab', 'C', false)]);
    expect(run(inputs).blocking).toEqual([expect.objectContaining({ code: 'scale_rule', message: expect.stringContaining('starts at A') })]);
  });

  it('transfer claims: one target, a registry claim behind EVIDENCE-SUPPORTED, no unsupported public neuroscience', () => {
    const base = { drill_id: EXISTING_DRILL, claim_kind: 'neuro_mechanism', statement: 'Timing.' };
    const result = run(
      [
        input(
          'seed_transfer_claims.csv',
          [
            { ...base, script_id: 'scr_0d0c3b6389e8d1' },
            { ...base, statement: 'Supported.', evidence_class: 'EVIDENCE-SUPPORTED' },
            { ...base, statement: 'Public.', named_structure: 'cerebellum', public_facing: 'true' },
          ],
          'transfer-claims',
        ),
      ],
    );
    expect(result.blocking.filter((f) => f.code === 'row_rule').map((f) => f.line)).toEqual([2, 3, 4]);
  });

  it('template items: exactly one of drill_id and free_text_drill; no volume on sparring', () => {
    const item = (overrides: Record<string, string>) => ({ template_id: EXISTING_TEMPLATE, block: 'technical', ...overrides });
    const result = run([
      input(
        'seed_workout_template_items.csv',
        [
          item({ ordinal: '1', drill_id: EXISTING_DRILL, free_text_drill: 'Shadow box' }),
          item({ ordinal: '2', drill_id: EXISTING_DRILL, contact_level: 'controlled_sparring', duration_minutes: '6' }),
        ],
        'workout-templates',
      ),
    ]);
    expect(result.blocking.map((f) => [f.code, f.line])).toEqual([
      ['row_rule', 2],
      ['row_rule', 3],
    ]);
  });

  it('secondary skills: never the primary again, and an expected primary must match', () => {
    const rows: Record<string, string>[] = [
      { drill_id: EXISTING_DRILL, skill_id: 'SK-FW-04' },
      { drill_id: EXISTING_DRILL, skill_id: 'SK-GUARD-02', expected_primary_skill_id: 'SK-STANCE-01' },
    ];
    const result = run([input('seed_drill_secondary_skills.csv', rows)]);
    expect(result.blocking.map((f) => f.message)).toEqual([
      expect.stringContaining('already the primary skill'),
      expect.stringContaining('expected primary SK-STANCE-01'),
    ]);
  });

  it('a drill name already used in the same discipline is blocking', () => {
    const baseline = parsePackage([input('seed_drill_library.csv', [drill({ drill_id: EXISTING_DRILL, name: 'Touch to Reposition' })])]).parsed;
    const renamedOnto = run(goodDrillPackage({ drill_id: 'drl_00000000000abc', name: 'Touch to Reposition' }), baseline);
    expect(codes(renamedOnto)).toEqual(['duplicate_value']);
  });
});

describe('warnings never block', () => {
  it('text repeated in 5+ rows, a constant column and a near-duplicate name are reported', () => {
    const boilerplate = 'Is the athlete repeating the target behaviour without the coach adding words.';
    const drills = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((name) =>
      drill({ drill_id: `new:${name.toLowerCase()}`, name: `${name} Slip`, corrections: boilerplate }),
    );
    const baseline = parsePackage([input('seed_drill_library.csv', [drill({ drill_id: EXISTING_DRILL, name: 'Touch to Reposition' })])]).parsed;
    const result = run(
      [input('seed_drill_library.csv', [...drills, drill({ drill_id: 'new:touch', name: 'Touch to Reposition (v2)' })])],
      baseline,
    );

    expect(result.blocking).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'repeated_text', column: 'corrections', count: 5 }),
        expect.objectContaining({ code: 'constant_column', column: 'category' }),
        expect.objectContaining({ code: 'near_duplicate_name', message: expect.stringContaining(`is this a revision of ${EXISTING_DRILL}`) }),
      ]),
    );
  });

  it('a new drill that would load but could not be adopted says what it is missing', () => {
    const result = run([input('seed_drill_library.csv', [drill({ what_good_looks_like: '' })])]);
    expect(result.blocking).toEqual([]);
    const warning = result.warnings.find((w) => w.code === 'adoption_readiness');
    expect(warning?.message).toEqual(expect.stringContaining('does not say what good execution looks like'));
    expect(warning?.message).toEqual(expect.stringContaining('scaling is incomplete'));
    expect(warning?.message).toEqual(expect.stringContaining('no stop rules'));
  });

  it("a legacy scope=universal stop rule is reported as the drill's own rule (R3)", () => {
    const inputs = goodDrillPackage();
    inputs[2] = input('seed_drill_stop_rules.csv', [stop('new:mirror-jab', '1', { scope: 'universal' })]);
    const result = run(inputs);
    expect(result.blocking).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'legacy_universal_stop_rule', message: expect.stringContaining('(R3)') })]),
    );
  });
});
