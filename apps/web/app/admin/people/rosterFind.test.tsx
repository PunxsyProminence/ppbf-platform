/**
 * @jest-environment jsdom
 */

// Lane AS-10, PR AS10-2a (app scrub OFF-06): Gym Office's roster gets a
// "Find a person" box and a Role filter, in Athlete Records' own pattern. They
// narrow what is shown and nothing else: no re-read, no row action changed. A
// narrowed list says so, so it never reads as everyone in the gym.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import PeopleConsolePage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/usePilotSession', () => ({
  usePilotSession: () => ({ loading: false, role: 'organization_admin', accountId: 'admin-1', authProvider: 'microsoft' }),
  isOrganizationAdminSessionRole: () => true,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

const originalFetch = global.fetch;

const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Alex Fixture', account_id: 'southpaw12', account_active: true, has_pin: true, account_updated_at: null },
];

const member = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  login_email: null,
  auth_provider: 'microsoft',
  athlete_id: null,
  active_flag: true,
  has_pin: false,
  membership_active: true,
  ...overrides,
});

const MEMBERS = [
  member({ account_id: 'boss@example.test', login_email: 'boss@example.test', role: 'organization_admin' }),
  member({ account_id: 'old-admin@example.test', login_email: 'old-admin@example.test', role: 'admin' }),
  member({ account_id: 'coach@example.test', login_email: 'coach@example.test', role: 'coach', staff_display_name: 'Robin Fixture' }),
  member({ account_id: 'helper@example.test', login_email: 'helper@example.test', role: 'volunteer' }),
  member({ account_id: 'southpaw12', auth_provider: 'ppbf_local', role: 'athlete', athlete_id: 'ath-1', has_pin: true }),
];

/** `later` is what the roster read returns from its second answer on (a re-read after an action). */
function installFetch(first: unknown[] = MEMBERS, later: unknown[] = first) {
  let reads = 0;
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/pilot/admin/athlete-pin-directory')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, items: [...ROSTER] }) } as Response;
    }
    if (url.includes('/api/pilot/admin/staff') && (init?.method ?? 'GET') === 'GET') {
      reads += 1;
      const members = reads === 1 ? first : later;
      return { ok: true, status: 200, json: async () => ({ ok: true, organization_id: 'org-1', members, guardian_links: [] }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = originalFetch;
});

async function roster() {
  render(<PeopleConsolePage />);
  const table = await screen.findByRole('table');
  return table;
}

const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1); // the header row is first

const find = (text: string) => fireEvent.change(screen.getByLabelText('Find a person'), { target: { value: text } });
const role = (label: string) => fireEvent.change(screen.getByLabelText('Role'), { target: { value: label } });

test('the whole roster shows until something is typed or chosen, under its own caption', async () => {
  installFetch();
  const table = await roster();
  expect(rows(table)).toHaveLength(MEMBERS.length);
  expect(within(table).getByText('Everyone in this gym')).toBeTruthy();
  expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('all');
});

test.each([
  ['the athlete\'s roster name', 'alex fix', 'Alex Fixture'],
  ['a staff member\'s own name', 'robin', 'coach@example.test'],
  ['a sign-in address', 'HELPER@', 'helper@example.test'],
  ['a PIN athlete\'s sign-in ID', 'southpaw', 'Alex Fixture'],
])('finds a person by %s, and says the list is narrowed', async (_label, text, shownAs) => {
  installFetch();
  const table = await roster();
  find(text);
  expect(rows(table)).toHaveLength(1);
  expect(within(rows(table)[0]).getByText(shownAs)).toBeTruthy();
  expect(within(table).getByText(`Showing 1 of ${MEMBERS.length}`)).toBeTruthy();
});

test('the role filter lists the roles present, by the Role column\'s words, and narrows to one', async () => {
  installFetch();
  const table = await roster();
  const options = Array.from((screen.getByLabelText('Role') as HTMLSelectElement).options).map((option) => option.textContent);
  expect(options).toEqual(['All roles', 'Gym Admin', 'Coach', 'Volunteer', 'Athlete']);
  role('Coach');
  expect(rows(table)).toHaveLength(1);
  expect(within(rows(table)[0]).getByText('coach@example.test')).toBeTruthy();
  // "Gym Admin" covers both admin role names, as the Role column does.
  role('Gym Admin');
  expect(rows(table)).toHaveLength(2);
});

test('the box and the role filter narrow together', async () => {
  installFetch();
  const table = await roster();
  role('Volunteer');
  find('coach');
  expect(within(table).getByText('No one on the roster matches. Clear the box or choose All roles.')).toBeTruthy();
  expect(within(table).getByText(`Showing 0 of ${MEMBERS.length}`)).toBeTruthy();
  role('all');
  expect(rows(table)).toHaveLength(1);
  // With All roles already chosen, the line does not send the admin to it.
  find('nobody-by-this-name');
  expect(within(table).getByText('No one on the roster matches. Clear the box to see everyone.')).toBeTruthy();
});

test('narrowing re-reads nothing, and a found row keeps its actions', async () => {
  installFetch();
  const table = await roster();
  const reads = (global.fetch as jest.Mock).mock.calls.length;
  find('southpaw');
  role('Athlete');
  expect((global.fetch as jest.Mock).mock.calls.length).toBe(reads);
  expect(within(rows(table)[0]).getByRole('button', { name: 'Issue New Activation Code' })).toBeTruthy();
});

// AS10-2a review: the box searches what a row shows (plus a PIN athlete's
// sign-in ID), not ids or addresses the row never prints.
test.each([
  ['an adult\'s account id that is not their address', 'acct-7731'],
  ['an athlete\'s own email address', 'kid-private@'],
  ['the words of the "no sign-in address" stand-in', 'address'],
])('does not find a row by %s', async (_label, text) => {
  installFetch([
    member({ account_id: 'acct-7731', login_email: 'desk@example.test', role: 'staff' }),
    member({ account_id: 'southpaw12', auth_provider: 'ppbf_local', role: 'athlete', athlete_id: 'ath-1', has_pin: true, login_email: 'kid-private@example.test' }),
    member({ account_id: 'acct-9', login_email: null, role: 'volunteer' }),
  ]);
  const table = await roster();
  find(text);
  expect(within(table).getByText('Showing 0 of 3')).toBeTruthy();
});

// AS10-2a review: a role nobody holds any more must not leave the list empty
// under a select that reads "All roles".
test('a chosen role that leaves the roster falls back to All roles, in the select and in the list', async () => {
  const volunteerNowCoach = MEMBERS.map((item) => (item.role === 'volunteer' ? { ...item, role: 'coach' } : item));
  installFetch(MEMBERS, volunteerNowCoach);
  const table = await roster();
  role('Volunteer');
  expect(rows(table)).toHaveLength(1);
  // Any action that re-reads the roster; here the volunteer is switched off.
  fireEvent.click(within(rows(table)[0]).getByRole('button', { name: 'Deactivate helper@example.test' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Deactivate' }));
  await waitFor(() => expect(rows(table)).toHaveLength(MEMBERS.length));
  expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('all');
  expect(within(table).getByText('Everyone in this gym')).toBeTruthy();
  expect(Array.from((screen.getByLabelText('Role') as HTMLSelectElement).options).map((option) => option.textContent)).not.toContain('Volunteer');
});

// AS10-2a review: narrowing must not leave something armed, or a name being
// edited, waiting on a hidden row to come back one tap from acting.
describe('narrowing closes what is armed or open on a row it hides', () => {
  test('an armed code re-issue on a hidden row is disarmed; it does not come back armed', async () => {
    installFetch();
    const table = await roster();
    fireEvent.click(within(table).getByRole('button', { name: 'Issue New Activation Code' }));
    expect(within(table).getByRole('button', { name: 'Issue The New Code' })).toBeTruthy();
    find('coach@');
    expect(within(table).queryByRole('button', { name: 'Issue The New Code' })).toBeNull();
    find('');
    expect(within(table).queryByRole('button', { name: 'Issue The New Code' })).toBeNull();
    expect(within(table).getByRole('button', { name: 'Issue New Activation Code' })).toBeTruthy();
  });

  test('an armed sign-out and an armed deactivate on a hidden row are disarmed too', async () => {
    installFetch();
    const table = await roster();
    const coachRow = () => within(table).getByText('coach@example.test').closest('tr') as HTMLElement;
    const signOut = 'Sign coach@example.test out on every device';
    fireEvent.click(within(coachRow()).getByRole('button', { name: signOut }));
    fireEvent.click(within(coachRow()).getByRole('button', { name: 'Deactivate coach@example.test' }));
    // Both are armed: neither opening button is offered while its confirm is up.
    expect(within(coachRow()).getByRole('button', { name: 'Confirm Deactivate' })).toBeTruthy();
    expect(within(coachRow()).queryByRole('button', { name: signOut })).toBeNull();
    role('Athlete');
    role('all');
    expect(within(coachRow()).queryByRole('button', { name: 'Confirm Deactivate' })).toBeNull();
    expect(within(coachRow()).getByRole('button', { name: 'Deactivate coach@example.test' })).toBeTruthy();
    expect(within(coachRow()).getByRole('button', { name: signOut })).toBeTruthy();
  });

  test('something armed on a row that stays in view stays armed', async () => {
    installFetch();
    const table = await roster();
    fireEvent.click(within(table).getByRole('button', { name: 'Issue New Activation Code' }));
    find('southpaw');
    expect(within(table).getByRole('button', { name: 'Issue The New Code' })).toBeTruthy();
  });

  test('a name being edited on a hidden row is closed, and the box keeps the typing', async () => {
    installFetch();
    const table = await roster();
    fireEvent.click(within(table).getByRole('button', { name: /Edit Name/ }));
    expect(screen.getByLabelText(/^Name for /)).toBeTruthy();
    const box = screen.getByLabelText('Find a person') as HTMLInputElement;
    box.focus();
    find('helper');
    expect(screen.queryByLabelText(/^Name for /)).toBeNull();
    find('');
    expect(screen.queryByLabelText(/^Name for /)).toBeNull();
    expect(document.activeElement).toBe(box);
    // Other rows' name buttons work again: nothing is left open out of sight.
    expect((within(table).getByRole('button', { name: /Edit Name/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
