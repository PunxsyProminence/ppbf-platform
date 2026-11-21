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
    { key: 'tv', title: 'A gym TV paired', state: 'unavailable', detail: 'This could not be read just now.', href: null, linkLabel: null },
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
  // A step with no screen for the gym admin shows no link.
  expect(within(steps[3]).queryAllByRole('link')).toHaveLength(0);
  // Read-only outside the gym TV panel: every control and form on the page
  // sits inside that one panel, in the TV line.
  const panel = within(steps[3]).getByRole('region', { name: 'Gym TVs' });
  for (const button of screen.queryAllByRole('button')) expect(panel.contains(button)).toBe(true);
  for (const form of Array.from(document.querySelectorAll('form'))) expect(panel.contains(form)).toBe(true);
});

/* OFF-02 (lane SH): the office pairs a TV on this page. The existing gym TV
   panel sits inside the TV line only, closed until opened (it reads nothing
   on render), and sends no session from here. */
test('the TV line holds the gym TV panel, closed, with no session controls; no other line does', async () => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  mockReadGymSetupStatus.mockResolvedValue([
    { key: 'coaches', title: 'At least one coach', state: 'done', detail: '2 active coaches.', href: '/admin/people', linkLabel: 'Add a coach' },
    { key: 'tv', title: 'A gym TV paired', state: 'optional', detail: 'No TV paired. Pair one here, or a coach pairs one from the coach workspace.', href: null, linkLabel: null },
  ]);
  render(await GymSetupPage());

  const steps = within(screen.getByRole('list', { name: 'Setup steps' })).getAllByRole('listitem');
  expect(within(steps[0]).queryByRole('region', { name: 'Gym TVs' })).toBeNull();
  const panel = within(steps[1]).getByRole('region', { name: 'Gym TVs' });
  expect(within(panel).getByRole('button', { name: 'Open Gym TVs' })).toBeTruthy();
  expect(within(panel).getByText(/Coaches put a live session on a TV from the coach workspace\./)).toBeTruthy();
  expect(within(panel).queryByText(/your live session/)).toBeNull();
  expect(screen.getAllByRole('region', { name: 'Gym TVs' })).toHaveLength(1);
  // Closed until opened: nothing is read on render.
  expect(global.fetch).not.toHaveBeenCalled();
});

test('with every step done or outside the app, it says so', async () => {
  mockReadGymSetupStatus.mockResolvedValue([
    { key: 'admin-sign-in', title: 'Gym admin sign-in', state: 'manual', detail: 'x', href: '/admin/people', linkLabel: 'People' },
    { key: 'coaches', title: 'At least one coach', state: 'done', detail: 'x', href: '/admin/people', linkLabel: 'Add a coach' },
    { key: 'tv', title: 'A gym TV paired', state: 'optional', detail: 'x', href: null, linkLabel: null },
  ]);
  render(await GymSetupPage());
  expect(screen.getByText('Every step below is done, optional, or done outside the app.')).toBeTruthy();
  expect(screen.getByText('Optional')).toBeTruthy();
});

// Lane AS-10 (OFF-09; Overwatch Q6 A): a step whose work is split over two
// screens shows both links, and a step with one shows one.
test('a step with a second screen shows both links, in order; other steps show one', async () => {
  mockReadGymSetupStatus.mockResolvedValue([
    { key: 'coaches', title: 'At least one coach', state: 'done', detail: '2 active coaches.', href: '/admin/people?tab=invite-staff', linkLabel: 'Add a coach' },
    {
      key: 'guardians',
      title: 'A guardian for every athlete under 18',
      state: 'to_do',
      detail: '1 athlete under 18 has no guardian on file.',
      href: '/admin/people?tab=invite-staff',
      linkLabel: 'Add a guardian',
      alsoHref: '/admin/athlete-consent',
      alsoLinkLabel: 'Media Consent Audit',
    },
  ]);
  render(await GymSetupPage());

  const steps = within(screen.getByRole('list', { name: 'Setup steps' })).getAllByRole('listitem');
  expect(within(steps[0]).getAllByRole('link').map((link) => link.textContent)).toEqual(['Add a coach']);
  const guardianLinks = within(steps[1]).getAllByRole('link');
  expect(guardianLinks.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Add a guardian', '/admin/people?tab=invite-staff'],
    ['Media Consent Audit', '/admin/athlete-consent'],
  ]);
});
