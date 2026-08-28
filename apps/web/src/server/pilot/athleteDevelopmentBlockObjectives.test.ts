// The pure half of the block-objective contract (module 036, slice 2): which
// domains exist, and what a coach must have written down.
//
// The vocabulary assertions pin the list so that changing it is a deliberate
// edit in the same commit as the migration rather than a drift -- the module
// accepting a value the database refuses is the failure they exist to stop.
//
// The tenth domain, nutrition_body_composition, shipped withheld and was
// admitted by owner decision 2026-08-28. The tests that guarded the
// withholding are not deleted; they are turned around to guard what the
// decision did NOT do, which is the part a later change is most likely to
// get wrong.

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

test('the vocabulary is exactly the ten Full Spectrum domains, in declaration order', () => {
  // If this list changes, the migration's CHECK constraint must change in
  // the same commit or the two disagree -- the module would accept a value
  // the database refuses.
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
    'nutrition_body_composition',
  ]);
});

test('nutrition / body composition is admitted (owner decision, 2026-08-28)', () => {
  expect(blockObjectiveShapeError({ ...VALID, domain: 'nutrition_body_composition' })).toBeNull();
});

test('admitting the domain did not admit free-form weight vocabulary', () => {
  // What was decided is one DOMAIN LABEL. These are not domains, they never
  // were, and a later change that reads the 2026-08-28 decision as "body
  // composition is open now" would most plausibly go wrong here first.
  for (const notADomain of ['weight_cut', 'weight_loss', 'weight_gain', 'body_composition', 'nutrition']) {
    expect(blockObjectiveShapeError({ ...VALID, domain: notADomain as never }))
      .toMatch(/Unknown development domain/);
  }
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
