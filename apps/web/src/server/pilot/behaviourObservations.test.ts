import fs from 'node:fs';
import path from 'node:path';

import {
  ATTEMPT_CONTEXTS,
  ATTRIBUTION_CERTAINTIES,
  ATTRIBUTION_TARGETS,
  FATIGUE_CONTEXTS,
  POLARITIES,
  SKILL_CODE_PATTERN,
  TASK_CONSTRAINTS,
} from './behaviourObservations';
import { SKILL_CODE_PATTERN as CONTENT_SKILL_CODE_PATTERN } from './contentImport/ids';
import { ATTRIBUTION_TARGETS as LIBRARY_ATTRIBUTION_TARGETS } from './patterns/evidence';

// The writer's vocabularies are the pattern library's and the table's, word
// for word: a value the writer admits and the table refuses is a 500, and one
// the table admits and the library has no case for is a report the evaluator
// mis-reads. Drift in any of the three is caught here, not on a coach's tap.

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres_learning_loop_migration.sql'),
  'utf8',
);

/** The quoted values of the named check constraint in the migration. */
function checkValues(constraint: string): string[] {
  const at = MIGRATION.indexOf(`constraint ${constraint}`);
  expect(at).toBeGreaterThan(-1);
  // The first value list after the constraint's name is its own.
  const list = /in \(([^)]*)\)/.exec(MIGRATION.slice(at));
  expect(list).not.toBeNull();
  return [...(list as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

test('each vocabulary matches the table check that stores it', () => {
  expect(checkValues('pilot_behaviour_observations_constraint_check')).toEqual([...TASK_CONSTRAINTS]);
  expect(checkValues('pilot_behaviour_observations_fatigue_check')).toEqual([...FATIGUE_CONTEXTS]);
  expect(checkValues('pilot_behaviour_observations_polarity_check')).toEqual([...POLARITIES]);
  expect(checkValues('pilot_behaviour_observations_attribution_check')).toEqual([...ATTRIBUTION_TARGETS]);
  expect(checkValues('pilot_behaviour_observations_certainty_check')).toEqual([...ATTRIBUTION_CERTAINTIES]);
});

test('attribution targets are the pattern library\'s own list', () => {
  expect([...ATTRIBUTION_TARGETS]).toEqual([...LIBRARY_ATTRIBUTION_TARGETS]);
});

test('the skill code shape is the content importer\'s', () => {
  for (const code of ['SK-STANCE-01', 'SK-JAB-12', 'SKILL-01', 'sk-jab-01', 'SK-JAB-1']) {
    expect(SKILL_CODE_PATTERN.test(code)).toBe(CONTENT_SKILL_CODE_PATTERN.test(code));
  }
});

test('a context with no drill is one of the training-attempt context types', () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres_sparring_attempt_contexts_migration.sql'),
    'utf8',
  );
  const values = [...(/check \(context_type in \(([^)]*)\)/.exec(migration) as RegExpExecArray)[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1]);
  expect([...ATTEMPT_CONTEXTS].sort()).toEqual(values.sort());
});
