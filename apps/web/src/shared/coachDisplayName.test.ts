import { coachDisplayNameFor, staffDisplayNameFor } from './coachDisplayName';

describe('coachDisplayNameFor: the name the gym typed comes first (Q1 part B)', () => {
  test('a typed name is titled once', () => {
    expect(coachDisplayNameFor('Jordan Smith', 'coach@ppbf.org')).toBe('Coach Jordan Smith');
  });

  test('a typed name that already carries the title is not titled twice', () => {
    expect(coachDisplayNameFor('Coach Jordan', 'coach@ppbf.org')).toBe('Coach Jordan');
    expect(coachDisplayNameFor('coach  coach Jordan', null)).toBe('Coach Jordan');
  });

  test('a typed name that is only the title, or blank, falls back to the login', () => {
    expect(coachDisplayNameFor('Coach', 'dave.r@ppbf.org')).toBe('Coach Dave R');
    expect(coachDisplayNameFor('   ', 'dave.r@ppbf.org')).toBe('Coach Dave R');
    expect(coachDisplayNameFor(null, 'coach@ppbf.org')).toBe('Your coach');
  });

  test('a name starting with "Coach" as part of a word is kept whole', () => {
    expect(coachDisplayNameFor('Coachman Lee', null)).toBe('Coach Coachman Lee');
  });
});

describe('staffDisplayNameFor', () => {
  test('a typed name is used as typed, with no title', () => {
    expect(staffDisplayNameFor('Jordan Smith', 'ppbf@ppbf.org')).toBe('Jordan Smith');
  });

  test('no typed name falls back to the login, and to null when neither names them', () => {
    expect(staffDisplayNameFor(null, 'pat.office@ppbf.org')).toBe('Pat Office');
    expect(staffDisplayNameFor('', 'ppbf@ppbf.org')).toBeNull();
  });
});
