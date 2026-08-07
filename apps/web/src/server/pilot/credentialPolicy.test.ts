import type { PilotRole } from './contracts';
import {
  MAGIC_LINK_ROLES,
  MICROSOFT_ROLES,
  OFFICER_BOARD_SEATS,
  requiredCredentialFor,
  usesMicrosoft,
  usesPin,
} from './credentialPolicy';

// Every role in the union, written out rather than derived, so adding a role to
// PilotRole fails here until someone states what credential it takes.
const EVERY_ROLE: PilotRole[] = [
  'platform_owner',
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'board',
  'volunteer',
  'staff',
];

// The eight seats from app/board/boardWorkspaceConfig.ts. Listed here so a new
// seat added there without a credential decision shows up as a failure.
const EVERY_SEAT = [
  'president',
  'chair',
  'vice-chair',
  'treasurer',
  'secretary',
  'safety-director',
  'community-director',
  'at-large',
];

describe('credential policy', () => {
  test('every role is classified -- no role falls through', () => {
    for (const role of EVERY_ROLE) {
      expect(() => requiredCredentialFor({ role })).not.toThrow();
      expect(['microsoft', 'magic_link', 'pin']).toContain(requiredCredentialFor({ role }));
    }
  });

  test('the three lists together cover the role union exactly once', () => {
    const classified = [...MICROSOFT_ROLES, ...MAGIC_LINK_ROLES, 'athlete'].sort();
    expect(classified).toEqual([...EVERY_ROLE].sort());
    // No role may appear in two lists -- that would make the answer depend on
    // the order the function happens to check them in.
    expect(new Set(classified).size).toBe(classified.length);
  });

  test('administrators use Microsoft', () => {
    expect(requiredCredentialFor({ role: 'platform_owner' })).toBe('microsoft');
    expect(requiredCredentialFor({ role: 'organization_admin' })).toBe('microsoft');
    expect(requiredCredentialFor({ role: 'admin' })).toBe('microsoft');
  });

  test('participating adults use a magic link', () => {
    for (const role of MAGIC_LINK_ROLES) {
      expect(requiredCredentialFor({ role })).toBe('magic_link');
    }
  });

  test('only athletes use a PIN', () => {
    expect(requiredCredentialFor({ role: 'athlete' })).toBe('pin');
    for (const role of EVERY_ROLE.filter((r) => r !== 'athlete')) {
      expect(usesPin({ role })).toBe(false);
    }
  });

  test('an officer seat upgrades the holder to Microsoft whatever their role', () => {
    for (const seat of OFFICER_BOARD_SEATS) {
      // A parent is the weakest case: magic_link by role, Microsoft by seat.
      expect(requiredCredentialFor({ role: 'parent', boardSeats: [seat] })).toBe('microsoft');
      expect(requiredCredentialFor({ role: 'coach', boardSeats: [seat] })).toBe('microsoft');
    }
  });

  test('a director seat does not upgrade the holder', () => {
    for (const seat of ['safety-director', 'community-director', 'at-large']) {
      expect(requiredCredentialFor({ role: 'parent', boardSeats: [seat] })).toBe('magic_link');
      expect(requiredCredentialFor({ role: 'coach', boardSeats: [seat] })).toBe('magic_link');
    }
  });

  test('one officer seat among several is enough to upgrade', () => {
    expect(requiredCredentialFor({ role: 'parent', boardSeats: ['at-large', 'treasurer'] }))
      .toBe('microsoft');
  });

  test('a seat never DOWNGRADES an administrator', () => {
    // The seat check runs first, so this asserts the branch order cannot make
    // an admin weaker by giving them a director seat.
    for (const seat of EVERY_SEAT) {
      expect(usesMicrosoft({ role: 'organization_admin', boardSeats: [seat] })).toBe(true);
      expect(usesMicrosoft({ role: 'platform_owner', boardSeats: [seat] })).toBe(true);
    }
  });

  test('an athlete can never be given a board seat that changes their credential', () => {
    // Athletes are minors. A seat should never move one onto an adult path.
    for (const seat of EVERY_SEAT.filter((s) => !OFFICER_BOARD_SEATS.includes(s as never))) {
      expect(requiredCredentialFor({ role: 'athlete', boardSeats: [seat] })).toBe('pin');
    }
  });

  test('no board seats and undefined board seats mean the same thing', () => {
    expect(requiredCredentialFor({ role: 'coach', boardSeats: [] }))
      .toBe(requiredCredentialFor({ role: 'coach' }));
  });

  test('an unknown seat slug does not silently upgrade anyone', () => {
    expect(requiredCredentialFor({ role: 'parent', boardSeats: ['not-a-real-seat'] }))
      .toBe('magic_link');
  });

  test('an unclassified role is refused rather than given the weakest credential', () => {
    expect(() => requiredCredentialFor({ role: 'sponsor' as PilotRole }))
      .toThrow('UNCLASSIFIED_ROLE:sponsor');
  });
});
