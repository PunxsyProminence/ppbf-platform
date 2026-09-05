import type { PilotRole } from './contracts';
import {
  MAGIC_LINK_ROLES,
  MICROSOFT_ROLES,
  OFFLINE_LOCAL_PIN_ROLES,
  pinLoginPermitted,
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

// BASE-03. The offline exception is a SEPARATE question from the production
// credential policy above, and these assert both halves: that the exception
// opens only inside its exact fence, and that the production mappings it sits
// beside are untouched by it.
const OFFLINE = { nodeEnv: 'development', offlineRuntimeFlag: 'true' } as const;

describe('offline local PIN exception (BASE-03)', () => {
  test('the production credential policy is unchanged by the exception', () => {
    expect(requiredCredentialFor({ role: 'organization_admin' })).toBe('microsoft');
    expect(requiredCredentialFor({ role: 'coach' })).toBe('magic_link');
    expect(requiredCredentialFor({ role: 'athlete' })).toBe('pin');
    expect(requiredCredentialFor({ role: 'coach', boardSeats: ['treasurer'] })).toBe('microsoft');
  });

  test('usesPin keeps its production semantics: athlete only, whatever the runtime', () => {
    for (const role of EVERY_ROLE) {
      expect(usesPin({ role })).toBe(role === 'athlete');
    }
  });

  test('an athlete is permitted with no offline flags at all', () => {
    expect(pinLoginPermitted({ role: 'athlete' }, { nodeEnv: 'production', offlineRuntimeFlag: undefined })).toBe(true);
    expect(pinLoginPermitted({ role: 'athlete' }, OFFLINE)).toBe(true);
  });

  test.each(OFFLINE_LOCAL_PIN_ROLES)('%s is refused with no offline flags', (role) => {
    expect(pinLoginPermitted({ role }, { nodeEnv: undefined, offlineRuntimeFlag: undefined })).toBe(false);
  });

  test.each(OFFLINE_LOCAL_PIN_ROLES)('%s is permitted only inside the exact development + offline fence', (role) => {
    expect(pinLoginPermitted({ role }, OFFLINE)).toBe(true);
  });

  // Each half of the fence alone must not open it. The flag leaking into a real
  // deploy is the case that matters: a deploy never runs NODE_ENV=development.
  test.each([
    ['flag set but not development', { nodeEnv: 'production', offlineRuntimeFlag: 'true' }],
    ['development but no flag', { nodeEnv: 'development', offlineRuntimeFlag: undefined }],
    ['development but flag not exactly true', { nodeEnv: 'development', offlineRuntimeFlag: 'TRUE' }],
    ['staging with the flag set', { nodeEnv: 'staging', offlineRuntimeFlag: 'true' }],
    ['test with the flag set', { nodeEnv: 'test', offlineRuntimeFlag: 'true' }],
  ])('the exception stays shut: %s', (_label, environment) => {
    for (const role of OFFLINE_LOCAL_PIN_ROLES) {
      expect(pinLoginPermitted({ role }, environment)).toBe(false);
    }
  });

  test('no role outside the two named ones gains an exception, even inside the fence', () => {
    const excepted = new Set<PilotRole>(OFFLINE_LOCAL_PIN_ROLES);
    for (const role of EVERY_ROLE) {
      if (excepted.has(role) || role === 'athlete') continue;
      expect(pinLoginPermitted({ role }, OFFLINE)).toBe(false);
    }
  });

  // A board seat is an office with a mailbox, so its holder already has a
  // Microsoft identity. An offline convenience must not downgrade that.
  test('a board seat refuses the exception even for an otherwise eligible role', () => {
    for (const role of OFFLINE_LOCAL_PIN_ROLES) {
      expect(pinLoginPermitted({ role, boardSeats: ['president'] }, OFFLINE)).toBe(false);
    }
  });
});
