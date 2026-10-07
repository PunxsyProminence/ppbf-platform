// Adoption readiness (OD-2026-09-19-001 PROMOTION QUALITY, W-D4C), tested away
// from the route and the page that both run it.
//
// The promote route refuses a NOT_READY_TO_ADOPT drill with this function's
// `missing` list, and the coach page shows the same list before anyone presses
// Promote -- so the sentences are the only explanation a coach ever gets, and
// their wording and order are pinned here, not just the boolean.
//
// Two rules are pinned as ABSENT on purpose. "At least one cue" and "the
// provenance has been validated" are owner decisions the ruling left open (34
// of 119 seeded drills have no cues; 114 carry REQUIRES FLOOR VALIDATION and
// nothing records a validation). If either became a rule by accident, nearly
// the whole library would silently stop being adoptable.
//
// The fixture is the full DrillWithDetail both callers actually pass, not the
// narrow input interface, so the extra columns (cues, field_provenance,
// content_class) are present exactly as they are in production.

import { adoptionReadiness } from './drillAdoptionReadiness';
import type { DrillWithDetail } from '../server/pilot/drillLibraryV3';

const WITHDRAWN = 'The reference drill has been withdrawn.';
const SUPERSEDED = 'A newer version of this reference drill exists.';
const NO_NAME = 'It has no name.';
const NO_PURPOSE = 'It does not say what it is for.';
const NO_CATEGORY = 'It has no category.';
const NO_DIFFICULTY = 'It has no difficulty.';
const NO_SETUP = 'It has no setup.';
const NO_EXECUTION = 'It does not say how it runs.';
const NO_GOOD = 'It does not say what good execution looks like.';
const SCALING =
  'Its scaling is incomplete: it needs easier, standard and harder levels, with one marked as the starting point.';
const NO_STOP_RULES = 'It has no stop rules.';

const ORG = 'org_test';
const DRILL = 'drl_ready';

// The two REQUIRES FLOOR VALIDATION values the migration's
// pilot_drill_library_field_provenance_check allows, verbatim.
const LITERATURE_DRAFT =
  'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION';
const CRAFT_DRAFT =
  'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION';

function scaleLevel(scale_level: 'A' | 'B' | 'C', is_starting_point: boolean) {
  return {
    organization_id: ORG,
    scale_id: `scl_${scale_level}`,
    drill_id: DRILL,
    scale_level,
    is_starting_point,
    demand_description: `Level ${scale_level} demand`,
    constraint_applied: `Level ${scale_level} constraint`,
    contact_level: 'none',
    coach_watch_point: `Level ${scale_level} watch point`,
    authoring_state: 'draft',
  };
}

function stopRule(ordinal: number, scope: 'universal' | 'drill_specific' = 'drill_specific') {
  return {
    organization_id: ORG,
    stop_rule_id: `stp_${ordinal}`,
    drill_id: DRILL,
    ordinal,
    condition_text: `Stop condition ${ordinal}`,
    scope,
    rule_kind: 'safety',
    origin: 'drill' as const,
  };
}

/** One of the gym's stored-once rules (pilot.universal_stop_rules), as getDrillWithDetail returns it. */
function universalRule(ordinal: number) {
  return {
    organization_id: ORG,
    universal_rule_id: `ust_${ordinal}`,
    lineage_id: `ust_${ordinal}`,
    version: 1,
    ordinal,
    condition_text: `Stop on any sign of injury ${ordinal}`,
    rule_kind: 'safety',
    applies_to_contact_levels: null,
    origin: 'universal' as const,
  };
}

/** A drill that meets every rule. Each test breaks exactly what it names. */
type ReadinessFixture = DrillWithDetail & { floor_tested_by_this_gym: boolean };

function readyDrill(overrides: Partial<ReadinessFixture> = {}): ReadinessFixture {
  return {
    organization_id: ORG,
    drill_id: DRILL,
    lineage_id: DRILL,
    version: 1,
    supersedes_drill_id: null,
    superseded_at: null,
    name: 'Touch to Reposition',
    discipline: 'boxing',
    category: 'technical',
    difficulty: 'beginner',
    skill_id: 'SK-FW-04',
    target_behavior: 'Leave the exchange after scoring.',
    purpose: 'Train clean entry, visible scoring, and immediate departure.',
    standard_setup: 'Open floor space, one feeder.',
    execution: 'Enter, touch the target, reposition out of range.',
    what_good_looks_like: 'Balanced entry and an immediate exit.',
    what_bad_looks_like: 'Staying in the exchange.',
    common_errors: 'Admiring the shot.',
    corrections: 'Exit on the count.',
    transfer: 'Sparring exits.',
    contact_level: 'light',
    equipment_needed: 'Gloves',
    requires_coach_authorization: false,
    content_class: 'COACHING CRAFT - informed by evidence, not individually validated',
    source_ref: null,
    grounding_claim_ids: [],
    field_provenance: 'PPBF source manual v3',
    active: true,
    created_by_account_id: null,
    created_by_role: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    scale_levels: [scaleLevel('A', false), scaleLevel('B', true), scaleLevel('C', false)],
    stop_rules: [stopRule(1)],
    universal_stop_rules: [],
    cues: [
      {
        organization_id: ORG,
        cue_id: 'cue_1',
        drill_id: DRILL,
        cue_text: 'Hit and go.',
        cue_family: 'exit',
        focus_type: 'external',
        evidence_note: '',
        source_ref: null,
      },
    ],
    secondary_skills: [],
    // Not a draft (source manual), so no floor test is needed; the draft cases
    // below set both.
    floor_tested_by_this_gym: false,
    ...overrides,
  };
}

describe('adoptionReadiness: a drill that meets every rule', () => {
  test('is ready with nothing missing', () => {
    expect(adoptionReadiness(readyDrill())).toEqual({ ready: true, missing: [] });
  });

  test('does not care which order the scale levels arrive in', () => {
    const drill = readyDrill({
      scale_levels: [scaleLevel('C', false), scaleLevel('A', true), scaleLevel('B', false)],
    });
    expect(adoptionReadiness(drill)).toEqual({ ready: true, missing: [] });
  });
});

describe('adoptionReadiness: each text field, blank on its own, produces exactly its sentence', () => {
  const TEXT_FIELDS: [keyof DrillWithDetail, string][] = [
    ['name', NO_NAME],
    ['purpose', NO_PURPOSE],
    ['category', NO_CATEGORY],
    ['difficulty', NO_DIFFICULTY],
    ['standard_setup', NO_SETUP],
    ['execution', NO_EXECUTION],
    ['what_good_looks_like', NO_GOOD],
  ];

  test.each(TEXT_FIELDS)('%s empty', (field, sentence) => {
    expect(adoptionReadiness(readyDrill({ [field]: '' }))).toEqual({ ready: false, missing: [sentence] });
  });

  // A field of spaces, tabs and newlines renders as nothing on the page; it is
  // as absent as an empty one.
  test.each(TEXT_FIELDS)('%s whitespace-only counts as blank', (field, sentence) => {
    expect(adoptionReadiness(readyDrill({ [field]: ' \t\n  ' }))).toEqual({
      ready: false,
      missing: [sentence],
    });
  });

  test('text with surrounding whitespace is still present', () => {
    expect(adoptionReadiness(readyDrill({ name: '  Touch to Reposition  ' }))).toEqual({
      ready: true,
      missing: [],
    });
  });
});

describe('adoptionReadiness: governance', () => {
  test('a withdrawn reference is not ready, and says so', () => {
    expect(adoptionReadiness(readyDrill({ active: false }))).toEqual({ ready: false, missing: [WITHDRAWN] });
  });

  test('a superseded reference is not ready, and says so', () => {
    expect(adoptionReadiness(readyDrill({ superseded_at: '2026-09-18T12:00:00.000Z' }))).toEqual({
      ready: false,
      missing: [SUPERSEDED],
    });
  });

  test('withdrawn and superseded are two separate sentences, withdrawn first', () => {
    expect(
      adoptionReadiness(readyDrill({ active: false, superseded_at: '2026-09-18T12:00:00.000Z' })).missing,
    ).toEqual([WITHDRAWN, SUPERSEDED]);
  });
});

describe('adoptionReadiness: scaling needs A, B and C with exactly one starting point', () => {
  const INCOMPLETE: [string, DrillWithDetail['scale_levels']][] = [
    ['no scale levels at all', []],
    ['A missing', [scaleLevel('B', true), scaleLevel('C', false)]],
    ['B missing', [scaleLevel('A', true), scaleLevel('C', false)]],
    ['C missing', [scaleLevel('A', false), scaleLevel('B', true)]],
    // Three rows is not the same as three levels.
    ['a level repeated in place of another', [scaleLevel('A', false), scaleLevel('A', false), scaleLevel('B', true)]],
    ['zero starting points', [scaleLevel('A', false), scaleLevel('B', false), scaleLevel('C', false)]],
    ['two starting points', [scaleLevel('A', true), scaleLevel('B', true), scaleLevel('C', false)]],
    ['three starting points', [scaleLevel('A', true), scaleLevel('B', true), scaleLevel('C', true)]],
  ];

  test.each(INCOMPLETE)('%s', (_label, scale_levels) => {
    expect(adoptionReadiness(readyDrill({ scale_levels }))).toEqual({ ready: false, missing: [SCALING] });
  });

  test('a level missing AND a wrong starting-point count is still one sentence, not two', () => {
    const drill = readyDrill({ scale_levels: [scaleLevel('A', false), scaleLevel('B', false)] });
    expect(adoptionReadiness(drill).missing).toEqual([SCALING]);
  });
});

describe('adoptionReadiness: safety', () => {
  test('no stop rules is not ready, and says so', () => {
    expect(adoptionReadiness(readyDrill({ stop_rules: [] }))).toEqual({ ready: false, missing: [NO_STOP_RULES] });
  });

  // The rule is "at least one condition to stop on". Whether a drill needs a
  // drill-specific rule is part of the context-aware gate no column can decide
  // yet (a VERIFIED_MODEL_GAP), so a universal rule counts.
  //
  // "Universal" here is the LEGACY scope label on one of the drill's OWN rows.
  // Under owner ruling R3 those rows are the drill's own rules, and they are
  // what keeps today's 119 seeded drills adoptable (658 of their 674 rows carry
  // that label), so this must keep passing.
  test('one universal stop rule is enough', () => {
    expect(adoptionReadiness(readyDrill({ stop_rules: [stopRule(1, 'universal')] }))).toEqual({
      ready: true,
      missing: [],
    });
  });

  // The gym's stored-once rules apply to every drill, so if they counted,
  // loading one injury rule would make every drill "have stop rules" and this
  // requirement would stop checking anything (R3; the flagged default: a drill
  // needs at least one rule of its own).
  test('stored-once rules alone do not make a drill ready', () => {
    const drill = readyDrill({ stop_rules: [], universal_stop_rules: [universalRule(1), universalRule(2)] });
    expect(adoptionReadiness(drill)).toEqual({ ready: false, missing: [NO_STOP_RULES] });
  });

  test("stored-once rules beside one of the drill's own rules change nothing", () => {
    const drill = readyDrill({ stop_rules: [stopRule(1, 'universal')], universal_stop_rules: [universalRule(1)] });
    expect(adoptionReadiness(drill)).toEqual({ ready: true, missing: [] });
  });
});

describe('adoptionReadiness: the missing list has a fixed order', () => {
  const EVERYTHING_IN_ORDER = [
    WITHDRAWN,
    SUPERSEDED,
    NO_NAME,
    NO_PURPOSE,
    NO_CATEGORY,
    NO_DIFFICULTY,
    NO_SETUP,
    NO_EXECUTION,
    NO_GOOD,
    SCALING,
    NO_STOP_RULES,
  ];

  test('a drill missing everything lists every sentence once, governance first and safety last', () => {
    const drill = readyDrill({
      active: false,
      superseded_at: '2026-09-18T12:00:00.000Z',
      name: '',
      purpose: '',
      category: '',
      difficulty: '',
      standard_setup: '',
      execution: '',
      what_good_looks_like: '',
      scale_levels: [],
      stop_rules: [],
    });
    expect(adoptionReadiness(drill)).toEqual({ ready: false, missing: EVERYTHING_IN_ORDER });
  });

  test('the order follows the rules, not the order the fields were written into the object', () => {
    // Same failures, object keys written in reverse.
    const drill = {
      ...readyDrill(),
      stop_rules: [],
      scale_levels: [],
      what_good_looks_like: '',
      execution: '',
      standard_setup: '',
      difficulty: '',
      category: '',
      purpose: '',
      name: '',
      superseded_at: '2026-09-18T12:00:00.000Z',
      active: false,
    };
    expect(adoptionReadiness(drill).missing).toEqual(EVERYTHING_IN_ORDER);
  });

  test('any two failures keep their relative order', () => {
    expect(adoptionReadiness(readyDrill({ stop_rules: [], name: '' })).missing).toEqual([NO_NAME, NO_STOP_RULES]);
    expect(
      adoptionReadiness(readyDrill({ what_good_looks_like: '', scale_levels: [], superseded_at: '2026-09-18T12:00:00.000Z' }))
        .missing,
    ).toEqual([SUPERSEDED, NO_GOOD, SCALING]);
  });
});

const NO_CUE = 'It has no coaching cue. A technique drill needs at least one; a conditioning drill does not.';

// OD-2026-10-06-026 ruling 2: "Required except conditioning".
describe('adoptionReadiness: the cue rule', () => {
  test('a technique drill with no cues is NOT ready, and the line names the cue', () => {
    expect(adoptionReadiness(readyDrill({ cues: [] }))).toEqual({ ready: false, missing: [NO_CUE] });
  });

  test('a conditioning drill with no cues is ready (the exemption)', () => {
    expect(adoptionReadiness(readyDrill({ discipline: 'conditioning', category: 'strength', cues: [] })))
      .toEqual({ ready: true, missing: [] });
  });

  test('the exemption reads the discipline, not the category word', () => {
    // 'conditioning' as a boxing drill's category does not exempt it; the
    // ruling counted conditioning drills by discipline (25), not category (8).
    expect(adoptionReadiness(readyDrill({ discipline: 'boxing', category: 'conditioning', cues: [] })).ready).toBe(false);
    expect(adoptionReadiness(readyDrill({ discipline: 'Conditioning ', category: 'warmup', cues: [] })).ready).toBe(true);
  });

  test('a blank cue does not count', () => {
    const blank = { ...readyDrill().cues[0], cue_text: '  ' };
    expect(adoptionReadiness(readyDrill({ cues: [blank] })).missing).toEqual([NO_CUE]);
  });

  test('the cue line comes last, after the stop-rule line', () => {
    expect(adoptionReadiness(readyDrill({ cues: [], stop_rules: [] })).missing).toEqual([NO_STOP_RULES, NO_CUE]);
  });
});

const NOT_FLOOR_TESTED =
  'It is a draft that requires floor validation, and no coach of this gym has marked it floor-tested.';

// OD-2026-10-06-026 ruling 3: "They stay drafts until a coach marks them floor-tested."
describe('adoptionReadiness: the floor-test rule', () => {
  test.each([LITERATURE_DRAFT, CRAFT_DRAFT])(
    'a draft this gym has not floor-tested is NOT ready, and the line says so (%s)',
    (field_provenance) => {
      expect(adoptionReadiness(readyDrill({ field_provenance, floor_tested_by_this_gym: false })))
        .toEqual({ ready: false, missing: [NOT_FLOOR_TESTED] });
    },
  );

  test.each([LITERATURE_DRAFT, CRAFT_DRAFT])(
    'a draft a coach of this gym marked floor-tested is ready (%s)',
    (field_provenance) => {
      expect(adoptionReadiness(readyDrill({ field_provenance, floor_tested_by_this_gym: true })))
        .toEqual({ ready: true, missing: [] });
    },
  );

  test.each(['PPBF source manual v3', 'PPBF owner-authored'])(
    'a drill that is not a draft needs no floor test (%s)',
    (field_provenance) => {
      expect(adoptionReadiness(readyDrill({ field_provenance, floor_tested_by_this_gym: false })))
        .toEqual({ ready: true, missing: [] });
    },
  );

  test('the mark is read exactly: a paraphrase of the draft label is not a draft', () => {
    expect(adoptionReadiness(readyDrill({ field_provenance: 'literature-grounded draft; requires floor validation' })).ready).toBe(true);
  });

  test('the floor-test line comes last, after the cue line', () => {
    const drill = readyDrill({ field_provenance: CRAFT_DRAFT, cues: [], stop_rules: [] });
    expect(adoptionReadiness(drill).missing).toEqual([NO_STOP_RULES, NO_CUE, NOT_FLOOR_TESTED]);
  });
});
