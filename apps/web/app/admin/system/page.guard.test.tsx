/**
 * @jest-environment node
 */

// Who may open /admin/system (WO-N7-03, N7-03-Q1 A): the platform owner, through the real page
// guard. Every other role is sent away before the page renders anything.

import type { PilotRole } from '@/src/server/pilot/contracts';

import AdminSystemPage from './page';

const principal: { role: PilotRole | null } = { role: 'platform_owner' };

jest.mock('next/headers', () => ({
  headers: async () => new Headers(),
}));

jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: async () =>
    principal.role
      ? { accountId: 'acct_1', organizationId: 'org_1', role: principal.role, mustChangePin: false }
      : null,
}));

test('the platform owner gets the page', async () => {
  principal.role = 'platform_owner';
  await expect(AdminSystemPage()).resolves.toBeTruthy();
});

test.each(['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'board', 'staff', 'volunteer'] as PilotRole[])(
  'a %s is sent away before anything renders',
  async (role) => {
    principal.role = role;
    await expect(AdminSystemPage()).rejects.toThrow(/NEXT_REDIRECT/);
  },
);

test('a visitor with no session is sent to sign in', async () => {
  principal.role = null;
  await expect(AdminSystemPage()).rejects.toThrow('NEXT_REDIRECT /login');
});
