/**
 * @jest-environment jsdom
 */

// Lane AS4-4D4E (AS-4 part 4d). Retro Lab's "Home" went to the public front
// page (app scrub BOA-10), and it offered a "Login" plate to readers who are
// all signed in: its gate admits only admins and the platform owner (BOA-22;
// Q1 = A on #2128).

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import RetroLabPage from './page';
import { backHomeTarget } from '@/components/BackHome';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

afterEach(() => {
  act(() => clearRoleSession());
});

test.each(['admin', 'platform_owner'] as const)('a %s is offered their own home and no sign-in link', async (role) => {
  const session = createPersistentRoleSession(role);
  await act(async () => {
    render(<RetroLabPage />);
  });

  const { href, label } = backHomeTarget(session);
  expect(href).not.toBe('/');
  expect(screen.getByRole('link', { name: label }).getAttribute('href')).toBe(href);
  const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
  expect(hrefs).not.toContain('/login');
  expect(hrefs).not.toContain('/');
  expect(screen.queryByRole('link', { name: 'Login' })).toBeNull();
});
