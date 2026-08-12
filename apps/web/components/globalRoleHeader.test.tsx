/**
 * @jest-environment jsdom
 */

// The header is where the comment box lives, because it is the one surface
// every signed-in person already has in front of them. Two things must stay
// true of it: the box reaches everyone, including a child on a PIN session, and
// the triage link reaches only the people who work that queue.

import type { ReactNode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

import { usePathname } from 'next/navigation';

import GlobalRoleHeader from './GlobalRoleHeader';
import { getRoleSessionSnapshot, loadAuthoritativeRoleSession, persistAuthoritativeRoleSession } from './roleSession';

const mockUsePathname = usePathname as jest.MockedFunction<typeof usePathname>;

jest.mock('next/navigation', () => ({
  usePathname: jest.fn(() => '/dashboard'),
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
  loadAuthoritativeRoleSession: jest.fn(),
  persistAuthoritativeRoleSession: jest.fn(),
}));

const mockSnapshot = getRoleSessionSnapshot as jest.MockedFunction<typeof getRoleSessionSnapshot>;
const mockLoadAuthoritative = loadAuthoritativeRoleSession as jest.MockedFunction<typeof loadAuthoritativeRoleSession>;
const mockPersistAuthoritative = persistAuthoritativeRoleSession as jest.MockedFunction<typeof persistAuthoritativeRoleSession>;

function renderAs(role: string | null) {
  mockSnapshot.mockReturnValue(
    role === null ? null : ({ role, expiresAt: Date.now() + 60_000 } as never),
  );
  render(<GlobalRoleHeader />);
}

beforeEach(() => {
  mockUsePathname.mockReturnValue('/dashboard');
  // Every render with no cached session now fires the self-heal check (see
  // GlobalRoleHeader's effect). Defaulting it to a pending, never-resolving
  // promise keeps the existing "before anyone is signed in" tests exercising
  // exactly the pre-auth render they intend, rather than a real fetch.
  mockLoadAuthoritative.mockReturnValue(new Promise(() => {}));
});

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

// Regression coverage for the bug this branch fixes: the Logout button used
// to depend entirely on some OTHER component (RoleSessionGate, /login's own
// effect) having already populated the shared in-memory cache. A page
// without that gate left the bar stuck on the pre-auth look forever, even
// with a perfectly valid server session -- "no logout button" with no way
// to sign out short of already knowing to revisit /login.
describe('self-heal against the server when no session is cached', () => {
  it('asks the server directly, and persists what it finds', async () => {
    mockLoadAuthoritative.mockResolvedValue({
      ok: true,
      session: { role: 'coach', expiresAt: Date.now() + 60_000 },
      destination: '/coach/operations',
    });

    renderAs(null);

    await waitFor(() => {
      expect(mockLoadAuthoritative).toHaveBeenCalledWith(
        expect.stringContaining('/api/pilot/auth/session'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    await waitFor(() => {
      expect(mockPersistAuthoritative).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'coach' }),
      );
    });
  });

  it('does not persist anything when the server says unauthenticated', async () => {
    mockLoadAuthoritative.mockResolvedValue({ ok: false, reason: 'unauthenticated' });

    renderAs(null);

    await waitFor(() => {
      expect(mockLoadAuthoritative).toHaveBeenCalled();
    });

    expect(mockPersistAuthoritative).not.toHaveBeenCalled();
  });

  it('does not ask the server once a session is already cached', async () => {
    renderAs('athlete');

    // Give any stray microtask a turn, then confirm nothing fired.
    await act(async () => {});

    expect(mockLoadAuthoritative).not.toHaveBeenCalled();
  });

  it('does not ask the server while sitting on /login', async () => {
    mockUsePathname.mockReturnValue('/login');

    renderAs(null);

    await act(async () => {});

    expect(mockLoadAuthoritative).not.toHaveBeenCalled();
  });
});
