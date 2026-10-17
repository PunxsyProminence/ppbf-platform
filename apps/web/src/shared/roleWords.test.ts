import { roleWords } from './roleWords';

describe('roleWords (F-122)', () => {
  test.each([
    ['platform_owner', 'Platform Owner'],
    ['organization_admin', 'Gym Admin'],
    ['admin', 'Gym Admin'],
    ['coach', 'Coach'],
    ['athlete', 'Athlete'],
    ['parent', 'Parent'],
    ['board', 'Board'],
    ['volunteer', 'Volunteer'],
    ['staff', 'Staff'],
  ])('%s reads as %s', (role, words) => {
    expect(roleWords(role)).toBe(words);
  });

  test('a role it does not know still never shows raw', () => {
    expect(roleWords('front_desk_lead')).toBe('Front Desk Lead');
  });

  test('no role is no words', () => {
    expect(roleWords(null)).toBe('');
    expect(roleWords(undefined)).toBe('');
    expect(roleWords('  ')).toBe('');
  });
});
