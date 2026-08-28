// The pure half of the block-objective contract (module 036, slice 2): which
// domains exist, and what a coach must have written down.
//
// The vocabulary assertions here are the forcing function for the withheld
// tenth domain. athleteDevelopmentBlockObjectives.pg.test.ts proves the
// database refuses it; this file proves the module refuses it with a reason
// a person can act on, and pins the list so that widening it is a deliberate
// edit in the same commit as the migration rather than a drift.

import {
  FULL_SPECTRUM_DOMAINS,
  OBJECTIVE_STATUSES,
  blockObjectiveShapeError,
} from './athleteDevelopmentBlockObjectives';

const VALID = {
  domain: 'technical' as const,
  objective: 'Jab off the back foot under pressure, not just off the front.',
};

test('an objective in a known domain, with words in it, is accepted', () => {
  expect(blockObjectiveShapeError(VALID)).toBeNull();
  expect(blockObjectiveShapeError({ ...VALID, status: 'active' })).toBeNull();
});

test('every declared domain is accepted', () => {
  for (const domain of FULL_SPECTRUM_DOMAINS) {
    expect(blockObjectiveShapeError({ ...VALID, domain })).toBeNull();
  }
});

test('the vocabulary is exactly the nine domains that ship, in declaration order', () => {
  // Nine, not ten. If this list changes, the migration's CHECK constraint
  // must change in the same commit or the two disagree -- the module would
  // accept a value the database refuses.
  expect([...FULL_SPECTRUM_DOMAINS]).toEqual([
    'technical',
    'physical',
    'conditioning',
    'mental',
    'recovery_load',
    'sparring_live_progression',
    'competition_preparation',
    'tactical_film_study',
    'lifestyle_athlete_identity',
  ]);
});

test('nutrition / body composition is refused, and says why rather than just no', () => {
  // The withheld tenth domain. This is not a typo case: a coach reaching for
  // it is asking a real question, and the refusal points them somewhere
  // instead of stopping dead -- the owner principle the goal-category
  // migration records ("the stop carries the lesson, it is not just a wall").
  const refusal = blockObjectiveShapeError({
    ...VALID,
    domain: 'nutrition_body_composition' as never,
  });
  expect(refusal).toMatch(/not an available objective domain/);
  expect(refusal).toMatch(/pending an owner decision/);
  expect(refusal).toMatch(/coach and guardian/);
  // And it does NOT read like an unknown-value error, because it is not one.
  expect(refusal).not.toMatch(/Unknown development domain/);
});

test('an invented domain is refused by name', () => {
  expect(blockObjectiveShapeError({ ...VALID, domain: 'vibes' as never }))
    .toMatch(/Unknown development domain 'vibes'/);
  // A near miss of a real domain is still a miss -- no fuzzy matching.
  expect(blockObjectiveShapeError({ ...VALID, domain: 'Technical' as never }))
    .toMatch(/Unknown development domain 'Technical'/);
});

test('an objective with no words in it is refused', () => {
  expect(blockObjectiveShapeError({ ...VALID, objective: '' })).toMatch(/coach's own words/);
  expect(blockObjectiveShapeError({ ...VALID, objective: '   ' })).toMatch(/coach's own words/);
  expect(blockObjectiveShapeError({ ...VALID, objective: '\t\n ' })).toMatch(/coach's own words/);
});

test('the lifecycle vocabulary is the parent block\'s, and it is closed', () => {
  expect([...OBJECTIVE_STATUSES]).toEqual(['draft', 'active', 'completed', 'cancelled']);
  for (const status of OBJECTIVE_STATUSES) {
    expect(blockObjectiveShapeError({ ...VALID, status })).toBeNull();
  }
  expect(blockObjectiveShapeError({ ...VALID, status: 'archived' as never }))
    .toMatch(/Unknown objective status 'archived'/);
});
