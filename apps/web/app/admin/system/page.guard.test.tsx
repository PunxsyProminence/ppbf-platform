/**
 * @jest-environment node
 */

// Who may open /admin/system (WO-N7-03, N7-03-Q1 A), through the real page guard: the platform
// owner gets the platform view and reads no gym data; a gym's organization admin (or legacy admin)
// gets that gym's view and nothing else; every other role is sent away before anything is read.

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

const gymReads = {
  findings: jest.fn<Promise<unknown[]>, unknown[]>(async () => []),
  citations: jest.fn<Promise<unknown[]>, unknown[]>(async () => []),
  retractions: jest.fn<Promise<unknown[]>, unknown[]>(async () => []),
};

jest.mock('@/src/server/pilot/localFindings', () => ({
  listLocalFindings: (...args: unknown[]) => gymReads.findings(...args),
}));
jest.mock('@/src/server/pilot/sourceCitationChecks', () => ({
  getSourceCitationStatus: (...args: unknown[]) => gymReads.citations(...args),
}));
jest.mock('@/src/server/pilot/sourceRetractionChecks', () => ({
  getSourceRetractionStatus: (...args: unknown[]) => gymReads.retractions(...args),
}));

beforeEach(() => {
  Object.values(gymReads).forEach((read) => read.mockClear());
});

function rendersGymView(element: unknown): boolean {
  const props = (element as { props?: Record<string, unknown> }).props ?? {};
  return 'organizationId' in props;
}

test('the platform owner gets the platform view and no gym read runs', async () => {
  principal.role = 'platform_owner';
  const element = await AdminSystemPage();
  expect(rendersGymView(element)).toBe(false);
  expect(gymReads.findings).not.toHaveBeenCalled();
  expect(gymReads.citations).not.toHaveBeenCalled();
  expect(gymReads.retractions).not.toHaveBeenCalled();
});

test.each(['organization_admin', 'admin'] as PilotRole[])('a gym %s gets that gym\'s view only', async (role) => {
  principal.role = role;
  const element = await AdminSystemPage();
  expect(rendersGymView(element)).toBe(true);
  expect((element as { props: { organizationId: string } }).props.organizationId).toBe('org_1');
});

test.each(['coach', 'athlete', 'parent', 'board', 'staff', 'volunteer'] as PilotRole[])(
  'a %s is sent away before anything renders',
  async (role) => {
    principal.role = role;
    await expect(AdminSystemPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(gymReads.findings).not.toHaveBeenCalled();
  },
);

test('a visitor with no session is sent to sign in', async () => {
  principal.role = null;
  await expect(AdminSystemPage()).rejects.toThrow('NEXT_REDIRECT /login');
});
