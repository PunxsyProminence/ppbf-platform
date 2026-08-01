/**
 * @jest-environment jsdom
 */

// The header is where the comment box lives, because it is the one surface
// every signed-in person already has in front of them. Two things must stay
// true of it: the box reaches everyone, including a child on a PIN session, and
// the triage link reaches only the people who work that queue.

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import GlobalRoleHeader from './GlobalRoleHeader';
import { getRoleSessionSnapshot } from './roleSession';

jest.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('./roleSession', () => ({
  getRoleSessionSnapshot: jest.fn(),
  subscribeRoleSession: () => () => {},
  clearRoleSession: jest.fn(),
}));

const mockSnapshot = getRoleSessionSnapshot as jest.MockedFunction<typeof getRoleSessionSnapshot>;

function renderAs(role: string | null) {
  mockSnapshot.mockReturnValue(
    role === null ? null : ({ role, expiresAt: Date.now() + 60_000 } as never),
  );
  render(<GlobalRoleHeader />);
}

afterEach(() => {
  jest.clearAllMocks();
});

it.each(['athlete', 'parent', 'coach', 'volunteer', 'staff', 'board', 'admin', 'platform_owner'])(
  'gives a signed-in %s the comment box',
  (role) => {
    renderAs(role);

    expect(screen.getByRole('button', { name: /tell us/i })).toBeTruthy();
  },
);

it('offers nothing to submit before anyone is signed in', () => {
  renderAs(null);

  expect(screen.queryByRole('button', { name: /tell us/i })).toBeNull();
});

it.each(['admin', 'platform_owner'])('links %s to the queue they work', (role) => {
  renderAs(role);

  const link = screen.getByRole('link', { name: 'Triage' }) as HTMLAnchorElement;
  expect(link.getAttribute('href')).toBe('/admin/feedback');
});

it.each(['athlete', 'parent', 'coach', 'volunteer', 'staff', 'board'])(
  'does not offer %s a way into other people submissions',
  (role) => {
    renderAs(role);

    expect(screen.queryByRole('link', { name: 'Triage' })).toBeNull();
  },
);
