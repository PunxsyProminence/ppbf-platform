import { ForbiddenError, ValidationError } from './errors';
import { parseLibraryShelf, resolveLibraryShelf, type LibraryShelfAccess } from './libraryShelf';
import { PLATFORM_LIBRARY_ORGANIZATION_ID } from './platformLibraryScope';
import type { PilotRole } from './contracts';

const ALL_ROLES: PilotRole[] = [
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
const NON_OWNERS = ALL_ROLES.filter((role) => role !== 'platform_owner');
const ACCESSES: LibraryShelfAccess[] = ['read', 'write', 'review'];

function actor(role: PilotRole) {
  return { role, organizationId: 'org-home' };
}

describe('parseLibraryShelf', () => {
  test.each([undefined, null])('%s means the gym shelf', (value) => {
    expect(parseLibraryShelf(value)).toBe('gym');
  });

  test.each(['gym', 'platform'])('accepts %s', (value) => {
    expect(parseLibraryShelf(value)).toBe(value);
  });

  // An organization id -- the reserved one included -- is never a shelf. The
  // request names a shelf; the server decides what organization that is.
  test.each(['', 'Platform', 'org-home', PLATFORM_LIBRARY_ORGANIZATION_ID, 1, true, {}, ['platform']])(
    'refuses %p',
    (value) => {
      expect(() => parseLibraryShelf(value)).toThrow(ValidationError);
    },
  );
});

describe('resolveLibraryShelf: the platform shelf (OD-2026-10-02-013 1B)', () => {
  test.each(ACCESSES)('platform_owner reaches the reserved organization for %s', (access) => {
    expect(resolveLibraryShelf(actor('platform_owner'), 'platform', access)).toBe(PLATFORM_LIBRARY_ORGANIZATION_ID);
  });

  test.each(NON_OWNERS.flatMap((role) => ACCESSES.map((access) => [role, access] as const)))(
    '%s is refused the platform shelf for %s with a 403',
    (role, access) => {
      let thrown: unknown;
      try {
        resolveLibraryShelf(actor(role), 'platform', access);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ForbiddenError);
      expect((thrown as ForbiddenError).status).toBe(403);
    },
  );
});

describe('resolveLibraryShelf: the gym shelf', () => {
  test.each(NON_OWNERS.flatMap((role) => ACCESSES.map((access) => [role, access] as const)))(
    '%s %s resolves to its own organization, named or not',
    (role, access) => {
      expect(resolveLibraryShelf(actor(role), undefined, access)).toBe('org-home');
      expect(resolveLibraryShelf(actor(role), null, access)).toBe('org-home');
      expect(resolveLibraryShelf(actor(role), 'gym', access)).toBe('org-home');
    },
  );

  // OD-2026-10-02-015 D3: the platform owner no longer writes a gym's shelf.
  test.each([undefined, null, 'gym'])('platform_owner cannot WRITE the gym shelf (shelf %p)', (shelf) => {
    expect(() => resolveLibraryShelf(actor('platform_owner'), shelf, 'write')).toThrow(ForbiddenError);
  });

  // Only writes: reading a gym's Library and approving on /evidence stay as
  // they were (OD-2026-10-02-013 answer 5A).
  test.each(['read', 'review'] as const)('platform_owner keeps gym-shelf %s', (access) => {
    expect(resolveLibraryShelf(actor('platform_owner'), undefined, access)).toBe('org-home');
  });
});
