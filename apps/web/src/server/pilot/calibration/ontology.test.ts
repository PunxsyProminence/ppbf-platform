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
  ANNOTATION_CERTAINTIES,
  BOXING_ONTOLOGY_VERSION,
  CALIBRATION_PROJECT_STATUSES,
  CLIP_SAMPLING_REASONS,
  CONTACT_RESULTS,
  CONTACT_ZONES,
  DEFENSE_TYPES,
  EVENT_CLASSES,
  HAND_ROLES,
  PHYSICAL_HANDS,
  PUNCH_TYPES,
  STANCES,
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
];

describe('boxing-ontology-0.1 is closed and well formed', () => {
  test('the version string is exact', () => {
    // Stamped onto every row. A drift here silently re-labels collected data.
    expect(BOXING_ONTOLOGY_VERSION).toBe('boxing-ontology-0.1');
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
