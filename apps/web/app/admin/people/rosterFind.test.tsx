/**
 * @jest-environment jsdom
 */

// Lane AS-10, PR AS10-2a (app scrub OFF-06): Gym Office's roster gets a
// "Find a person" box and a Role filter, in Athlete Records' own pattern. They
// narrow what is shown and nothing else: no re-read, no row action changed. A
// narrowed list says so, so it never reads as everyone in the gym.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

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

const member = (overrides: Record<string, unknown>) => ({
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

function installFetch() {
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/pilot/admin/athlete-pin-directory')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, items: [...ROSTER] }) } as Response;
    }
    if (url.includes('/api/pilot/admin/staff') && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, organization_id: 'org-1', members: MEMBERS, guardian_links: [] }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
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
