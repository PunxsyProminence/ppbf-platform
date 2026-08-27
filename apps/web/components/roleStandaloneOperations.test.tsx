/**
 * @jest-environment jsdom
 */

/**
 * THE OPERATIONS CONTROL ON THE STANDALONE BAND.
 *
 * This shell wraps roughly 68 role routes, and it carried an unconditional
 * link to the Operations hub. That put an Operations control on an athlete's
 * every screen and a parent's every screen -- and after the owner decision of
 * 2026-08-26 it led somewhere that answers a refused role with a silent
 * redirect back to the dashboard they started from.
 *
 * The band reads the VIEWER's role for this, not the `allowedRoles` it was
 * handed: that prop is the set the wrapped page admits, so on a page open to
 * both a coach and an admin it would answer "yes, show it" to the coach. These
 * tests drive the real RoleSessionGate through a stubbed session endpoint, so
 * the role under test is the one the server reports.
 *
 * Lives in its own file rather than in roleStandaloneBreadcrumbs.test.tsx
 * because that file is about the trail; the two share a shell and nothing
 * else.
 */

import { render, screen, waitFor } from '@testing-library/react';

import RoleStandaloneView from './RoleStandaloneView';
import type { ClubRole } from './roleRoutes';
import { clearRoleSession } from './roleSession';

/* ONE router object for the life of the file. RoleSessionGate's effect depends
   on [router], and this shell now subscribes to the role-session store, so a
   fresh object per render closes a persist -> notify -> render loop and hangs
   the suite with no output. See the same note in
   roleStandaloneBreadcrumbs.test.tsx. */
const router = { push: jest.fn(), replace: jest.fn() };

jest.mock('next/navigation', () => ({
  useRouter: () => router,
}));

// The chat launcher opens a socket that has nothing to do with this band.
jest.mock('./ShadowChatButton', () => ({
  __esModule: true,
  default: () => null,
}));

const originalFetch = global.fetch;

function serverSays(role: ClubRole) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ authenticated: true, role, auth_provider: 'microsoft' }),
  })) as unknown as typeof fetch;
}

/** Rendered inside the shell, admitting the role under test so the gate opens. */
async function renderBandAs(role: ClubRole) {
  serverSays(role);
  render(
    <RoleStandaloneView
      roleLabel="Coach"
      routeLabel="Session Scripts"
      allowedRoles={['coach', 'admin', 'platform_owner', 'athlete', 'parent', 'staff', 'volunteer', 'board']}
    >
      <p>the page itself</p>
    </RoleStandaloneView>,
  );
  // Past the gate's holding screen: the band only exists once children mount.
  await waitFor(() => expect(screen.getByText('the page itself')).toBeTruthy());
}

afterEach(() => {
  global.fetch = originalFetch;
  clearRoleSession();
  jest.clearAllMocks();
});

const ADMITTED: ClubRole[] = ['admin', 'platform_owner'];
const REFUSED: ClubRole[] = ['athlete', 'coach', 'parent', 'staff', 'volunteer', 'board'];

it('names both sides, so neither table below runs over an empty list', () => {
  expect(ADMITTED.length).toBeGreaterThan(0);
  expect(REFUSED.length).toBeGreaterThan(0);
});

it.each(ADMITTED)('offers %s the Operations link', async (role) => {
  await renderBandAs(role);

  const link = screen.getByRole('link', { name: 'Operations' }) as HTMLAnchorElement;
  expect(link.getAttribute('href')).toBe('/operations');
});

it.each(REFUSED)('does not offer %s a control that would only bounce them', async (role) => {
  await renderBandAs(role);

  expect(screen.queryByRole('link', { name: 'Operations' })).toBeNull();
});

/* The band still has to be a band. Removing one control from a row is exactly
   the change that quietly takes its neighbour with it, and Bell is the exit
   every refused role still has from here. */
it.each(REFUSED)('leaves %s the rest of the band', async (role) => {
  await renderBandAs(role);

  expect(screen.getByRole('link', { name: 'Bell' })).toBeTruthy();
  expect(screen.getByText('Session Scripts')).toBeTruthy();
});

/* The viewer's role decides, not the page's. A coach on a page that also
   admits admins must not inherit the admin's control -- which is what reading
   `allowedRoles` instead of the session would have done. */
it('reads the viewer, not the set of roles the wrapped page admits', async () => {
  await renderBandAs('coach');

  expect(screen.queryByRole('link', { name: 'Operations' })).toBeNull();
});
