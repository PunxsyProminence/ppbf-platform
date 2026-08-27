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

/* THE OPERATIONS CONTROL, WHICH HAD NO COVERAGE AT ALL.

   It sat on this bar unconditionally -- every signed-in role, every route,
   one tab stop from Logout -- while the Triage link directly above it was
   already role-scoped. The owner decision of 2026-08-26 makes the hub
   administration, so for fourteen of the sixteen roles this control's only
   outcome was a redirect back to the dashboard they came from, with nothing
   said about why.

   Written as the same admitted/refused pair as Triage on purpose: these two
   controls sit beside each other and now answer the same shape of question,
   so a future reader can see at a glance that both are scoped. */
it.each(['admin', 'platform_owner'])('offers %s the Operations hub', (role) => {
  renderAs(role);

  const link = screen.getByRole('link', { name: 'Operations' }) as HTMLAnchorElement;
  expect(link.getAttribute('href')).toBe('/operations');
});

it.each(['athlete', 'parent', 'coach', 'volunteer', 'staff', 'board'])(
  'does not offer %s a control that would only bounce them',
  (role) => {
    renderAs(role);

    expect(screen.queryByRole('link', { name: 'Operations' })).toBeNull();
  },
);

it('offers a signed-out visitor nothing of the kind', () => {
  renderAs(null);

  expect(screen.queryByRole('link', { name: 'Operations' })).toBeNull();
});

/* The bar still has to be a bar. Removing a control from a row is exactly the
   change that quietly takes its neighbours with it, and Bell is the one exit
   every refused role still needs. */
it.each(['athlete', 'coach', 'parent', 'staff', 'volunteer', 'board'])(
  'still gives %s the rest of the session bar',
  (role) => {
    renderAs(role);

    expect(screen.getByRole('link', { name: 'Bell' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Logout' })).toBeTruthy();
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
        expect.anything(),
      );
    });

    // No explicit method: the endpoint only implements POST (RoleSessionGate
    // learned this the hard way -- see its fix for the 405-as-"logged out"
    // incident), and loadAuthoritativeRoleSession defaults to POST when the
    // caller doesn't override it.
    expect(mockLoadAuthoritative.mock.calls[0][1]).not.toHaveProperty('method');

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

/* ==========================================================================
   P0.2 — A REFUSAL IS THE WHOLE SCREEN

   docs/shadow-ui/PRODUCTION-FAST-TRACK.md: the SHADOW deny screen is "Title +
   body + Dashboard + Logout only -- no library, no mode badge, no chat, no
   Master Mode". app/shadow/page.tsx renders exactly that, and this bar used to
   overrule it from above: the full signed-in chassis sat on top of every
   refusal, including the Corridor -- which opens a `room--board` panel naming
   every board door a board member holds, the "Board chrome on deny"
   ROOM-PURPOSE-DNA.md forbids -- plus a second Dashboard (labelled Bell) and a
   second Logout beside the two the refusal already offers.

   Nothing guarded any of this before these tests.
   ========================================================================== */

describe('the deny screen keeps this bar out of it', () => {
  it('offers a refused session nothing at all to press', () => {
    mockUsePathname.mockReturnValue('/shadow');
    renderAs('board');

    // The mark, and nothing else. Not a second Dashboard, not a second Logout.
    expect(screen.getByText('PPBF')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('gives it no corridor, so no board door is named on a deny', () => {
    mockUsePathname.mockReturnValue('/shadow');
    renderAs('board');

    expect(screen.queryByRole('button', { name: /after hours/i })).toBeNull();
    expect(screen.queryByText('board')).toBeNull();
  });

  it.each(['tell us', 'jump', 'sound'])('drops the %s control too', (label) => {
    mockUsePathname.mockReturnValue('/shadow');
    renderAs('board');

    expect(screen.queryByRole('button', { name: new RegExp(label, 'i') })).toBeNull();
  });

  // The two halves of "only on a refusal". Either one failing means the branch
  // has become route-wide or role-wide, and somebody has lost their session bar
  // on a working surface -- the exact bug the self-heal effect above exists for.
  it('leaves the full bar alone for a role SHADOW admits, on the same route', () => {
    mockUsePathname.mockReturnValue('/shadow');
    renderAs('coach');

    expect(screen.getByRole('button', { name: 'Logout' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /after hours/i })).toBeTruthy();
  });

  it('leaves the full bar alone for the board everywhere the board belongs', () => {
    mockUsePathname.mockReturnValue('/board');
    renderAs('board');

    expect(screen.getByRole('button', { name: 'Logout' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Bell' })).toBeTruthy();
  });

  it('is not fooled by a route the map has never heard of', () => {
    mockUsePathname.mockReturnValue('/nowhere-at-all');
    renderAs('board');

    expect(screen.getByRole('button', { name: 'Logout' })).toBeTruthy();
  });
});
