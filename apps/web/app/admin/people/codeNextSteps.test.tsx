/**
 * @jest-environment jsdom
 */

// Lane AS-10, PR AS10-1 (app scrub OFF-07, OFF-09; Overwatch Q7 A).
//
// After a sign-in code, Gym Office offers the next steps under the code:
// "Next: add a guardian", "Waivers & Consent" and "Media Consent Audit". The
// guardian step is left off only when the date of birth ON FILE makes the
// athlete 18 or over (OD-2026-10-07-008; lane GA refuses that link). An
// unknown date of birth is a minor's (OD-2026-10-04-010), and so is a date the
// page could not read. Gym Office also opens on the tab a link names, so Gym
// Setup's steps land on their own form, and it links Gym Setup.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import PeopleConsolePage from './page';
import { gymDayIso } from '@/src/lib/gymTime';

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
  default: ({ children, href, className }: { readonly children: ReactNode; readonly href: string; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const originalFetch = global.fetch;

const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Alex Johnson', account_id: null, account_active: null, has_pin: false, account_updated_at: null },
  { athlete_id: 'ath-2', full_name: 'Sam Rivera', account_id: 'sriv', account_active: true, has_pin: true, account_updated_at: null },
];

/** How the date-of-birth read answers: rows, a refusal, or a thrown network error. */
type DobRead = { rows: Array<{ athlete_id: string; dob: string | null }> } | { status: number } | 'network-error';

function fetchMock(dobRead: DobRead, members: unknown[] = []) {
  return jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/pilot/athletes/list')) {
      if (dobRead === 'network-error') throw new TypeError('Failed to fetch');
      if ('status' in dobRead) return { ok: false, status: dobRead.status, json: async () => ({ error: 'no' }) } as Response;
      return { ok: true, status: 200, json: async () => ({ items: dobRead.rows }) } as Response;
    }
    if (url.includes('/api/pilot/admin/athlete-accounts')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, activation_code: 'CDEF-3456-GHJK', expires_at: '2026-08-26T00:00:00Z' }) } as Response;
    }
    if (url.includes('/api/pilot/admin/accounts/pin-reset')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, activation_code: 'WXYZ-7890-MNPQ', expires_at: '2026-08-26T00:00:00Z' }) } as Response;
    }
    if (url.includes('/api/pilot/admin/athlete-pin-directory')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, items: [...ROSTER] }) } as Response;
    }
    if (url.includes('/api/pilot/admin/staff') && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, organization_id: 'org-1', members, guardian_links: [] }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

/** A date of birth `years` before the gym's today, shifted by `days`. */
function dobYearsAgo(years: number, days = 0): string {
  const [y, m, d] = (gymDayIso(new Date()) as string).split('-').map(Number);
  const at = new Date(Date.UTC(y - years, m - 1, d + days));
  return at.toISOString().slice(0, 10);
}

/** Gives ath-1 (on the roster, no sign-in yet) a sign-in through Add Athlete, as the office does. */
async function issueCodeForAlex() {
  render(<PeopleConsolePage />);
  fireEvent.click(await screen.findByRole('button', { name: /^Add Athlete$/i }));
  fireEvent.click(screen.getByRole('radio', { name: /Already on the roster/i }));
  fireEvent.change(screen.getByLabelText(/Which athlete/i), { target: { value: 'ath-1' } });
  fireEvent.change(screen.getByLabelText('Sign-in ID'), { target: { value: 'alex-login' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Sign-In & Get Code' }));
  expect(await screen.findByText('CDEF-3456-GHJK')).toBeTruthy();
}

/** The next steps under the code, once the date-of-birth read has answered. */
async function nextSteps() {
  const nav = await screen.findByRole('navigation', { name: 'Next steps' });
  await waitFor(() => {
    const calls = (global.fetch as jest.Mock).mock.calls.map(([url]) => String(url));
    expect(calls.some((url) => url.includes('/api/pilot/athletes/list'))).toBe(true);
  });
  return nav;
}

afterEach(() => {
  global.fetch = originalFetch;
  window.history.replaceState({}, '', '/');
});

describe('next steps under a new sign-in code', () => {
  test('a minor on file: "Next: add a guardian", then Waivers & Consent and Media Consent Audit', async () => {
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(12) }] }) as never;
    await issueCodeForAlex();
    const nav = await nextSteps();
    expect(await within(nav).findByRole('button', { name: 'Next: add a guardian' })).toBeTruthy();
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Waivers & Consent', '/admin/consent'],
      ['Media Consent Audit', '/admin/athlete-consent'],
    ]);
  });

  test('18 or over on file: no guardian step; waivers and media consent stay', async () => {
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(25) }] }) as never;
    await issueCodeForAlex();
    const nav = await nextSteps();
    await waitFor(() => expect(within(nav).getAllByRole('link')).toHaveLength(2));
    expect(within(nav).queryByRole('button', { name: 'Next: add a guardian' })).toBeNull();
  });

  test('the 18th birthday is the gym\'s day: 18 today has no guardian step, 18 tomorrow has one', async () => {
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(18) }] }) as never;
    await issueCodeForAlex();
    const adultNav = await nextSteps();
    await waitFor(() => expect(within(adultNav).getAllByRole('link')).toHaveLength(2));
    expect(within(adultNav).queryByRole('button', { name: 'Next: add a guardian' })).toBeNull();
  });

  test('turns 18 tomorrow: still a minor, so the guardian step shows', async () => {
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(18, 1) }] }) as never;
    await issueCodeForAlex();
    expect(await within(await nextSteps()).findByRole('button', { name: 'Next: add a guardian' })).toBeTruthy();
  });

  test.each([
    ['no date of birth on file', { rows: [{ athlete_id: 'ath-1', dob: null }] } as DobRead],
    ['the athlete is not in the list read', { rows: [{ athlete_id: 'ath-9', dob: dobYearsAgo(30) }] } as DobRead],
    ['the read is refused', { status: 403 } as DobRead],
    ['the read fails', { status: 500 } as DobRead],
    ['the network fails', 'network-error' as DobRead],
  ])('%s: treated as a minor, so the guardian step shows', async (_label, dobRead) => {
    global.fetch = fetchMock(dobRead) as never;
    await issueCodeForAlex();
    expect(await within(await nextSteps()).findByRole('button', { name: 'Next: add a guardian' })).toBeTruthy();
  });

  test('the step opens the guardian invite with this athlete chosen, and the code stays on screen', async () => {
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(12) }] }) as never;
    await issueCodeForAlex();
    fireEvent.click(await within(await nextSteps()).findByRole('button', { name: 'Next: add a guardian' }));

    const athleteSelect = (await screen.findByLabelText('Athlete')) as HTMLSelectElement;
    expect(athleteSelect.value).toBe('ath-1');
    expect((screen.getByRole('radio', { name: /Parent/i }) as HTMLInputElement).checked).toBe(true);
    // Nothing was sent: the admin still types the guardian's email and name.
    const posts = (global.fetch as jest.Mock).mock.calls.filter(([url, init]) =>
      String(url).includes('/api/pilot/admin/staff') && (init as RequestInit | undefined)?.method === 'POST');
    expect(posts).toEqual([]);
    expect(screen.getByText('CDEF-3456-GHJK')).toBeTruthy();
  });

  test('a code re-issued from an athlete\'s row offers the steps for that athlete', async () => {
    const members = [
      { account_id: 'sriv', login_email: null, auth_provider: 'ppbf_local', role: 'athlete', athlete_id: 'ath-2', active_flag: true, has_pin: true, membership_active: true },
    ];
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-2', dob: dobYearsAgo(30) }, { athlete_id: 'ath-1', dob: dobYearsAgo(12) }] }, members) as never;
    render(<PeopleConsolePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Issue New Activation Code' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Issue The New Code' }));
    expect(await screen.findByText('WXYZ-7890-MNPQ')).toBeTruthy();
    const nav = await nextSteps();
    // ath-2 is an adult on file, so the steps are for ath-2, not for anyone else.
    await waitFor(() => expect(within(nav).getAllByRole('link')).toHaveLength(2));
    expect(within(nav).queryByRole('button', { name: 'Next: add a guardian' })).toBeNull();
  });
});

describe('Gym Office opens on the tab a link names', () => {
  test.each([
    ['/admin/people?tab=add-athlete', 'Sign-in ID'],
    ['/admin/people?tab=invite-staff', /Email address/i],
  ])('%s opens that tab', async (address, field) => {
    window.history.replaceState({}, '', address);
    global.fetch = fetchMock({ rows: [] }) as never;
    render(<PeopleConsolePage />);
    expect(await screen.findByLabelText(field)).toBeTruthy();
  });

  test.each(['/admin/people', '/admin/people?tab=people', '/admin/people?tab=nonsense'])('%s opens Everyone, as before', async (address) => {
    window.history.replaceState({}, '', address);
    const coach = { account_id: 'coach-1', login_email: 'coach@example.com', auth_provider: 'microsoft', role: 'coach', athlete_id: null, active_flag: true, has_pin: false, membership_active: true };
    global.fetch = fetchMock({ rows: [] }, [coach]) as never;
    render(<PeopleConsolePage />);
    // The roster table is the Everyone tab's, and only its.
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.queryByLabelText('Sign-in ID')).toBeNull();
    expect(screen.queryByLabelText(/Email address/i)).toBeNull();
  });
});

test('Gym Office links Gym Setup beside Board Seats and Capabilities', async () => {
  global.fetch = fetchMock({ rows: [] }) as never;
  render(<PeopleConsolePage />);
  const setup = await screen.findByRole('link', { name: 'Gym Setup' });
  expect(setup.getAttribute('href')).toBe('/admin/setup');
});
