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

/** One roster per read, in order; the last repeats (a re-read after an action returns the next). */
let guardianLinks: unknown[] = [];
function installFetch(...rosters: unknown[][]) {
  const answers = rosters.length > 0 ? rosters : [MEMBERS];
  let reads = 0;
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/pilot/admin/athlete-pin-directory')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, items: [...ROSTER] }) } as Response;
    }
    if (url.includes('/api/pilot/admin/staff') && (init?.method ?? 'GET') === 'GET') {
      const members = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true, organization_id: 'org-1', members, guardian_links: guardianLinks }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = originalFetch;
  guardianLinks = [];
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
  // (the next test covers that role coming back later)
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

// AS10-2a review: nothing armed may go out of sight and come back armed, one
// tap from acting. A row with something armed or open on it stays in view
// whatever the box and the role say, until it is confirmed or cancelled.
describe('a row with something armed or open on it stays in view', () => {
  const coachRow = (table: HTMLElement) => within(table).getByText('coach@example.test').closest('tr') as HTMLElement;

  test('an armed code re-issue stays in view while the list is narrowed, and leaves when it is cancelled', async () => {
    installFetch();
    const table = await roster();
    fireEvent.click(within(table).getByRole('button', { name: 'Issue New Activation Code' }));
    find('coach@');
    // The coach matches; the athlete's row is held by its armed control.
    expect(rows(table)).toHaveLength(2);
    expect(within(table).getByRole('button', { name: 'Issue The New Code' })).toBeTruthy();
    expect(within(table).getByText(`Showing 2 of ${MEMBERS.length}`)).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: /^Keep/ }));
    expect(rows(table)).toHaveLength(1);
    find('');
    expect(within(table).queryByRole('button', { name: 'Issue The New Code' })).toBeNull();
  });

  test('an armed sign-out and an armed deactivate hold their row under another role', async () => {
    installFetch();
    const table = await roster();
    fireEvent.click(within(coachRow(table)).getByRole('button', { name: 'Sign coach@example.test out on every device' }));
    fireEvent.click(within(coachRow(table)).getByRole('button', { name: 'Deactivate coach@example.test' }));
    role('Athlete');
    expect(rows(table)).toHaveLength(2);
    expect(within(coachRow(table)).getByRole('button', { name: 'Confirm Deactivate' })).toBeTruthy();
    // Cancelling one leaves the other holding the row; cancelling both lets it go.
    fireEvent.click(within(coachRow(table)).getByRole('button', { name: 'Keep Active' }));
    expect(rows(table)).toHaveLength(2);
    fireEvent.click(within(coachRow(table)).getByRole('button', { name: 'Cancel' }));
    expect(rows(table)).toHaveLength(1);
  });

  test('an armed deactivate alone holds its row', async () => {
    installFetch();
    const table = await roster();
    fireEvent.click(within(coachRow(table)).getByRole('button', { name: 'Deactivate coach@example.test' }));
    role('Athlete');
    expect(rows(table)).toHaveLength(2);
    expect(within(coachRow(table)).getByRole('button', { name: 'Confirm Deactivate' })).toBeTruthy();
    fireEvent.click(within(coachRow(table)).getByRole('button', { name: 'Keep Active' }));
    expect(rows(table)).toHaveLength(1);
  });

  test.each([
    ['a guardian link being removed', 'Remove', 'Confirm Remove'],
    ['a guardian being moved to a new email', 'Move Alex Fixture To New Email', 'Confirm Move'],
  ])('%s holds the guardian\'s row', async (_label, open, confirm) => {
    const guardian = member({ account_id: 'family@example.test', login_email: 'family@example.test', role: 'parent' });
    guardianLinks = [{ account_id: 'family@example.test', parent_id: 'par-1', athlete_id: 'ath-1', athlete_full_name: 'Alex Fixture', relationship_to_athlete: 'mother' }];
    installFetch([...MEMBERS, guardian]);
    const table = await roster();
    const guardianRow = () => within(table).getByText('family@example.test').closest('tr') as HTMLElement;
    fireEvent.click(within(guardianRow()).getByRole('button', { name: open }));
    role('Coach');
    expect(rows(table)).toHaveLength(2);
    expect(within(guardianRow()).getByRole('button', { name: confirm })).toBeTruthy();
  });

  test('a name being edited stays open and in view, and the box keeps the typing', async () => {
    installFetch();
    const table = await roster();
    fireEvent.click(within(table).getByRole('button', { name: /Edit Name/ }));
    const nameField = screen.getByLabelText(/^Name for /) as HTMLInputElement;
    const draft = nameField.value;
    const box = screen.getByLabelText('Find a person') as HTMLInputElement;
    box.focus();
    find('helper');
    find('');
    // The same field, never re-opened: it did not take the focus or the typing.
    expect(screen.getByLabelText(/^Name for /)).toBe(nameField);
    expect(nameField.value).toBe(draft);
    expect(document.activeElement).toBe(box);
    expect(rows(table)).toHaveLength(MEMBERS.length);
  });

  test('a re-read that changes what a row matches does not hide it while something is armed on it', async () => {
    // The coach is found by the staff name; the re-read brings a new name that no longer matches.
    const renamed = MEMBERS.map((item) => (item.role === 'coach' ? { ...item, staff_display_name: 'Someone Else' } : item));
    installFetch(MEMBERS, renamed);
    const table = await roster();
    find('robin');
    expect(rows(table)).toHaveLength(1);
    fireEvent.click(within(coachRow(table)).getByRole('button', { name: 'Sign coach@example.test out on every device' }));
    // Any action that re-reads: the volunteer is switched off from a second armed row.
    find('');
    fireEvent.click(within(table).getByRole('button', { name: 'Deactivate helper@example.test' }));
    fireEvent.click(within(table).getByRole('button', { name: 'Confirm Deactivate' }));
    await waitFor(() => expect(within(table).getByText('Someone Else')).toBeTruthy());
    find('robin');
    // No longer a match, still in view, still armed in plain sight.
    expect(rows(table)).toHaveLength(1);
    expect(within(coachRow(table)).queryByRole('button', { name: 'Sign coach@example.test out on every device' })).toBeNull();
    expect(within(coachRow(table)).getByRole('button', { name: 'Sign Them Out' })).toBeTruthy();
  });
});

// AS10-2a review: a role dropped because nobody held it must not switch itself
// back on when someone with that role is added later.
test('a role dropped on a re-read stays dropped when that role comes back', async () => {
  const noVolunteer = MEMBERS.map((item) => (item.role === 'volunteer' ? { ...item, role: 'coach' } : item));
  const volunteerAgain = [...noVolunteer, member({ account_id: 'new-helper@example.test', login_email: 'new-helper@example.test', role: 'volunteer' })];
  installFetch(MEMBERS, noVolunteer, volunteerAgain);
  const table = await roster();
  role('Volunteer');
  fireEvent.click(within(rows(table)[0]).getByRole('button', { name: 'Deactivate helper@example.test' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Deactivate' }));
  await waitFor(() => expect(rows(table)).toHaveLength(MEMBERS.length));
  // A second re-read brings a volunteer back; the admin did not choose Volunteer again.
  fireEvent.click(within(table).getByRole('button', { name: 'Deactivate coach@example.test' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Deactivate' }));
  await waitFor(() => expect(rows(table)).toHaveLength(volunteerAgain.length));
  expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('all');
  expect(within(table).getByText('Everyone in this gym')).toBeTruthy();
});
