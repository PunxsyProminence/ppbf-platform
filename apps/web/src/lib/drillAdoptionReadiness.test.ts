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
  };
}

/** A drill that meets every rule. Each test breaks exactly what it names. */
function readyDrill(overrides: Partial<DrillWithDetail> = {}): DrillWithDetail {
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
  test('one universal stop rule is enough', () => {
    expect(adoptionReadiness(readyDrill({ stop_rules: [stopRule(1, 'universal')] }))).toEqual({
      ready: true,
      missing: [],
    });
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

describe('adoptionReadiness: cues and provenance are NOT rules', () => {
  test('a drill with no cues is ready', () => {
    expect(adoptionReadiness(readyDrill({ cues: [] }))).toEqual({ ready: true, missing: [] });
  });

  test.each([LITERATURE_DRAFT, CRAFT_DRAFT])(
    'a drill whose provenance REQUIRES FLOOR VALIDATION is ready (%s)',
    (field_provenance) => {
      expect(adoptionReadiness(readyDrill({ field_provenance }))).toEqual({ ready: true, missing: [] });
    },
  );

  test('a drill with no cues AND an unvalidated provenance is ready', () => {
    const drill = readyDrill({
      cues: [],
      field_provenance: CRAFT_DRAFT,
      grounding_claim_ids: [],
      source_ref: null,
    });
    expect(adoptionReadiness(drill)).toEqual({ ready: true, missing: [] });
  });
});
