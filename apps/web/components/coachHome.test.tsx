/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from '@testing-library/react';

import RoleStandaloneView from './RoleStandaloneView';
import { BUILDING, searchDoors } from './buildingMap';
import { getPilotRoleDestination } from '@/src/shared/pilotRoleRouting';

/* #1482 item 6. A coach signs in and lands on getPilotRoleDestination('coach').
 * That page's header read "Intake Router" (its building-map label) and it
 * printed its own address, "/coach/environment/intake-router", in the route
 * chip under "Coach Workspace". Wording PROPOSED: "Coach Workspace". */

// One router object for the file: a fresh one per render loops RoleSessionGate
// (see roleStandaloneBreadcrumbs.test.tsx for the full note).
const router = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => router }));
jest.mock('./ShadowChatButton', () => ({ __esModule: true, default: () => null }));

beforeEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ authenticated: true, role: 'coach', auth_provider: 'microsoft' }),
  })) as unknown as typeof fetch;
});

const HOME = getPilotRoleDestination('coach') as string;

describe('the coach home', () => {
  it('is named Coach Workspace in the building map, and still found by the old words', () => {
    const door = BUILDING.find((candidate) => candidate.href === HOME);
    expect(door?.label).toBe('Coach Workspace');
    expect(searchDoors('coach', 'intake router').map((found) => found.href)).toContain(HOME);
    expect(searchDoors('coach', 'home').map((found) => found.href)).toContain(HOME);
  });

  it('does not print its own address when asked not to', async () => {
    render(
      <RoleStandaloneView roleLabel="Coach Workspace" routeLabel={HOME} allowedRoles={['coach']} showRouteLabel={false}>
        <p>body</p>
      </RoleStandaloneView>,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Coach Workspace' })).toBeTruthy());
    expect(screen.queryByText(HOME)).toBeNull();
  });

  it('every other page still shows its route chip: the default is unchanged', async () => {
    render(
      <RoleStandaloneView roleLabel="Coach" routeLabel="/coach/review-queue" allowedRoles={['coach']}>
        <p>body</p>
      </RoleStandaloneView>,
    );
    await waitFor(() => expect(screen.getByText('/coach/review-queue')).toBeTruthy());
  });
});
