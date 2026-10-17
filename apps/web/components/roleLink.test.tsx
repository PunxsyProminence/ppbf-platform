/**
 * @jest-environment jsdom
 */

// Lane U2 (audit UX-A A-5): a link to a page renders only for the roles that
// page admits, using the gate's own check.

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import RoleLink from './RoleLink';
import { clearRoleSession, createPersistentRoleSession } from './roleSession';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

afterEach(() => {
  clearRoleSession();
});

async function renderAs(role: Parameters<typeof createPersistentRoleSession>[0] | null) {
  if (role) createPersistentRoleSession(role);
  await act(async () => {
    render(
      <RoleLink href="/admin/compliance-center" roles={['admin']}>
        Compliance Center
      </RoleLink>,
    );
  });
}

test('an admitted role sees the link', async () => {
  await renderAs('admin');
  expect(screen.getByRole('link', { name: 'Compliance Center' }).getAttribute('href')).toBe('/admin/compliance-center');
});

test.each(['coach', 'platform_owner', 'athlete'] as const)('a %s, whom the page refuses, sees nothing', async (role) => {
  await renderAs(role);
  expect(screen.queryByRole('link')).toBeNull();
});

test('nothing renders while the session is unknown', async () => {
  await renderAs(null);
  expect(screen.queryByRole('link')).toBeNull();
});
