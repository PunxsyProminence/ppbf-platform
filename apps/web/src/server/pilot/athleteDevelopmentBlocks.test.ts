// The pure half of the development-block contract (module 036 foundation):
// what a coach must have written down before a block is a block.
//
// These rules are also CHECK constraints on pilot.athlete_development_blocks,
// and athleteDevelopmentBlocks.pg.test.ts proves the database enforces them
// against a real Postgres. This file pins the message a caller gets, and the
// cases the database would reject as an opaque driver error rather than as a
// sentence -- an impossible calendar day above all.

import {
  DEVELOPMENT_BLOCK_STATUSES,
  developmentBlockShapeError,
} from './athleteDevelopmentBlocks';

const VALID = {
  title: 'Fall strength block',
  trainingEmphasis: 'Rebuild round-3 work rate; heavier legs, less volume on the bag.',
  startsOn: '2026-09-02',
  endsOn: '2026-10-14',
};

test('a block with a title, a stated emphasis and a sane window is accepted', () => {
  expect(developmentBlockShapeError(VALID)).toBeNull();
  expect(developmentBlockShapeError({ ...VALID, status: 'active' })).toBeNull();
});

test('a one-day block is legal -- ends_on may equal starts_on', () => {
  expect(developmentBlockShapeError({ ...VALID, endsOn: VALID.startsOn })).toBeNull();
});

test('a block with no title is refused', () => {
  expect(developmentBlockShapeError({ ...VALID, title: '' })).toMatch(/needs a title/);
  expect(developmentBlockShapeError({ ...VALID, title: '   ' })).toMatch(/needs a title/);
});

test('a block with no stated emphasis is refused -- that is the whole row', () => {
  // A blank emphasis would leave a date range that reads later as a plan.
  expect(developmentBlockShapeError({ ...VALID, trainingEmphasis: '' })).toMatch(/training emphasis/);
  expect(developmentBlockShapeError({ ...VALID, trainingEmphasis: '\t\n ' })).toMatch(/training emphasis/);
});

test('a window that ends before it begins is refused', () => {
  expect(developmentBlockShapeError({ ...VALID, endsOn: '2026-09-01' }))
    .toMatch(/cannot end before it begins/);
});

test('dates that are not calendar days are refused by name', () => {
  expect(developmentBlockShapeError({ ...VALID, startsOn: '02/09/2026' })).toMatch(/starts_on/);
  expect(developmentBlockShapeError({ ...VALID, startsOn: '2026-9-2' })).toMatch(/starts_on/);
  expect(developmentBlockShapeError({ ...VALID, endsOn: 'next October' })).toMatch(/ends_on/);
  // Shaped like a date, and not a day that exists.
  expect(developmentBlockShapeError({ ...VALID, endsOn: '2026-02-30' })).toMatch(/ends_on/);
  expect(developmentBlockShapeError({ ...VALID, endsOn: '2026-13-01' })).toMatch(/ends_on/);
});

test('the lifecycle vocabulary is closed', () => {
  for (const status of DEVELOPMENT_BLOCK_STATUSES) {
    expect(developmentBlockShapeError({ ...VALID, status })).toBeNull();
  }
  expect(
    developmentBlockShapeError({ ...VALID, status: 'archived' as never }),
  ).toMatch(/Unknown block status 'archived'/);
  expect(
    developmentBlockShapeError({ ...VALID, status: 'in_progress' as never }),
  ).toMatch(/Unknown block status 'in_progress'/);
});

test('the vocabulary is exactly the four states, in the order the schema declares', () => {
  // A fifth state added here without the CHECK constraint moving would be
  // accepted by this module and rejected by the database.
  expect([...DEVELOPMENT_BLOCK_STATUSES]).toEqual(['draft', 'active', 'completed', 'cancelled']);
});
