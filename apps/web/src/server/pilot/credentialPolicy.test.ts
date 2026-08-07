import type { PilotRole } from './contracts';
import {
  MAGIC_LINK_ROLES,
  MICROSOFT_ROLES,
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

  test('ANY board seat upgrades the holder to Microsoft whatever their role', () => {
    // Every seat, not a privileged subset: each board office has a mailbox on
    // the domain, so each holder already has a Microsoft identity.
    for (const seat of EVERY_SEAT) {
      // A parent is the weakest case: magic_link by role, Microsoft by seat.
      expect(requiredCredentialFor({ role: 'parent', boardSeats: [seat] })).toBe('microsoft');
      expect(requiredCredentialFor({ role: 'coach', boardSeats: [seat] })).toBe('microsoft');
      expect(requiredCredentialFor({ role: 'volunteer', boardSeats: [seat] })).toBe('microsoft');
    }
  });

  test('a seat slug the policy has never seen still upgrades the holder', () => {
    // The rule is "holds a seat", not "holds one of these seats", so adding a
    // ninth office to boardWorkspaceConfig cannot silently leave its holder on
    // a weaker credential.
    expect(requiredCredentialFor({ role: 'parent', boardSeats: ['ninth-office-added-later'] }))
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

  test('no board seats and undefined board seats mean the same thing', () => {
    expect(requiredCredentialFor({ role: 'coach', boardSeats: [] }))
      .toBe(requiredCredentialFor({ role: 'coach' }));
    expect(requiredCredentialFor({ role: 'coach', boardSeats: [] })).toBe('magic_link');
  });

  test('the board role uses Microsoft even with no seat recorded', () => {
    // Someone carrying role='board' before their seat assignment lands still
    // has a domain mailbox, so they take the strong credential either way.
    expect(requiredCredentialFor({ role: 'board' })).toBe('microsoft');
  });

  test('an unclassified role is refused rather than given the weakest credential', () => {
    expect(() => requiredCredentialFor({ role: 'sponsor' as PilotRole }))
      .toThrow('UNCLASSIFIED_ROLE:sponsor');
  });
});
