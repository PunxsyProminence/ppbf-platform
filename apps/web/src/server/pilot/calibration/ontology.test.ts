// Guards on the controlled vocabulary itself.
//
// A vocabulary is only a measurement instrument while it stays closed and
// stays the same in every place it is enforced. These tests hold three lines:
//
//   1. the TypeScript arrays and the database CHECK constraints agree, so a
//      label cannot be valid in one and rejected by the other
//   2. the concepts the owner's order forbids stay out
//   3. validation rejects rather than coerces
//
// This file is deliberately paranoid about (2). Every forbidden concept is a
// judgement requiring a definition nobody has ratified, and the realistic way
// one arrives is not a deliberate decision -- it is somebody needing a field
// to make a screen work.

import fs from 'node:fs';
import path from 'node:path';

import {
  ANNOTATABLE_ONTOLOGY_VERSIONS,
  ANNOTATION_CERTAINTIES,
  ANNOTATION_SET_STATUSES,
  BODY_POINT_ONTOLOGY_VERSIONS,
  BODY_POINT_PLACEMENT_NOTES,
  BODY_POINT_STATES,
  BODY_POINTS,
  BODY_SUBJECTS,
  BOXING_ONTOLOGY_VERSION_0_1,
  BOXING_ONTOLOGY_VERSION_0_2,
  CALIBRATION_PROJECT_STATUSES,
  CLIP_SAMPLING_REASONS,
  CONTACT_RESULTS,
  CONTACT_ZONES,
  DEFENSE_TYPES,
  EVENT_CLASSES,
  GUARD_TYPE_SOURCES,
  GUARD_TYPES,
  HAND_ROLES,
  LEAD_SIDES,
  MOMENT_KINDS,
  MOMENT_SLOTS,
  PHYSICAL_HANDS,
  PROJECT_CREATION_ONTOLOGY_VERSION,
  PUNCH_TYPES,
  SANCTIONING_BODIES,
  SOURCE_MANUALS,
  STANCE_TYPE_SOURCES,
  STANCE_TYPES,
  STANCES,
  SUPPORTED_BOXING_ONTOLOGY_VERSIONS,
  TARGET_ZONES,
  VISIBILITIES,
  isInVocabulary,
  vocabularyCheckSql,
} from './ontology';

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../../../../infra/azure/pilot_slice_postgres_calibration_projects_migration.sql',
);

const ALL_VOCABULARIES: Array<[string, readonly string[]]> = [
  ['EVENT_CLASSES', EVENT_CLASSES],
  ['PUNCH_TYPES', PUNCH_TYPES],
  ['PHYSICAL_HANDS', PHYSICAL_HANDS],
  ['HAND_ROLES', HAND_ROLES],
  ['STANCES', STANCES],
  ['TARGET_ZONES', TARGET_ZONES],
  ['CONTACT_RESULTS', CONTACT_RESULTS],
  ['CONTACT_ZONES', CONTACT_ZONES],
  ['DEFENSE_TYPES', DEFENSE_TYPES],
  ['VISIBILITIES', VISIBILITIES],
  ['ANNOTATION_CERTAINTIES', ANNOTATION_CERTAINTIES],
  ['CALIBRATION_PROJECT_STATUSES', CALIBRATION_PROJECT_STATUSES],
  ['CLIP_SAMPLING_REASONS', CLIP_SAMPLING_REASONS],
  ['BODY_POINTS', BODY_POINTS],
  ['BODY_POINT_STATES', BODY_POINT_STATES],
  ['MOMENT_SLOTS', MOMENT_SLOTS],
  ['MOMENT_KINDS', MOMENT_KINDS],
  ['BODY_SUBJECTS', BODY_SUBJECTS],
  ['LEAD_SIDES', LEAD_SIDES],
  ['SANCTIONING_BODIES', SANCTIONING_BODIES],
  ['GUARD_TYPES', GUARD_TYPES],
  ['STANCE_TYPES', STANCE_TYPES],
];

describe('boxing-ontology-0.1 is closed and well formed', () => {
  test('the version strings are exact', () => {
    // Stamped onto every row. A drift here silently re-labels collected data.
    expect(BOXING_ONTOLOGY_VERSION_0_1).toBe('boxing-ontology-0.1');
    expect(BOXING_ONTOLOGY_VERSION_0_2).toBe('boxing-ontology-0.2');
  });

  test.each(ALL_VOCABULARIES)('%s has no duplicate members', (_name, vocabulary) => {
    expect([...new Set(vocabulary)]).toHaveLength(vocabulary.length);
  });

  test.each(ALL_VOCABULARIES)('%s uses lower_snake_case throughout', (_name, vocabulary) => {
    // Not cosmetic. Two spellings of one label are two labels, and a
    // case-insensitive comparison somewhere downstream would merge them
    // without anyone deciding to.
    for (const value of vocabulary) {
      expect(value).toMatch(/^[a-z][a-z_]*$/);
    }
  });

  test('visibility and certainty overlap on "clear" and nothing else', () => {
    // The one deliberate token collision in the ontology, documented on both
    // enums. 'clear' means "the camera showed it plainly" in one and "I am
    // sure of my label" in the other. If the two sets ever share a SECOND
    // member, a generic validator across them stops being obviously wrong and
    // starts being plausibly right, which is when this becomes a real defect.
    const shared = VISIBILITIES.filter((value) =>
      (ANNOTATION_CERTAINTIES as readonly string[]).includes(value),
    );
    expect(shared).toEqual(['clear']);
  });

  test('target zones are a subset of contact zones, and contact zones say more', () => {
    // Where a punch was AIMED can always be described by what it could have
    // REACHED, but not the reverse: 'glove' and 'forearm' are things a punch
    // lands on, never things it is aimed at.
    for (const target of TARGET_ZONES) {
      expect(CONTACT_ZONES as readonly string[]).toContain(target);
    }
    expect(CONTACT_ZONES.length).toBeGreaterThan(TARGET_ZONES.length);
  });

  test('contact zones distinguish "reached nothing" from "could not tell"', () => {
    // Two different observations. Collapsing them would manufacture misses
    // out of bad camera angles.
    expect(CONTACT_ZONES).toContain('none');
    expect(CONTACT_ZONES).toContain('unknown');
  });

  test('punch types decompose hand role rather than bundling it into a ring name', () => {
    // The shipping athlete-facing vocabulary in app/athlete/dashboard/sparring
    // uses Jab/Cross/Hook/Uppercut/Body, where 'Jab' asserts lead hand AND
    // straight trajectory in one token and 'Body' is a TARGET wearing a punch
    // type's clothes. That vocabulary cannot express a disagreement about
    // hand separately from one about trajectory, which is the whole thing a
    // calibration study measures. These assertions stop the ontology being
    // "simplified" back toward it.
    for (const forbidden of ['jab', 'cross', 'body', 'straight', 'hook', 'uppercut']) {
      expect(PUNCH_TYPES as readonly string[]).not.toContain(forbidden);
    }
    for (const punchType of PUNCH_TYPES) {
      if (punchType === 'other_punch' || punchType === 'unclassifiable_punch') continue;
      expect(punchType).toMatch(/^(lead|rear)_/);
    }
  });

  test('an unclassifiable event is distinguishable from an out-of-taxonomy one', () => {
    // 'other_*' says the taxonomy is incomplete; 'unclassifiable_*' says the
    // footage was. Only one of those is a reason to revise the ontology.
    expect(PUNCH_TYPES).toContain('other_punch');
    expect(PUNCH_TYPES).toContain('unclassifiable_punch');
    expect(DEFENSE_TYPES).toContain('other_defense');
    expect(DEFENSE_TYPES).toContain('unclassifiable_defense');
  });
});

describe('the forbidden concepts stay out', () => {
  // Each of these requires a definition the owner has not ratified. The order
  // is explicit: if code appears to need one, the dependency stops rather
  // than the definition being invented.
  const FORBIDDEN = [
    'fatigue',
    'power',
    'quality',
    'score',
    'technique',
    'ring_control',
    'fight_iq',
    'counter_opportunity',
    'scoring',
    'good_',
    'bad_',
    'priority',
    'effective',
    'success',
    'clean_technique',
  ];

  test.each(ALL_VOCABULARIES)('%s names no unratified judgement', (_name, vocabulary) => {
    for (const value of vocabulary) {
      for (const forbidden of FORBIDDEN) {
        expect(value).not.toContain(forbidden);
      }
    }
  });

  test('defense types describe movement, never whether it worked', () => {
    // There is no successful_block and no failed_slip. Whether the incoming
    // punch landed is recorded on that punch's own CONTACT_RESULT, which is
    // the honest place for it.
    for (const value of DEFENSE_TYPES) {
      expect(value).not.toMatch(/success|fail|good|bad|clean|poor/);
    }
  });
});

describe('validation rejects and never coerces', () => {
  test('a value outside the vocabulary is refused', () => {
    expect(isInVocabulary(PUNCH_TYPES, 'lead_straight')).toBe(true);
    expect(isInVocabulary(PUNCH_TYPES, 'jab')).toBe(false);
    expect(isInVocabulary(DEFENSE_TYPES, 'slip')).toBe(true);
    expect(isInVocabulary(DEFENSE_TYPES, 'dodge')).toBe(false);
  });

  test('near misses are refused rather than normalised', () => {
    // Trimming or lower-casing here would be a silent rewrite of an
    // annotator's recorded observation. The caller fixes its input.
    expect(isInVocabulary(STANCES, ' orthodox')).toBe(false);
    expect(isInVocabulary(STANCES, 'orthodox ')).toBe(false);
    expect(isInVocabulary(STANCES, 'Orthodox')).toBe(false);
    expect(isInVocabulary(STANCES, 'ORTHODOX')).toBe(false);
  });

  test('non-strings are refused without throwing', () => {
    for (const value of [null, undefined, 0, 1, true, false, {}, [], ['slip']]) {
      expect(isInVocabulary(DEFENSE_TYPES, value)).toBe(false);
    }
  });

  test('a value valid in one vocabulary is not accepted for another', () => {
    // 'head' is a legitimate TARGET_ZONE and a legitimate CONTACT_ZONE, and
    // that overlap is why each field names its own vocabulary at the call
    // site instead of sharing one validator.
    expect(isInVocabulary(TARGET_ZONES, 'head')).toBe(true);
    expect(isInVocabulary(TARGET_ZONES, 'glove')).toBe(false);
    expect(isInVocabulary(CONTACT_ZONES, 'glove')).toBe(true);
  });
});

describe('the SQL constraints and the TypeScript arrays cannot drift apart', () => {
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');

  test('every clip sampling reason in the module is admitted by the migration', () => {
    // The failure this catches: a reason added to the array and not to the
    // CHECK. TypeScript would accept it, the route would accept it, and the
    // insert would die on a constraint violation in production.
    for (const reason of CLIP_SAMPLING_REASONS) {
      expect(migration).toContain(`'${reason}'`);
    }
  });

  test('the migration admits no sampling reason the module does not know', () => {
    // The opposite failure, and the more dangerous one: a value the database
    // stores and no TypeScript reader can interpret.
    const checkBlock = migration.match(
      /check \(primary_sampling_reason in \(([\s\S]*?)\)\)/,
    );
    expect(checkBlock).not.toBeNull();
    const declared = [...(checkBlock as RegExpMatchArray)[1].matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1],
    );
    expect(declared.sort()).toEqual([...CLIP_SAMPLING_REASONS].sort());
  });

  test('the migration admits exactly the project statuses the module knows', () => {
    const checkBlock = migration.match(/check \(status in \(([\s\S]*?)\)\)/);
    expect(checkBlock).not.toBeNull();
    const declared = [...(checkBlock as RegExpMatchArray)[1].matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1],
    );
    expect(declared.sort()).toEqual([...CALIBRATION_PROJECT_STATUSES].sort());
  });
});

describe('vocabularyCheckSql', () => {
  test('renders a constraint fragment in the same form the migration uses', () => {
    expect(vocabularyCheckSql('hand_role', HAND_ROLES)).toBe(
      "check (hand_role in ('lead', 'rear', 'unknown'))",
    );
  });

  test('escapes a single quote rather than closing the literal', () => {
    // No current member needs this -- every one is [a-z_]+. It is here so
    // that a vocabulary built from anything but a literal cannot make this
    // function an injection seam.
    expect(vocabularyCheckSql('col', ["it's"])).toBe("check (col in ('it''s'))");
  });
});

describe('boxing-ontology-0.1 is unchanged by 0.2', () => {
  // Every 0.1 vocabulary, written out as it stood before 0.2 existed. Rows
  // stamped 0.1 mean what these arrays said when they were written; editing
  // one would silently re-label collected data. 0.2 is additive and must
  // leave every one of these exactly as it is, members and order.
  const PINNED_0_1: Array<[string, readonly string[], readonly string[]]> = [
    ['EVENT_CLASSES', EVENT_CLASSES, ['punch', 'defense']],
    ['PUNCH_TYPES', PUNCH_TYPES, [
      'lead_straight', 'rear_straight', 'lead_hook', 'rear_hook', 'lead_uppercut',
      'rear_uppercut', 'other_punch', 'unclassifiable_punch',
    ]],
    ['PHYSICAL_HANDS', PHYSICAL_HANDS, ['left', 'right', 'unknown']],
    ['HAND_ROLES', HAND_ROLES, ['lead', 'rear', 'unknown']],
    ['STANCES', STANCES, ['orthodox', 'southpaw', 'transition', 'unknown']],
    ['TARGET_ZONES', TARGET_ZONES, ['head', 'torso', 'unknown']],
    ['CONTACT_RESULTS', CONTACT_RESULTS, [
      'clean_target_contact', 'glancing_target_contact', 'guard_contact',
      'non_target_contact', 'no_contact', 'uncertain_contact',
    ]],
    ['CONTACT_ZONES', CONTACT_ZONES, [
      'head', 'torso', 'glove', 'forearm', 'arm', 'non_target', 'none', 'unknown',
    ]],
    ['DEFENSE_TYPES', DEFENSE_TYPES, [
      'block', 'parry', 'slip', 'roll_weave', 'duck', 'pull_back', 'step_back',
      'lateral_step', 'pivot', 'smother', 'clinch_defense', 'other_defense',
      'unclassifiable_defense',
    ]],
    ['VISIBILITIES', VISIBILITIES, [
      'clear', 'partially_occluded', 'fully_occluded', 'outside_frame', 'camera_cut',
    ]],
    ['ANNOTATION_CERTAINTIES', ANNOTATION_CERTAINTIES, ['clear', 'probable', 'uncertain']],
    ['CALIBRATION_PROJECT_STATUSES', CALIBRATION_PROJECT_STATUSES, [
      'draft', 'annotating', 'adjudicating', 'completed', 'archived',
    ]],
    ['CLIP_SAMPLING_REASONS', CLIP_SAMPLING_REASONS, [
      'isolated_punch', 'combination', 'defense', 'counter', 'head_body_mix',
      'opposite_stance', 'stance_switch', 'guard_contact', 'occlusion',
      'simultaneous_exchange', 'other',
    ]],
    ['ANNOTATION_SET_STATUSES', ANNOTATION_SET_STATUSES, ['in_progress', 'submitted']],
  ];

  test.each(PINNED_0_1)('%s is exactly as 0.1 wrote it', (_name, vocabulary, pinned) => {
    expect([...vocabulary]).toEqual([...pinned]);
  });
});

describe('which version answers which question', () => {
  // "The version" stopped being one thing when 0.2 arrived. These hold the
  // relationships the call sites rely on, so a later edit to one constant
  // cannot quietly strand a study.

  test('the build knows 0.1 and 0.2, in that order', () => {
    expect([...SUPPORTED_BOXING_ONTOLOGY_VERSIONS]).toEqual([
      'boxing-ontology-0.1',
      'boxing-ontology-0.2',
    ]);
  });

  test('a new study is always created under a version the page can label', () => {
    // Otherwise a coach could start a study and find nobody can open it.
    expect(ANNOTATABLE_ONTOLOGY_VERSIONS).toContain(PROJECT_CREATION_ONTOLOGY_VERSION);
  });

  test('every labellable or body-point version is one the build knows', () => {
    for (const version of [...ANNOTATABLE_ONTOLOGY_VERSIONS, ...BODY_POINT_ONTOLOGY_VERSIONS]) {
      expect(SUPPORTED_BOXING_ONTOLOGY_VERSIONS as readonly string[]).toContain(version);
    }
  });

  test('0.1 never carries body points', () => {
    // OD-2026-10-02-008 4A: old studies finish on old labels; never mixed.
    expect(BODY_POINT_ONTOLOGY_VERSIONS).not.toContain(BOXING_ONTOLOGY_VERSION_0_1);
    expect([...BODY_POINT_ONTOLOGY_VERSIONS]).toEqual([BOXING_ONTOLOGY_VERSION_0_2]);
  });

  test('until 0.2 can be labelled, only 0.1 is labelled and created', () => {
    // 0.2's event rules and screen do not exist in this build. Opening or
    // creating a 0.2 study now would put 0.1's forms over a 0.2 stamp. The
    // change that makes 0.2 labellable changes this test on purpose.
    expect([...ANNOTATABLE_ONTOLOGY_VERSIONS]).toEqual([BOXING_ONTOLOGY_VERSION_0_1]);
    expect(PROJECT_CREATION_ONTOLOGY_VERSION).toBe(BOXING_ONTOLOGY_VERSION_0_1);
  });
});

describe('boxing-ontology-0.2 body points', () => {
  test('the 24 points are exactly the ratified list, in marking order', () => {
    // OD-2026-10-02-008 section 2: head (nose, chin); trunk (neck, mid-hip);
    // each arm (shoulder, elbow, wrist, glove); each leg (hip, knee, ankle);
    // each foot (heel, big toe, small toe). Named left/right (-011 3b).
    const limb = [
      'shoulder', 'elbow', 'wrist', 'glove', 'hip', 'knee', 'ankle', 'heel',
      'big_toe', 'small_toe',
    ];
    expect([...BODY_POINTS]).toEqual([
      'nose', 'chin', 'neck', 'mid_hip',
      ...limb.map((part) => `left_${part}`),
      ...limb.map((part) => `right_${part}`),
    ]);
    expect(BODY_POINTS).toHaveLength(24);
  });

  test('no hand points beyond the glove, and nothing named lead or rear', () => {
    // Hand points are not in the ratified list; lead and rear are worked out
    // from the lead side, never clicked (OD-2026-10-02-011 3b).
    for (const point of BODY_POINTS) {
      expect(point).not.toMatch(/index|pinky|thumb|^lead_|^rear_/);
    }
  });

  test('placement rules exist only where Jason gave one', () => {
    // Glove: centre of the padded knuckle area. Chin: tip of the chin. Any
    // other rule would be invented here.
    expect(BODY_POINT_PLACEMENT_NOTES).toEqual({
      chin: 'the tip of the chin',
      left_glove: 'the centre of the padded knuckle area',
      right_glove: 'the centre of the padded knuckle area',
    });
  });

  test('a point is placed or not visible, with no machine-proposal state', () => {
    // No pose tool is used (OD-2026-10-02-011 section 2), so there is nothing
    // to accept or correct, and no per-point certainty.
    expect([...BODY_POINT_STATES]).toEqual(['placed', 'not_visible']);
  });

  test('three moments, and no peak', () => {
    expect([...MOMENT_SLOTS]).toEqual(['start', 'middle', 'end']);
    expect([...MOMENT_KINDS]).toEqual(['start', 'contact', 'full_extension', 'furthest_point', 'end']);
    expect(MOMENT_KINDS as readonly string[]).not.toContain('peak');
  });

  test('the actor, and the other person on contact against them', () => {
    expect([...BODY_SUBJECTS]).toEqual(['actor', 'opponent']);
  });

  test('lead side is 0.1 stance plus neutral, one token per concept', () => {
    // OD-2026-10-02-011 3b adds neutral; -016 D3 A keeps unknown. Mid-switch
    // is the same observation as 0.1's 'transition' and uses the same token.
    expect([...LEAD_SIDES]).toEqual(['orthodox', 'southpaw', 'neutral', 'transition', 'unknown']);
    for (const stance of STANCES) {
      expect(LEAD_SIDES as readonly string[]).toContain(stance);
    }
  });
});

describe('named guards and stance types, by sanctioning body', () => {
  const NAMED_GUARDS = Object.entries(GUARD_TYPE_SOURCES);
  const NAMED_STANCES = Object.entries(STANCE_TYPE_SOURCES);
  const ALL_NAMED = [...NAMED_GUARDS, ...NAMED_STANCES];

  test('every named token has a source entry and every entry is a token', () => {
    const namedGuardTokens = GUARD_TYPES.filter((token) => token !== 'other' && token !== 'unknown');
    const namedStanceTokens = STANCE_TYPES.filter((token) => token !== 'other' && token !== 'unknown');
    expect(Object.keys(GUARD_TYPE_SOURCES).sort()).toEqual([...namedGuardTokens].sort());
    expect(Object.keys(STANCE_TYPE_SOURCES).sort()).toEqual([...namedStanceTokens].sort());
  });

  test('both lists end with other and unknown, which are observations', () => {
    expect(GUARD_TYPES.slice(-2)).toEqual(['other', 'unknown']);
    expect(STANCE_TYPES.slice(-2)).toEqual(['other', 'unknown']);
  });

  test('a guard is never also a stance type', () => {
    // OD-2026-10-02-014 moved AIBA's stance entries out of the guard list.
    const guards = new Set<string>(GUARD_TYPES);
    expect(STANCE_TYPES.filter((token) => guards.has(token))).toEqual(['other', 'unknown']);
  });

  test.each(ALL_NAMED)('%s is prefixed with its own body and points at a known manual', (token, source) => {
    // Kept separate by body, never equated across bodies (-011 3b, -014).
    expect(token.startsWith(`${source.body}__`)).toBe(true);
    expect(SOURCE_MANUALS[source.body]).toBeDefined();
    expect(source.nameAsPrinted.trim()).not.toBe('');
  });

  test.each(ALL_NAMED)('%s has both pages, or says why not', (_token, source) => {
    const missing = source.printedPage === null || source.pdfPage === null;
    if (missing) {
      expect(source.unconfirmed?.trim()).toBeTruthy();
    } else {
      expect(source.unconfirmed).toBeUndefined();
      expect(Number.isInteger(source.printedPage)).toBe(true);
      expect(Number.isInteger(source.pdfPage)).toBe(true);
    }
  });

  test('the unconfirmed entries are exactly the known ones', () => {
    // An exact list, not a printout: a new entry added without both pages
    // fails here until somebody looks it up or adds it on purpose.
    const unconfirmed = ALL_NAMED
      .filter(([, source]) => source.printedPage === null || source.pdfPage === null)
      .map(([token]) => token);
    expect(unconfirmed).toEqual(['usiba__on_guard']);
  });

  test('every manual names the PDF its pages were read in', () => {
    for (const manual of Object.values(SOURCE_MANUALS)) {
      expect(manual.url).toMatch(/^https:\/\/\S+\.pdf$/);
      expect(manual.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('the source entries carry no definition or purpose text', () => {
    // The manuals' own words are licensed excerpts, kept privately and never
    // in the public repository (OD-2026-10-02-013 section 2). Only the name,
    // body and pages live here.
    const allowed = ['body', 'nameAsPrinted', 'printedPage', 'pdfPage', 'unconfirmed'];
    for (const [, source] of ALL_NAMED) {
      for (const key of Object.keys(source)) {
        expect(allowed).toContain(key);
      }
    }
  });
});
