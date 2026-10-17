/** @jest-environment jsdom */

// Gym Setup (lane L31 P5): the organization admin's own gym, read-only. Each
// line shows its state and links to the screen where the step is done.

import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const mockRequirePageRole = jest.fn();
const mockReadGymSetupStatus = jest.fn();
jest.mock('@/src/server/pilot/pageGuard', () => ({ requirePageRole: (...args: unknown[]) => mockRequirePageRole(...args) }));
jest.mock('@/src/server/pilot/gymSetupStatus', () => ({ readGymSetupStatus: (...args: unknown[]) => mockReadGymSetupStatus(...args) }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));

import GymSetupPage from './page';

beforeEach(() => {
  mockRequirePageRole.mockReset().mockResolvedValue({ organizationId: 'gym-1', role: 'organization_admin', accountId: 'admin-1' });
  mockReadGymSetupStatus.mockReset();
});

test('only the organization admin, for their own gym', async () => {
  mockReadGymSetupStatus.mockResolvedValue([]);
  render(await GymSetupPage());
  expect(mockRequirePageRole).toHaveBeenCalledWith(['organization_admin']);
  expect(mockReadGymSetupStatus).toHaveBeenCalledWith('gym-1');
});

test('each step shows its state, what the records say, and the screen where it is done', async () => {
  mockReadGymSetupStatus.mockResolvedValue([
    { key: 'admin-sign-in', title: 'Gym admin sign-in', state: 'manual', detail: 'Done outside the app.', href: '/admin/people', linkLabel: 'People' },
    { key: 'coaches', title: 'At least one coach', state: 'done', detail: '2 active coaches.', href: '/admin/people', linkLabel: 'Add a coach' },
    { key: 'class', title: 'A class on the schedule', state: 'to_do', detail: 'No upcoming class yet.', href: '/schedule', linkLabel: 'Schedule a class' },
    { key: 'tv', title: 'A gym TV paired', state: 'unavailable', detail: 'This could not be read just now.', href: '/coach/environment/intake-router', linkLabel: 'Coach workspace' },
  ]);
  render(await GymSetupPage());

  expect(screen.getByText('2 steps are left. Each line says what the records show now and links to the screen where it is done.')).toBeTruthy();
  const steps = within(screen.getByRole('list', { name: 'Setup steps' })).getAllByRole('listitem');
  expect(steps.map((step) => step.getAttribute('data-state'))).toEqual(['manual', 'done', 'to_do', 'unavailable']);
  expect(within(steps[0]).getByText('Outside the app')).toBeTruthy();
  expect(within(steps[1]).getByText('Done')).toBeTruthy();
  expect(within(steps[2]).getByText('To do')).toBeTruthy();
  expect(within(steps[3]).getByText('Could not read')).toBeTruthy();
  expect(within(steps[2]).getByRole('link', { name: 'Schedule a class' }).getAttribute('href')).toBe('/schedule');
  // Read-only: nothing on the page writes.
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(document.querySelectorAll('form')).toHaveLength(0);
});

test('with every step done or outside the app, it says so', async () => {
  mockReadGymSetupStatus.mockResolvedValue([
    { key: 'admin-sign-in', title: 'Gym admin sign-in', state: 'manual', detail: 'x', href: '/admin/people', linkLabel: 'People' },
    { key: 'coaches', title: 'At least one coach', state: 'done', detail: 'x', href: '/admin/people', linkLabel: 'Add a coach' },
  ]);
  render(await GymSetupPage());
  expect(screen.getByText('Every step below is done, or is done outside the app.')).toBeTruthy();
});
