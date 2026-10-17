/**
 * @jest-environment jsdom
 */

// /coach/parent-resources (PH-11b): the page puts the staff panel behind
// RoleSessionGate, and the gate's own admission rule (isRoleSessionAllowed)
// over the roles the page passes it admits coaches and organization admins
// ('admin' is the client spelling of organization_admin) and no one else. The
// building map offers the door to the same roles. The gate's session reading
// is its own suite's; here it is replaced, so only the roles are checked.

import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachParentResourcesPage from './page';
import { visibleDoors } from '@/components/buildingMap';
import { isRoleSessionAllowed, mapPilotRoleToClubRole, type RoleSession } from '@/components/roleSession';

const gateRoles: string[][] = [];
jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children, allowedRoles }: { readonly children: ReactNode; readonly allowedRoles: string[] }) => {
    gateRoles.push(allowedRoles);
    return <div data-testid="gate">{children}</div>;
  },
}));
jest.mock('@/components/ParentResourcesStaff', () => ({
  __esModule: true,
  default: () => <div data-testid="staff-panel" />,
}));

const hasDoor = (role: string) =>
  visibleDoors(mapPilotRoleToClubRole(role)).some((d) => d.href === '/coach/parent-resources' && d.label === 'Parent Resources');

function admitted(role: string): boolean {
  const club = mapPilotRoleToClubRole(role);
  if (club === null) return false;
  render(<CoachParentResourcesPage />);
  return isRoleSessionAllowed({ role: club } as RoleSession, gateRoles[gateRoles.length - 1] as RoleSession['role'][]);
}

test('the staff panel is rendered only inside the gate', () => {
  render(<CoachParentResourcesPage />);
  expect(screen.getByRole('heading', { level: 1, name: 'Parent Resources' })).toBeInTheDocument();
  expect(screen.getByTestId('gate')).toContainElement(screen.getByTestId('staff-panel'));
});

test.each(['coach', 'organization_admin'])('%s is admitted by the gate and offered the door', (role) => {
  expect(admitted(role)).toBe(true);
  expect(hasDoor(role)).toBe(true);
});

test.each(['parent', 'athlete', 'platform_owner'])('%s is neither admitted by the gate nor offered the door', (role) => {
  expect(admitted(role)).toBe(false);
  expect(hasDoor(role)).toBe(false);
});
