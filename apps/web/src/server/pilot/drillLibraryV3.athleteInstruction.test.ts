// The athlete DETAIL's practical-instruction projection (OD-2026-09-19-001):
// what good and bad look like, common errors and corrections -- with the
// evidence model's inline grounding-claim tags removed, because grounding
// claims are provenance and OD-2026-09-17-001 clause 8 keeps them off an
// athlete's screen. The real-Postgres half is in drillLibraryV3.pg.test.ts.

jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

import {
  stripGroundingClaimTags,
  toAthleteInstruction,
  toAthleteStopRule,
  toAthleteUniversalStopRule,
} from './drillLibraryV3';

describe('stripGroundingClaimTags', () => {
  test('removes the claim-id tags the seeded prose carries, and the space before them', () => {
    expect(stripGroundingClaimTags('Protects the chin [A2-070]')).toBe('Protects the chin');
    expect(stripGroundingClaimTags('Elite exchanges [A3-021][A2-064][A6-037].')).toBe('Elite exchanges.');
    expect(stripGroundingClaimTags('Hands up [B4-027]\nEyes up [A5-149]')).toBe('Hands up\nEyes up');
  });

  // The registry also holds PS- and CB- claims (contentImport/ids.ts,
  // REGISTRY_CLAIM_ID_PATTERN). The old letter-digit-only pattern left both on
  // an athlete's screen.
  test('removes PS- and CB- claim tags too, alone or beside a letter-digit one', () => {
    expect(stripGroundingClaimTags('Hands home [PS-012]')).toBe('Hands home');
    expect(stripGroundingClaimTags('Coach calls it [CB-003][A2-070].')).toBe('Coach calls it.');
  });

  test('leaves ordinary bracketed prose alone', () => {
    expect(stripGroundingClaimTags('Hold [2 seconds] at the end')).toBe('Hold [2 seconds] at the end');
    expect(stripGroundingClaimTags('Round [A] then round [B]')).toBe('Round [A] then round [B]');
    expect(stripGroundingClaimTags('Rest [PS] then go')).toBe('Rest [PS] then go');
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

// Stop-rule text reaches athletes on the same detail, and the content
// validator accepts inline claim tags in it (both condition_text columns are
// text() content columns), so it is stripped too -- the drill's own rules and
// the gym's stored-once ones alike. Coach reads keep the tag.
describe('athlete stop rules', () => {
  test("strip claim tags from the drill's own rule text", () => {
    expect(toAthleteStopRule({
      drill_id: 'ref-1',
      ordinal: 1,
      condition_text: 'Stop when the hands drop [PS-012].',
      scope: 'drill_specific',
      rule_kind: 'technique_degradation',
    })).toEqual({
      ordinal: 1,
      condition_text: 'Stop when the hands drop.',
      scope: 'drill_specific',
      rule_kind: 'technique_degradation',
      origin: 'drill',
    });
  });

  test('strip claim tags from stored-once rule text', () => {
    expect(toAthleteUniversalStopRule({
      organization_id: 'org-1',
      universal_rule_id: 'ust_injury',
      lineage_id: 'ust_injury',
      version: 1,
      ordinal: 1,
      condition_text: 'Stop on any sign of injury [CB-003][A2-070]',
      rule_kind: 'safety',
      applies_to_contact_levels: null,
      origin: 'universal',
    })).toEqual({ ordinal: 1, condition_text: 'Stop on any sign of injury', rule_kind: 'safety', origin: 'universal' });
  });
});
