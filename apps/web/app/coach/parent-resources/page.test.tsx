/**
 * @jest-environment jsdom
 */

// /coach/parent-resources (PH-11b): coaches and organization admins ('admin'
// is the client spelling of organization_admin) get the staff panel, and the
// building map offers them the door; parents and athletes are offered neither.

import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachParentResourcesPage from './page';
import { visibleDoors } from '@/components/buildingMap';
import { mapPilotRoleToClubRole } from '@/components/roleSession';

const gateRoles: string[][] = [];
jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children, allowedRoles }: { readonly children: ReactNode; readonly allowedRoles: string[] }) => {
    gateRoles.push(allowedRoles);
    return <>{children}</>;
  },
}));
jest.mock('@/components/ParentResourcesStaff', () => ({
  __esModule: true,
  default: () => <div data-testid="staff-panel" />,
}));

const hasDoor = (role: string) =>
  visibleDoors(mapPilotRoleToClubRole(role)).some((d) => d.href === '/coach/parent-resources' && d.label === 'Parent Resources');

test.each(['coach', 'organization_admin'])('%s gets the panel behind the gate and the door', (role) => {
  render(<CoachParentResourcesPage />);
  expect(screen.getByRole('heading', { level: 1, name: 'Parent Resources' })).toBeInTheDocument();
  expect(screen.getByTestId('staff-panel')).toBeInTheDocument();
  const club = mapPilotRoleToClubRole(role);
  expect(club).not.toBeNull();
  expect(gateRoles[gateRoles.length - 1]).toContain(club);
  expect(hasDoor(role)).toBe(true);
});

test.each(['parent', 'athlete'])('%s is neither admitted by the gate nor offered the door', (role) => {
  render(<CoachParentResourcesPage />);
  const club = mapPilotRoleToClubRole(role);
  expect(gateRoles[gateRoles.length - 1]).not.toContain(club);
  expect(hasDoor(role)).toBe(false);
});
