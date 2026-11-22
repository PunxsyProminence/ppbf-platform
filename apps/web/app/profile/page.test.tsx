/**
 * @jest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import ProfilePage from './page';

/* The shell is replaced by one that prints the props this page hands it, so
   the test reads the page's own choices, not RoleStandaloneView's. */
jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: (props: { roleLabel: string; showRouteLabel?: boolean; breadcrumbs?: Array<{ label: string }>; children: ReactNode }) => (
    <div data-role-label={props.roleLabel} data-route-chip={String(props.showRouteLabel ?? true)} data-crumbs={(props.breadcrumbs ?? []).map((c) => c.label).join('|')}>
      {props.children}
    </div>
  ),
}));
jest.mock('@/components/ProfileSettings', () => ({ __esModule: true, default: () => <p>settings</p> }));

/* Lane AS-8 (Overwatch Q11 A and ATH-26 on #2020; Jason, OW27-11 A,
   OD-2026-11-20-001): /profile is titled "Your Profile", and it shows no
   route chip. */
test('/profile is "Your Profile" in its title and its breadcrumb, with no route chip', () => {
  const { container } = render(<ProfilePage />);
  const shell = container.firstElementChild as HTMLElement;
  expect(shell.getAttribute('data-role-label')).toBe('Your Profile');
  expect(shell.getAttribute('data-crumbs')).toBe('Your Profile');
  expect(shell.getAttribute('data-route-chip')).toBe('false');
  expect(screen.getByText('settings')).toBeTruthy();
});
