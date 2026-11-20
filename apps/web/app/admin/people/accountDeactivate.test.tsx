/**
 * @jest-environment jsdom
 */

/**
 * Switching a departed coach, staff member or volunteer off (Jason
 * 2026-10-07, OD-2026-10-07-009, "Yes, org admin can"), and an athlete the
 * same way (Jason 2026-11-19, OD-2026-11-19-025, "A: Add a switch").
 *
 * The control is offered only where the server will say yes -- coach, staff,
 * volunteer, and an athlete who has activated (holds a PIN) -- so an admin
 * never meets a button that always refuses. It is
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
  // Athlete logins: a PIN athlete who has activated, one waiting for their
  // code (active_flag false is "not activated yet"), and one switched off.
  member('athlete-on', 'athlete', { login_email: null, auth_provider: 'ppbf_local', athlete_id: 'ath-on', has_pin: true }),
  member('athlete-waiting', 'athlete', {
    login_email: null, auth_provider: 'ppbf_local', athlete_id: 'ath-waiting', has_pin: false, active_flag: false, membership_active: false,
  }),
  member('athlete-off', 'athlete', {
    login_email: null, auth_provider: 'ppbf_local', athlete_id: 'ath-off', has_pin: true, active_flag: false, membership_active: false,
  }),
  // One flag off without the other: still switched off, and read that way.
  member('athlete-off-account', 'athlete', {
    login_email: null, auth_provider: 'ppbf_local', athlete_id: 'ath-off-a', has_pin: true, active_flag: false, membership_active: true,
  }),
  member('athlete-off-membership', 'athlete', {
    login_email: null, auth_provider: 'ppbf_local', athlete_id: 'ath-off-m', has_pin: true, active_flag: true, membership_active: false,
  }),
];

type MemberRow = ReturnType<typeof member>;

interface Options {
  onStatus?: (body: Record<string, unknown>) => { ok: boolean; status?: number; error?: string };
  /** What the server holds after a refused switch (e.g. a PIN reset in another tab). */
  onRefused?: (rows: MemberRow[]) => MemberRow[];
}

/** Changes the server's rows from outside the page (another tab, the athlete redeeming a code). */
let serverChange: (change: (rows: MemberRow[]) => MemberRow[]) => void = () => {};

function installFetch(options: Options = {}): jest.Mock {
  let members: MemberRow[] = MEMBERS;
  serverChange = (change) => { members = change(members); };
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/pilot/admin/accounts/pin-reset')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { account_id: string };
      // The reset nulls the PIN and switches the login off until the code is redeemed.
      members = members.map((m) => (m.account_id === body.account_id
        ? { ...m, has_pin: false, active_flag: false, membership_active: false }
        : m));
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, activation_code: 'ABCD-EFGH-JKMN', expires_at: '2026-12-04T00:00:00.000Z' }),
      } as Response;
    }
    if (url.includes('/api/pilot/admin/accounts/deactivate')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { account_id: string; active_flag: boolean };
      const outcome = options.onStatus?.(body) ?? { ok: true };
      if (!outcome.ok && options.onRefused) members = options.onRefused(members);
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
    if (url.includes('/api/pilot/admin/accounts/revoke')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
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
  it('is offered on coach, staff and volunteer rows, and never on an admin or a guardian (athletes: below)', async () => {
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
      onStatus: () => ({ ok: false, status: 403, error: 'Forbidden: an organization admin can deactivate coach, staff, volunteer or athlete accounts only; this account is organization_admin' }),
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

/* ---- Athlete logins (OD-2026-11-19-025; Overwatch GO on lane SW, Q2 A) ---- */

describe('an athlete login', () => {
  it('gets the switch once activated, with the staff words, and none while awaiting activation', async () => {
    const mock = await renderConsole();

    const on = rowOf('athlete-on');
    expect(within(on).getByRole('button', { name: 'Deactivate athlete-on' })).not.toBeNull();
    expect(within(on).getByRole('button', { name: 'Issue New Activation Code' })).not.toBeNull();

    // No PIN yet: the server refuses both directions, so no switch is offered.
    const waiting = rowOf('athlete-waiting');
    expect(within(waiting).getByText('Awaiting activation')).not.toBeNull();
    expect(within(waiting).queryByRole('button', { name: /Deactivate|Reactivate/ })).toBeNull();
    expect(within(waiting).getByRole('button', { name: 'Issue New Activation Code' })).not.toBeNull();

    fireEvent.click(within(on).getByRole('button', { name: 'Deactivate athlete-on' }));
    expect(statusCalls(mock)).toHaveLength(0);
    expect(screen.getByText(
      'Deactivates athlete-on now: signed out on every device, and their sign-in is refused until you reactivate them. Nothing else about them changes.',
    )).not.toBeNull();
  });

  it.each(['athlete-off', 'athlete-off-account', 'athlete-off-membership'])('while switched off (%s), the row reads Deactivated and offers Reactivate, not Issue New Activation Code', async (accountId) => {
    await renderConsole();

    const off = rowOf(accountId);
    expect(within(off).getByText('Deactivated')).not.toBeNull();
    expect(within(off).getByRole('button', { name: `Reactivate ${accountId}` })).not.toBeNull();
    expect(within(off).queryByRole('button', { name: 'Issue New Activation Code' })).toBeNull();
    expect(within(off).queryByRole('button', { name: /^Deactivate/ })).toBeNull();
    // The switch already ended every session; the sign-out route refuses a
    // switched-off membership, and its "Their sign-in still works" would be false.
    expect(within(off).queryByRole('button', { name: `Sign ${accountId} out on every device` })).toBeNull();
    // A switched-off coach row is as it was (not this change's to alter).
    expect(within(rowOf('gone@example.com')).getByRole('button', { name: 'Sign gone@example.com out on every device' })).not.toBeNull();
  });

  it('deactivating posts the staff request; the re-read row reads Deactivated, with Reactivate in place of the code control', async () => {
    const mock = await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate athlete-on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Deactivate' }));

    await waitFor(() => expect(statusCalls(mock)).toHaveLength(1));
    expect(JSON.parse(String(statusCalls(mock)[0][1].body))).toEqual({ account_id: 'athlete-on', active_flag: false });
    expect(await screen.findByText(
      'athlete-on is deactivated: signed out on every device, and sign-in is refused until you reactivate them.',
    )).not.toBeNull();
    await waitFor(() => {
      const row = rowOf('athlete-on');
      expect(within(row).getByText('Deactivated')).not.toBeNull();
      expect(within(row).getByRole('button', { name: 'Reactivate athlete-on' })).not.toBeNull();
      expect(within(row).queryByRole('button', { name: 'Issue New Activation Code' })).toBeNull();
      expect(within(row).queryByRole('button', { name: 'Sign athlete-on out on every device' })).toBeNull();
    });
    // Never the activation-code reset as a side effect.
    expect(mock.mock.calls.some(([url]) => String(url).includes('/accounts/pin-reset'))).toBe(false);
  });

  it('reactivating posts active_flag true in one press, and the code control comes back', async () => {
    const mock = await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: 'Reactivate athlete-off' }));

    await waitFor(() => expect(statusCalls(mock)).toHaveLength(1));
    expect(JSON.parse(String(statusCalls(mock)[0][1].body))).toEqual({ account_id: 'athlete-off', active_flag: true });
    expect(await screen.findByText('athlete-off is active again and can sign in.')).not.toBeNull();
    await waitFor(() => {
      const row = rowOf('athlete-off');
      expect(within(row).getByRole('button', { name: 'Deactivate athlete-off' })).not.toBeNull();
      expect(within(row).getByRole('button', { name: 'Issue New Activation Code' })).not.toBeNull();
    });
  });

  it('an Issue New Activation Code armed before the switch is not armed again after Reactivate', async () => {
    const mock = await renderConsole();

    fireEvent.click(within(rowOf('athlete-on')).getByRole('button', { name: 'Issue New Activation Code' }));
    expect(within(rowOf('athlete-on')).getByRole('button', { name: 'Issue The New Code' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate athlete-on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Deactivate' }));
    await screen.findByRole('button', { name: 'Reactivate athlete-on' });
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate athlete-on' }));

    await waitFor(() => expect(statusCalls(mock)).toHaveLength(2));
    await waitFor(() => {
      const row = rowOf('athlete-on');
      expect(within(row).getByRole('button', { name: 'Issue New Activation Code' })).not.toBeNull();
      expect(within(row).queryByRole('button', { name: 'Issue The New Code' })).toBeNull();
    });
    expect(mock.mock.calls.some(([url]) => String(url).includes('/accounts/pin-reset'))).toBe(false);
  });

  it("a refusal of an athlete with no PIN yet (a PIN reset since the page loaded) is shown in the server's words, and the row is re-read", async () => {
    await renderConsole({
      onStatus: () => ({
        ok: false,
        status: 409,
        error: 'This athlete has not activated their sign-in yet, so there is nothing to switch off.',
      }),
      // The reset that happened in another tab: no PIN, switched off until redeemed.
      onRefused: (rows) => rows.map((m) => (m.account_id === 'athlete-on'
        ? { ...m, has_pin: false, active_flag: false, membership_active: false }
        : m)),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate athlete-on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Deactivate' }));

    expect(await screen.findByText(/This athlete has not activated their sign-in yet, so there is nothing to switch off\./)).not.toBeNull();
    expect(screen.queryByText(/is deactivated: signed out/)).toBeNull();
    // The row now shows what the server holds, and no longer offers (or arms) a switch it refuses.
    await waitFor(() => expect(within(rowOf('athlete-on')).getByText('Awaiting activation')).not.toBeNull());
    expect(within(rowOf('athlete-on')).queryByText('Deactivated')).toBeNull();
    expect(within(rowOf('athlete-on')).queryByRole('button', { name: /Deactivate|Confirm Deactivate|Reactivate/ })).toBeNull();
  });

  it('a Deactivate armed before a new activation code is not armed again once the code is redeemed', async () => {
    await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate athlete-on' }));
    expect(within(rowOf('athlete-on')).getByRole('button', { name: 'Confirm Deactivate' })).not.toBeNull();

    // Without backing out, the office issues the athlete a new code on the same row.
    fireEvent.click(within(rowOf('athlete-on')).getByRole('button', { name: 'Issue New Activation Code' }));
    fireEvent.click(within(rowOf('athlete-on')).getByRole('button', { name: 'Issue The New Code' }));
    await waitFor(() => expect(within(rowOf('athlete-on')).getByText('Awaiting activation')).not.toBeNull());

    // The athlete redeems it; a later re-read shows them with a PIN again. The
    // re-read here is a code issued to another athlete: unlike a switch, that
    // path clears no armed Deactivate of its own, so only the re-read can.
    serverChange((rows) => rows.map((m) => (m.account_id === 'athlete-on'
      ? { ...m, has_pin: true, active_flag: true, membership_active: true }
      : m)));
    fireEvent.click(within(rowOf('athlete-waiting')).getByRole('button', { name: 'Issue New Activation Code' }));
    fireEvent.click(within(rowOf('athlete-waiting')).getByRole('button', { name: 'Issue The New Code' }));
    await screen.findByText('athlete-waiting is inactive until the new one-time activation code is redeemed.');

    await waitFor(() => {
      const row = rowOf('athlete-on');
      expect(within(row).getByRole('button', { name: 'Deactivate athlete-on' })).not.toBeNull();
      expect(within(row).queryByRole('button', { name: 'Confirm Deactivate' })).toBeNull();
    });
  });

  it('a Sign Out Everywhere armed before the switch is not armed again after Reactivate', async () => {
    await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: 'Sign athlete-on out on every device' }));
    expect(within(rowOf('athlete-on')).getByRole('button', { name: 'Sign Them Out' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate athlete-on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Deactivate' }));
    await screen.findByRole('button', { name: 'Reactivate athlete-on' });
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate athlete-on' }));

    await waitFor(() => {
      const row = rowOf('athlete-on');
      expect(within(row).getByRole('button', { name: 'Sign athlete-on out on every device' })).not.toBeNull();
      expect(within(row).queryByRole('button', { name: 'Sign Them Out' })).toBeNull();
    });
  });

  it('an armed Sign Out Everywhere on a coach row stays armed while another row is switched', async () => {
    await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: 'Sign coach@example.com out on every device' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate athlete-on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Deactivate' }));
    await screen.findByRole('button', { name: 'Reactivate athlete-on' });

    // The coach row is as it was on main: still armed.
    expect(within(rowOf('coach@example.com')).getByRole('button', { name: 'Sign Them Out' })).not.toBeNull();
  });

  it('Sign Out Everywhere on an activated athlete names the switch as the next step', async () => {
    await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: 'Sign athlete-on out on every device' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign Them Out' }));

    expect(await screen.findByText(
      'athlete-on is signed out on every device. Their sign-in still works — they can sign back in. To stop that too, deactivate them.',
    )).not.toBeNull();
  });
});
