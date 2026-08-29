/**
 * @jest-environment jsdom
 */

/**
 * Ending a session without destroying the account.
 *
 * POST /api/pilot/admin/accounts/revoke has existed since sessions did and
 * nothing on any screen called it. Its sibling in the same directory,
 * accounts/pin-reset, has had a control on this console all along — and that
 * one nulls the pin_hash, clears active_flag and revokes, leaving the person
 * locked out until somebody redeems a new activation code
 * (provisionAthleteActivation).
 *
 * So an admin who needed to clear a tablet a coach left signed in at the gym
 * could only reach the heavy action, and paid for it by locking that coach out
 * of the evening. Staff rows had no action at all: an em-dash.
 *
 * These cases are about the two ways this goes wrong. The control has to
 * distinguish itself from the heavy one in words an admin reads under
 * pressure — a "sign out" that silently locked people out would be worse than
 * the missing button. And it must not fire on a stray tap on a roster.
 */

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

interface Options {
  /** What POST /api/pilot/admin/accounts/revoke answers. */
  onRevoke?: (body: Record<string, unknown>) => { ok: boolean; status?: number; error?: string };
}

function staffMember(overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'coach.alvarez@example.com',
    login_email: 'coach.alvarez@example.com',
    auth_provider: 'microsoft',
    role: 'coach',
    athlete_id: null,
    active_flag: true,
    has_pin: false,
    membership_active: true,
    ...overrides,
  };
}

function installFetch(options: Options = {}): jest.Mock {
  const mock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/pilot/admin/accounts/revoke')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const outcome = options.onRevoke?.(body) ?? { ok: true };
      return {
        ok: outcome.ok,
        status: outcome.status ?? (outcome.ok ? 200 : 400),
        json: async () => (outcome.ok ? { ok: true, account_id: body.account_id } : { error: outcome.error }),
      } as Response;
    }
    if (url.includes('/api/pilot/admin/athlete-pin-directory')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) } as Response;
    }
    if (url.includes('/api/pilot/admin/staff')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          organization_id: 'org-1',
          members: [staffMember()],
          guardian_links: [],
        }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  global.fetch = mock as never;
  return mock;
}

async function renderConsole(options: Options = {}): Promise<jest.Mock> {
  const mock = installFetch(options);
  render(<PeopleConsolePage />);
  await screen.findByText('coach.alvarez@example.com');
  return mock;
}

function revokeCalls(mock: jest.Mock): unknown[] {
  return mock.mock.calls.filter(([url]) => String(url).includes('/accounts/revoke'));
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('the control exists where staff rows had nothing', () => {
  it('is offered on a staff row, which previously carried only an em-dash', async () => {
    await renderConsole();

    expect(
      screen.getByRole('button', { name: 'Sign coach.alvarez@example.com out on every device' }),
    ).not.toBeNull();
  });

  it('does not require the account to be a PIN athlete', async () => {
    // The route admits any active member of this organization who is not a
    // platform owner. A Microsoft-authenticated coach is exactly that, and was
    // the row with no action at all.
    await renderConsole();

    expect(screen.queryByRole('button', { name: /Issue New Activation Code/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Sign .* out on every device/ })).not.toBeNull();
  });
});

describe('it asks before interrupting somebody mid-use', () => {
  it('sends nothing on the first click', async () => {
    const mock = await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: /out on every device/ }));

    expect(revokeCalls(mock)).toHaveLength(0);
    expect(screen.getByText(/Signs coach.alvarez@example.com out on every device now/)).not.toBeNull();
  });

  it('says plainly that this is NOT a lockout', async () => {
    // THE SENTENCE THIS FILE EXISTS FOR. The sibling control on this same row
    // leaves an account unusable until a code is redeemed. An admin choosing
    // between them under pressure has to be able to tell which is which.
    await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: /out on every device/ }));

    expect(screen.getByText(/they can sign back in/)).not.toBeNull();
    expect(screen.getByText(/it does not lock the account/)).not.toBeNull();
  });

  it('backs out without sending', async () => {
    const mock = await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: /out on every device/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(revokeCalls(mock)).toHaveLength(0);
    expect(screen.getByRole('button', { name: /out on every device/ })).not.toBeNull();
  });
});

describe('signing an account out', () => {
  it('posts the account id and reports what did and did not happen', async () => {
    const mock = await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: /out on every device/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign Them Out' }));

    await waitFor(() => {
      expect(revokeCalls(mock)).toHaveLength(1);
    });
    const [, init] = revokeCalls(mock)[0] as [unknown, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ account_id: 'coach.alvarez@example.com' });

    const notice = await screen.findByText(/is signed out on every device/);
    // The receipt repeats the distinction rather than leaving an admin to
    // remember it: this ended the session and left the credential alone.
    expect(notice.textContent).toContain('Their sign-in still works');
    expect(notice.textContent).toContain('issue a new activation code');
  });

  it('never issues an activation code as a side effect', async () => {
    // The two actions share a row and a directory. Wiring the light one to the
    // heavy route would look identical on screen right up to the moment a
    // coach could not sign in.
    const mock = await renderConsole();

    fireEvent.click(screen.getByRole('button', { name: /out on every device/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign Them Out' }));

    await waitFor(() => {
      expect(revokeCalls(mock)).toHaveLength(1);
    });
    expect(mock.mock.calls.some(([url]) => String(url).includes('/accounts/pin-reset'))).toBe(false);
  });
});

describe('a sign-out that did not happen', () => {
  it('surfaces the refusal and claims nothing', async () => {
    await renderConsole({
      onRevoke: () => ({ ok: false, status: 400, error: 'Account not found or cannot be revoked' }),
    });

    fireEvent.click(screen.getByRole('button', { name: /out on every device/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign Them Out' }));

    expect(await screen.findByText('Account not found or cannot be revoked')).not.toBeNull();
    // A notice saying they were signed out, over a request the server refused,
    // would leave an admin believing a live session had been ended.
    expect(screen.queryByText(/is signed out on every device/)).toBeNull();
  });
});
