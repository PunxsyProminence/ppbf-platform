// The athlete DETAIL's practical-instruction projection (OD-2026-09-19-001):
// what good and bad look like, common errors and corrections -- with the
// evidence model's inline grounding-claim tags removed, because grounding
// claims are provenance and OD-2026-09-17-001 clause 8 keeps them off an
// athlete's screen. The real-Postgres half is in drillLibraryV3.pg.test.ts.

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

import { stripGroundingClaimTags, toAthleteInstruction } from './drillLibraryV3';

describe('stripGroundingClaimTags', () => {
  test('removes the claim-id tags the seeded prose carries, and the space before them', () => {
    expect(stripGroundingClaimTags('Protects the chin [A2-070]')).toBe('Protects the chin');
    expect(stripGroundingClaimTags('Elite exchanges [A3-021][A2-064][A6-037].')).toBe('Elite exchanges.');
    expect(stripGroundingClaimTags('Hands up [B4-027]\nEyes up [A5-149]')).toBe('Hands up\nEyes up');
  });

  test('leaves ordinary bracketed prose alone', () => {
    expect(stripGroundingClaimTags('Hold [2 seconds] at the end')).toBe('Hold [2 seconds] at the end');
    expect(stripGroundingClaimTags('Round [A] then round [B]')).toBe('Round [A] then round [B]');
  });
});

describe('toAthleteInstruction', () => {
  test('is constructive: exactly the five practical-instruction keys, each stripped', () => {
    const row = {
      what_good_looks_like: 'Glove meets the punch [A2-070]',
      what_bad_looks_like: 'Reaching [B3-047]',
      common_errors: 'Catching late',
      corrections: 'Coach calls "catch" [A5-149]',
      equipment_needed: 'focus mitt',
      // A key that must NOT survive the projection even if a caller passes it.
      grounding_claim_ids: ['A2-070'],
    };

    const projected = toAthleteInstruction(row);

    expect(Object.keys(projected).sort()).toEqual([
      'common_errors',
      'corrections',
      'equipment_needed',
      'what_bad_looks_like',
      'what_good_looks_like',
    ]);
    expect(projected).toEqual({
      what_good_looks_like: 'Glove meets the punch',
      what_bad_looks_like: 'Reaching',
      common_errors: 'Catching late',
      corrections: 'Coach calls "catch"',
      equipment_needed: 'focus mitt',
    });
    expect(JSON.stringify(projected)).not.toMatch(/\[[A-Z]\d+-\d+\]/);
  });
});
