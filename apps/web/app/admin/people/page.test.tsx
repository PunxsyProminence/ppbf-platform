/**
 * @jest-environment jsdom
 */

// The console is the surface that decided a stranded guardian looked healthy:
// an account row with no pilot.parents/pilot.guardian_links pair signs in and
// resolves no children, and this list used to render it as "Signs in with
// Microsoft" like any working account. These tests hold that line, and hold
// the invite form to refusing a parent it cannot link.

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

interface MockOptions {
  members?: unknown[];
  guardianLinks?: unknown[] | null;
  roster?: unknown[];
  rosterOk?: boolean;
  onPost?: (body: Record<string, unknown>) => { ok: boolean; status?: number; error?: string };
  onDelete?: (body: Record<string, unknown>) => { ok: boolean; status?: number; error?: string };
}

function fetchMock(options: MockOptions = {}) {
  return jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/pilot/admin/athlete-pin-directory')) {
      return {
        ok: options.rosterOk !== false,
        status: options.rosterOk === false ? 500 : 200,
        json: async () =>
          options.rosterOk === false ? { ok: false } : { ok: true, items: options.roster ?? [] },
      } as Response;
    }

    if (url.includes('/api/pilot/admin/staff')) {
      const method = init?.method ?? 'GET';

      if (method === 'POST' || method === 'DELETE') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const handler = method === 'POST' ? options.onPost : options.onDelete;
        const outcome = handler ? handler(body) : { ok: true };
        return {
          ok: outcome.ok,
          status: outcome.status ?? (outcome.ok ? 200 : 400),
          json: async () => (outcome.ok ? { ok: true } : { error: outcome.error }),
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          organization_id: 'org-1',
          members: options.members ?? [],
          ...(options.guardianLinks === null ? {} : { guardian_links: options.guardianLinks ?? [] }),
        }),
      } as Response;
    }

    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

function guardianMember(overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'dana@example.com',
    login_email: 'dana@example.com',
    auth_provider: 'microsoft',
    role: 'parent',
    athlete_id: null,
    active_flag: true,
    has_pin: false,
    membership_active: true,
    ...overrides,
  };
}

const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Alex Johnson', account_id: null, account_active: null, has_pin: false, account_updated_at: null },
  { athlete_id: 'ath-2', full_name: 'Sam Rivera', account_id: 'sriv', account_active: true, has_pin: true, account_updated_at: null },
];

afterEach(() => {
  global.fetch = originalFetch;
});

describe('a guardian who resolves no children', () => {
  test('is reported as broken rather than as a working Microsoft account', async () => {
    global.fetch = fetchMock({ members: [guardianMember()], guardianLinks: [], roster: ROSTER }) as never;

    render(<PeopleConsolePage />);

    // Both the row status and the summary banner say it, which is the point.
    expect((await screen.findAllByText(/Linked to no athlete/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Signs in with Microsoft')).toBeNull();
    expect(screen.getByText(/1 guardian linked to no athlete/i)).toBeTruthy();
    expect(screen.getByText(/would see nothing/i)).toBeTruthy();
  });

  test('names the children a linked guardian can actually see', async () => {
    global.fetch = fetchMock({
      members: [guardianMember()],
      guardianLinks: [
        {
          account_id: 'dana@example.com',
          parent_id: 'par-1',
          athlete_id: 'ath-1',
          athlete_full_name: 'Alex Johnson',
          relationship_to_athlete: 'mother',
        },
      ],
      roster: ROSTER,
    }) as never;

    render(<PeopleConsolePage />);

    expect(await screen.findByText('Alex Johnson')).toBeTruthy();
    expect(screen.getByText('Signs in with Microsoft')).toBeTruthy();
    expect(screen.queryByText(/linked to no athlete/i)).toBeNull();
  });

  // A failed read must never render as "linked to nobody" -- that would send an
  // admin to repair an account that is fine.
  test('says the links could not be read instead of showing zero of them', async () => {
    global.fetch = fetchMock({ members: [guardianMember()], guardianLinks: null, roster: ROSTER }) as never;

    render(<PeopleConsolePage />);

    expect((await screen.findAllByText(/Guardian links could not be read/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/would see nothing/i)).toBeNull();
    expect(screen.queryByText(/guardians? linked to no athlete/i)).toBeNull();
  });
});

describe('the invite form', () => {
  async function openInviteTab(options: MockOptions) {
    global.fetch = fetchMock(options) as never;
    render(<PeopleConsolePage />);
    fireEvent.click(await screen.findByRole('button', { name: /Add Coach, Staff Or Guardian/i }));
  }

  test('will not submit a parent invite until an athlete is chosen', async () => {
    await openInviteTab({ roster: ROSTER });

    fireEvent.change(screen.getByLabelText(/Microsoft email address/i), {
      target: { value: 'dana@example.com' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /Parent \/ Guardian/i }));

    const submit = screen.getByRole('button', { name: /Add To My Gym/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Guardian's full name/i), { target: { value: 'Dana Johnson' } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    expect(submit.disabled).toBe(false);
  });

  test('sends the guardian link with the invite and names the child back', async () => {
    const posted: Record<string, unknown>[] = [];
    await openInviteTab({
      roster: ROSTER,
      onPost: (body) => {
        posted.push(body);
        return { ok: true };
      },
    });

    fireEvent.change(screen.getByLabelText(/Microsoft email address/i), {
      target: { value: 'dana@example.com' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /Parent \/ Guardian/i }));
    fireEvent.change(screen.getByLabelText(/Guardian's full name/i), { target: { value: 'Dana Johnson' } });
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Add To My Gym/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      login_email: 'dana@example.com',
      role: 'parent',
      guardian: { athlete_id: 'ath-1', full_name: 'Dana Johnson', relationship_to_athlete: 'mother' },
    });
    expect(await screen.findByText(/is now a guardian of Alex Johnson/i)).toBeTruthy();
  });

  test('a coach invite carries no guardian block at all', async () => {
    const posted: Record<string, unknown>[] = [];
    await openInviteTab({
      roster: ROSTER,
      onPost: (body) => {
        posted.push(body);
        return { ok: true };
      },
    });

    fireEvent.change(screen.getByLabelText(/Microsoft email address/i), {
      target: { value: 'coach@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add To My Gym/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ login_email: 'coach@example.com', role: 'coach' });
  });

  // Linking to an id typed blind against a roster this page could not read is
  // how an adult ends up holding another family's records.
  test('refuses the parent role, with the reason, when the roster could not be read', async () => {
    await openInviteTab({ rosterOk: false });

    expect((screen.getByRole('radio', { name: /Parent \/ Guardian/i }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/roster could not be read/i)).toBeTruthy();
  });

  test('refuses the parent role when the gym has no athlete records yet', async () => {
    await openInviteTab({ roster: [] });

    expect((screen.getByRole('radio', { name: /Parent \/ Guardian/i }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/no athlete records in your gym yet/i)).toBeTruthy();
  });
});

describe('removing a guardian link', () => {
  const LINKED = {
    members: [guardianMember()],
    guardianLinks: [
      {
        account_id: 'dana@example.com',
        parent_id: 'par-1',
        athlete_id: 'ath-1',
        athlete_full_name: 'Alex Johnson',
        relationship_to_athlete: 'mother',
      },
      {
        account_id: 'dana@example.com',
        parent_id: 'par-1',
        athlete_id: 'ath-2',
        athlete_full_name: 'Sam Rivera',
        relationship_to_athlete: 'mother',
      },
    ],
    roster: ROSTER,
  };

  test('takes a second, explicit confirmation before detaching a child', async () => {
    const deleted: Record<string, unknown>[] = [];
    global.fetch = fetchMock({
      ...LINKED,
      onDelete: (body) => {
        deleted.push(body);
        return { ok: true };
      },
    }) as never;

    render(<PeopleConsolePage />);

    const removeButtons = await screen.findAllByRole('button', { name: 'Remove' });
    fireEvent.click(removeButtons[1]);
    expect(deleted).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Confirm Remove/i }));

    await waitFor(() => expect(deleted).toHaveLength(1));
    expect(deleted[0]).toEqual({ account_id: 'dana@example.com', athlete_id: 'ath-2' });
  });

  test('shows the server refusal rather than reporting the link gone', async () => {
    global.fetch = fetchMock({
      ...LINKED,
      onDelete: () => ({
        ok: false,
        status: 403,
        error: 'Forbidden: this is the only athlete this guardian is linked to',
      }),
    }) as never;

    render(<PeopleConsolePage />);

    const removeButtons = await screen.findAllByRole('button', { name: 'Remove' });
    fireEvent.click(removeButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: /Confirm Remove/i }));

    expect(await screen.findByText(/only athlete this guardian is linked to/i)).toBeTruthy();
  });
});
