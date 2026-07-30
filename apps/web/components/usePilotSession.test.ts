import { isOrganizationAdminSessionRole, type PilotSessionRole } from './usePilotSession';
import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import type { PilotRole } from '@/src/server/pilot/contracts';

// The client-side check exists so the UI never offers an action the server
// will reject. That only holds while the two agree, so assert it directly
// rather than trusting a comment to keep them in step.
describe('isOrganizationAdminSessionRole mirrors the server boundary', () => {
  const roles: PilotSessionRole[] = [
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

  test.each(roles)('agrees with the server for %s', (role) => {
    expect(isOrganizationAdminSessionRole(role)).toBe(isOrganizationAdminRole(role as PilotRole));
  });

  test('admits the organization admin roles', () => {
    expect(isOrganizationAdminSessionRole('organization_admin')).toBe(true);
    expect(isOrganizationAdminSessionRole('admin')).toBe(true);
  });

  test('excludes the platform owner', () => {
    // Not an oversight: every route behind the People console is
    // organization-scoped and rejects a platform owner, so offering them the
    // entry point could only ever produce a 403.
    expect(isOrganizationAdminSessionRole('platform_owner')).toBe(false);
  });

  test('excludes an unauthenticated session', () => {
    expect(isOrganizationAdminSessionRole(null)).toBe(false);
  });
});
