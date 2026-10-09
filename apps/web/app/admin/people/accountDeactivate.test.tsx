/**
 * @jest-environment jsdom
 */

/**
 * Switching a departed coach, staff member or volunteer off (Jason
 * 2026-10-07, OD-2026-10-07-009, "Yes, org admin can").
 *
 * The control is offered only where the server will say yes -- coach, staff,
 * volunteer -- so an admin never meets a button that always refuses. It is
 * armed, because a stray tap locks a colleague out, and the arming text says
 * what it does: sessions end now and sign-in is refused until reactivated.
 * A deactivated row carries the one-press way back.
 */

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import PeopleConsolePage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/usePilotSession', () => ({
  usePilotSession: () => ({ loading: false, role: 'organization_admin', accountId: 'admin-1' }),
  isOrganizationAdminSessionRole: () => true,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const originalFetch = global.fetch;

function member(accountId: string, role: string, overrides: Record<string, unknown> = {}) {
  return {
    account_id: accountId,
    login_email: accountId,
    auth_provider: 'microsoft',
    role,
    athlete_id: null,
    active_flag: true,
    has_pin: false,
    membership_active: true,
    ...overrides,
  };
}

const MEMBERS = [
  member('admin-1', 'organization_admin'),
  member('coach@example.com', 'coach'),
  member('staff@example.com', 'staff'),
  member('volunteer@example.com', 'volunteer'),
  member('parent@example.com', 'parent'),
  member('gone@example.com', 'coach', { active_flag: false, membership_active: false }),
];

interface Options {
  onStatus?: (body: Record<string, unknown>) => { ok: boolean; status?: number; error?: string };
}

function installFetch(options: Options = {}): jest.Mock {
  let members = MEMBERS;
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/pilot/admin/accounts/deactivate')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { account_id: string; active_flag: boolean };
      const outcome = options.onStatus?.(body) ?? { ok: true };
      if (outcome.ok) {
        // What the server now holds, for the re-read.
        members = members.map((m) => (m.account_id === body.account_id
          ? { ...m, active_flag: body.active_flag, membership_active: body.active_flag }
          : m));
      }
      return {
        ok: outcome.ok,
        status: outcome.status ?? (outcome.ok ? 200 : 400),
        json: async () => (outcome.ok ? { ok: true, account_id: body.account_id, active_flag: body.active_flag } : { error: outcome.error }),
      } as Response;
    }
    if (url.includes('/api/pilot/admin/athlete-pin-directory')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) } as Response;
    }
    if (url.includes('/api/pilot/admin/staff')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, organization_id: 'org-1', members, guardian_links: [] }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  global.fetch = mock as never;
  return mock;
}

async function renderConsole(options: Options = {}): Promise<jest.Mock> {
  const mock = installFetch(options);
  render(<PeopleConsolePage />);
  await screen.findByText('coach@example.com');
  return mock;
}

function statusCalls(mock: jest.Mock): Array<[string, RequestInit]> {
  return mock.mock.calls.filter(([url]) => String(url).includes('/accounts/deactivate')) as Array<[string, RequestInit]>;
}

function rowOf(accountId: string): HTMLElement {
  // The id can also appear in a banner above the table (a guardian with no
  // links is listed there); the register row is the one inside a <tr>.
  const row = screen.getAllByText(accountId).map((node) => node.closest('tr')).find((tr) => tr !== null);
  if (!row) throw new Error(`no register row for ${accountId}`);
  return row as HTMLElement;
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('where the switch is offered', () => {
  it('is offered on coach, staff and volunteer rows, and on nobody else', async () => {
    await renderConsole();

    for (const accountId of ['coach@example.com', 'staff@example.com', 'volunteer@example.com']) {
      expect(within(rowOf(accountId)).getByRole('button', { name: `Deactivate ${accountId}` })).not.toBeNull();
    }
    // An admin (the caller, or a peer) and a guardian have no switch here.
    expect(within(rowOf('admin-1')).queryByRole('button', { name: /Deactivate|Reactivate/ })).toBeNull();
    expect(within(rowOf('parent@example.com')).queryByRole('button', { name: /Deactivate|Reactivate/ })).toBeNull();
  });

  it('a deactivated row shows the way back instead', async () => {
    await renderConsole();

    const row = rowOf('gone@example.com');
    expect(within(row).getByText('Deactivated')).not.toBeNull();
    expect(within(row).getByRole('button', { name: 'Reactivate gone@example.com' })).not.toBeNull();
    expect(within(row).queryByRole('button', { name: /^Deactivate/ })).toBeNull();
  });
});

describe('it asks before locking a colleague out', () => {
  it('sends nothing on the first press and says what the second will do', async () => {
    const mock = await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate coach@example.com' }));

    expect(statusCalls(mock)).toHaveLength(0);
    expect(screen.getByText(/signed out on every device, and their sign-in is refused until you reactivate them/)).not.toBeNull();
    expect(screen.getByText(/Nothing else about them changes/)).not.toBeNull();
  });

  it('backs out without sending', async () => {
    const mock = await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate coach@example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep Active' }));

    expect(statusCalls(mock)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Deactivate coach@example.com' })).not.toBeNull();
  });
});

describe('deactivating', () => {
  it('posts account_id with active_flag false, re-reads, and the row reads Deactivated with Reactivate offered', async () => {
    const mock = await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate coach@example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Deactivate' }));

    await waitFor(() => expect(statusCalls(mock)).toHaveLength(1));
    const [, init] = statusCalls(mock)[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ account_id: 'coach@example.com', active_flag: false });

    expect(await screen.findByText(/coach@example.com is deactivated: signed out on every device/)).not.toBeNull();
    await waitFor(() => {
      const row = rowOf('coach@example.com');
      expect(within(row).getByText('Deactivated')).not.toBeNull();
      expect(within(row).getByRole('button', { name: 'Reactivate coach@example.com' })).not.toBeNull();
    });
    // Never the heavier siblings.
    expect(mock.mock.calls.some(([url]) => String(url).includes('/accounts/pin-reset'))).toBe(false);
    expect(mock.mock.calls.some(([url]) => String(url).includes('/accounts/revoke'))).toBe(false);
  });

  it("a refusal is shown in the server's words and claims nothing", async () => {
    await renderConsole({
      onStatus: () => ({ ok: false, status: 403, error: 'Forbidden: an organization admin can deactivate coach, staff or volunteer accounts only; this account is organization_admin' }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate coach@example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Deactivate' }));

    expect(await screen.findByText(/this account is organization_admin/)).not.toBeNull();
    expect(screen.queryByText(/is deactivated: signed out/)).toBeNull();
    expect(within(rowOf('coach@example.com')).queryByText('Deactivated')).toBeNull();
  });
});

describe('reactivating', () => {
  it('posts active_flag true in one press and the row reads active again', async () => {
    const mock = await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: 'Reactivate gone@example.com' }));

    await waitFor(() => expect(statusCalls(mock)).toHaveLength(1));
    expect(JSON.parse(String(statusCalls(mock)[0][1].body))).toEqual({ account_id: 'gone@example.com', active_flag: true });
    expect(await screen.findByText('gone@example.com is active again and can sign in.')).not.toBeNull();
    await waitFor(() => {
      expect(within(rowOf('gone@example.com')).queryByText('Deactivated')).toBeNull();
      expect(within(rowOf('gone@example.com')).getByRole('button', { name: 'Deactivate gone@example.com' })).not.toBeNull();
    });
  });
});
