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
// page could not read or did not read in time. Gym Office also opens on the
// tab (and, for the guardian step, the role) a link names, and links Gym Setup.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

// A fixed gym day, not the run day: an 18th-birthday test must not depend on
// when it runs (a Feb 29 run day would move "18 years ago" to Mar 1). Only Date
// is faked here; real timers keep the page's reads and RTL's waits working.
const NOW = new Date('2026-11-20T15:00:00Z');
const ONLY_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout'] as const;

const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Alex Johnson', account_id: null, account_active: null, has_pin: false, account_updated_at: null },
  { athlete_id: 'ath-2', full_name: 'Sam Rivera', account_id: 'sriv', account_active: true, has_pin: true, account_updated_at: null },
];

/** How the one-athlete read answers: rows on file, a refusal, a thrown network error, or no answer at all. */
type DobRead = { rows: Array<{ athlete_id: string; dob: string | null }> } | { status: number } | 'network-error' | 'hang';

const DOB_READ = '/api/pilot/athletes/get';

function fetchMock(dobRead: DobRead, members: unknown[] = []) {
  return jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes(DOB_READ)) {
      if (dobRead === 'hang') return new Promise<Response>(() => undefined);
      if (dobRead === 'network-error') throw new TypeError('Failed to fetch');
      if ('status' in dobRead) return { ok: false, status: dobRead.status, json: async () => ({ error: 'no' }) } as Response;
      const { athlete_id: wanted } = JSON.parse(String(init?.body ?? '{}')) as { athlete_id?: string };
      const row = dobRead.rows.find((item) => item.athlete_id === wanted);
      return { ok: true, status: 200, json: async () => (row ? { found: true, athlete: row } : { found: false }) } as Response;
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

/** A date of birth `years` before the fixed gym day, shifted by `days`. */
function dobYearsAgo(years: number, days = 0): string {
  const [y, m, d] = (gymDayIso(NOW) as string).split('-').map(Number);
  return new Date(Date.UTC(y - years, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Gives ath-1 (on the roster, no sign-in yet) a sign-in through Add Athlete, as the office does. */
async function issueCodeForAlex() {
  render(<PeopleConsolePage />);
  fireEvent.click(await screen.findByRole('button', { name: /^Add Athlete$/i }));
  fireEvent.click(await screen.findByRole('radio', { name: /Already on the roster/i }));
  fireEvent.change(await screen.findByLabelText(/Which athlete/i), { target: { value: 'ath-1' } });
  fireEvent.change(screen.getByLabelText('Sign-in ID'), { target: { value: 'alex-login' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Sign-In & Get Code' }));
  expect(await screen.findByText('CDEF-3456-GHJK')).toBeTruthy();
}

/** The next steps under the code, once the one-athlete read has answered. */
async function nextSteps() {
  const nav = await screen.findByRole('navigation', { name: 'Next steps' });
  await waitFor(() => expect(within(nav).queryByText(/Checking the athlete/)).toBeNull());
  return nav;
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: [...ONLY_DATE] });
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
  window.history.replaceState({}, '', '/');
});

describe('next steps under a new sign-in code', () => {
  test('a minor on file: "Next: add a guardian", then Waivers & Consent and Media Consent Audit', async () => {
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(12) }] }) as never;
    await issueCodeForAlex();
    const nav = await nextSteps();
    expect(within(nav).getByRole('button', { name: 'Next: add a guardian' })).toBeTruthy();
    expect(within(nav).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Waivers & Consent', '/admin/consent'],
      ['Media Consent Audit', '/admin/athlete-consent'],
    ]);
  });

  test('reads only this athlete\'s row', async () => {
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(12) }] }) as never;
    await issueCodeForAlex();
    await nextSteps();
    const reads = (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).includes('/api/pilot/athletes'));
    expect(reads.map(([url, init]) => [String(url), (init as RequestInit).method, (init as RequestInit).body])).toEqual([
      [DOB_READ, 'POST', JSON.stringify({ athlete_id: 'ath-1' })],
    ]);
  });

  test('18 or over on file: no guardian step; waivers and media consent stay', async () => {
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(25) }] }) as never;
    await issueCodeForAlex();
    const nav = await nextSteps();
    expect(within(nav).getAllByRole('link')).toHaveLength(2);
    expect(within(nav).queryByRole('button', { name: 'Next: add a guardian' })).toBeNull();
  });

  test('18 today on the gym\'s day: an adult, so no guardian step', async () => {
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(18) }] }) as never;
    await issueCodeForAlex();
    const nav = await nextSteps();
    expect(within(nav).getAllByRole('link')).toHaveLength(2);
    expect(within(nav).queryByRole('button', { name: 'Next: add a guardian' })).toBeNull();
  });

  test('18 tomorrow: still a minor, so the guardian step shows', async () => {
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(18, 1) }] }) as never;
    await issueCodeForAlex();
    expect(within(await nextSteps()).getByRole('button', { name: 'Next: add a guardian' })).toBeTruthy();
  });

  test.each([
    ['no date of birth on file', { rows: [{ athlete_id: 'ath-1', dob: null }] } as DobRead],
    ['the athlete is not found', { rows: [{ athlete_id: 'ath-9', dob: dobYearsAgo(30) }] } as DobRead],
    ['the read is refused', { status: 403 } as DobRead],
    ['the read fails', { status: 500 } as DobRead],
    ['the network fails', 'network-error' as DobRead],
  ])('%s: treated as a minor, so the guardian step shows', async (_label, dobRead) => {
    global.fetch = fetchMock(dobRead) as never;
    await issueCodeForAlex();
    expect(within(await nextSteps()).getByRole('button', { name: 'Next: add a guardian' })).toBeTruthy();
  });

  test('while the record is read the row says so; a read that never answers ends in the minor\'s default', async () => {
    jest.useFakeTimers({ now: NOW });
    global.fetch = fetchMock('hang') as never;
    await issueCodeForAlex();
    const nav = screen.getByRole('navigation', { name: 'Next steps' });
    expect(within(nav).getByText("Checking the athlete's record…")).toBeTruthy();
    expect(within(nav).queryByRole('button', { name: 'Next: add a guardian' })).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(8000);
    });
    expect(within(nav).getByRole('button', { name: 'Next: add a guardian' })).toBeTruthy();
    expect(within(nav).queryByText(/Checking the athlete/)).toBeNull();
  });

  test('an answer that comes after the clock ran out is not taken: the step stays', async () => {
    jest.useFakeTimers({ now: NOW });
    const slow = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(30) }] });
    global.fetch = jest.fn((url: string, init?: RequestInit) =>
      String(url).includes(DOB_READ)
        ? new Promise<Response>((resolve) => setTimeout(() => resolve(slow(url, init)), 9000))
        : slow(url, init)) as never;
    await issueCodeForAlex();
    const nav = screen.getByRole('navigation', { name: 'Next steps' });
    await act(async () => {
      jest.advanceTimersByTime(8000);
    });
    expect(within(nav).getByRole('button', { name: 'Next: add a guardian' })).toBeTruthy();
    // The adult's date of birth arrives late; it does not take the step away.
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(within(nav).getByRole('button', { name: 'Next: add a guardian' })).toBeTruthy();
  });

  test('a reply that names another athlete is not this athlete\'s record: treated as a minor', async () => {
    const inner = fetchMock({ rows: [] });
    global.fetch = jest.fn(async (url: string, init?: RequestInit) =>
      String(url).includes(DOB_READ)
        ? ({ ok: true, status: 200, json: async () => ({ found: true, athlete: { athlete_id: 'ath-2', dob: dobYearsAgo(30) } }) } as Response)
        : inner(url, init)) as never;
    await issueCodeForAlex();
    expect(within(await nextSteps()).getByRole('button', { name: 'Next: add a guardian' })).toBeTruthy();
  });

  test('the step opens a fresh guardian invite with this athlete chosen; nothing is sent; the code stays', async () => {
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(12) }] }) as never;
    await issueCodeForAlex();
    fireEvent.click(within(await nextSteps()).getByRole('button', { name: 'Next: add a guardian' }));

    expect(((await screen.findByLabelText('Athlete')) as HTMLSelectElement).value).toBe('ath-1');
    expect((screen.getByRole('radio', { name: /Parent/i }) as HTMLInputElement).checked).toBe(true);
    const posts = (global.fetch as jest.Mock).mock.calls.filter(([url, init]) =>
      String(url).includes('/api/pilot/admin/staff') && (init as RequestInit | undefined)?.method === 'POST');
    expect(posts).toEqual([]);
    expect(screen.getByText('CDEF-3456-GHJK')).toBeTruthy();
  });

  // AS10-1 review: an armed role change, or an email and name typed for
  // someone else, must not carry over to a new guardian for this child.
  test('an armed role change and earlier typing are cleared, so nothing sends under old words', async () => {
    const staffer = { account_id: 'staffer@example.com', login_email: 'staffer@example.com', auth_provider: 'microsoft', role: 'staff', athlete_id: null, active_flag: true, has_pin: false, membership_active: true };
    global.fetch = fetchMock({ rows: [{ athlete_id: 'ath-1', dob: dobYearsAgo(12) }] }, [staffer]) as never;
    render(<PeopleConsolePage />);
    // Start a guardian invite for ANOTHER child, arm its role change, and leave it unanswered.
    fireEvent.click(await screen.findByRole('button', { name: /Add Coach, Staff Or Guardian/i }));
    fireEvent.change(screen.getByLabelText(/Email address/i), { target: { value: 'staffer@example.com' } });
    fireEvent.click(screen.getByRole('radio', { name: /Parent/i }));
    fireEvent.change(await screen.findByLabelText(/Guardian's full name/i), { target: { value: 'Someone Else' } });
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-2' } });
    const relationship = screen.getByLabelText(/Relationship to the athlete/i) as HTMLSelectElement;
    const firstRelationship = relationship.value;
    const otherRelationship = Array.from(relationship.options).map((option) => option.value).find((value) => value !== firstRelationship) as string;
    fireEvent.change(relationship, { target: { value: otherRelationship } });
    fireEvent.click(screen.getByRole('button', { name: 'Add To My Gym' }));
    expect(await screen.findByRole('button', { name: /^Change staffer@example\.com To / })).toBeTruthy();

    // Now give ath-1 a code and take the guardian step.
    fireEvent.click(screen.getByRole('button', { name: /^Add Athlete$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /Already on the roster/i }));
    fireEvent.change(screen.getByLabelText(/Which athlete/i), { target: { value: 'ath-1' } });
    fireEvent.change(screen.getByLabelText('Sign-in ID'), { target: { value: 'alex-login' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Sign-In & Get Code' }));
    expect(await screen.findByText('CDEF-3456-GHJK')).toBeTruthy();
    fireEvent.click(within(await nextSteps()).getByRole('button', { name: 'Next: add a guardian' }));

    expect(screen.queryByRole('button', { name: /^Change .* To / })).toBeNull();
    expect((screen.getByLabelText(/Email address/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Guardian's full name/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Relationship to the athlete/i) as HTMLSelectElement).value).toBe(firstRelationship);
    expect((screen.getByRole('radio', { name: /Parent/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Athlete') as HTMLSelectElement).value).toBe('ath-1');
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
    expect(within(nav).getAllByRole('link')).toHaveLength(2);
    expect(within(nav).queryByRole('button', { name: 'Next: add a guardian' })).toBeNull();
    expect((global.fetch as jest.Mock).mock.calls.some(([url, init]) =>
      String(url).includes(DOB_READ) && (init as RequestInit).body === JSON.stringify({ athlete_id: 'ath-2' }))).toBe(true);
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

  test('Gym Setup\'s guardian step opens the invite with Parent / Guardian chosen', async () => {
    window.history.replaceState({}, '', '/admin/people?tab=invite-staff&role=parent');
    global.fetch = fetchMock({ rows: [] }) as never;
    render(<PeopleConsolePage />);
    await screen.findByLabelText(/Email address/i);
    expect((screen.getByRole('radio', { name: /Parent/i }) as HTMLInputElement).checked).toBe(true);
  });

  test('landing with Parent chosen while the roster is still loading says so, not that it could not be read', async () => {
    window.history.replaceState({}, '', '/admin/people?tab=invite-staff&role=parent');
    let answer: () => void = () => undefined;
    const inner = fetchMock({ rows: [] });
    global.fetch = jest.fn((url: string, init?: RequestInit) =>
      String(url).includes('/api/pilot/admin/athlete-pin-directory')
        ? new Promise<Response>((resolve) => {
          answer = () => resolve(inner(url, init) as unknown as Response);
        })
        : inner(url, init)) as never;
    render(<PeopleConsolePage />);
    expect(await screen.findByText(/Your gym roster is still being read\./)).toBeTruthy();
    expect(screen.queryByText(/roster could not be read/)).toBeNull();
    await act(async () => {
      answer();
    });
    await waitFor(() => expect(screen.queryByText(/still being read/)).toBeNull());
    expect(screen.queryByText(/roster could not be read/)).toBeNull();
  });

  test.each([
    ['no role named', '/admin/people?tab=invite-staff'],
    ['a role the form does not offer', '/admin/people?tab=invite-staff&role=admin'],
    ['a role off the invite tab', '/admin/people?tab=add-athlete&role=parent'],
  ])('%s keeps Coach, as before', async (_label, address) => {
    window.history.replaceState({}, '', address);
    global.fetch = fetchMock({ rows: [] }) as never;
    render(<PeopleConsolePage />);
    await screen.findByRole('button', { name: /^Add Athlete$/i });
    fireEvent.click(screen.getByRole('button', { name: /Add Coach, Staff Or Guardian/i }));
    expect((screen.getByRole('radio', { name: /^Coach/i }) as HTMLInputElement).checked).toBe(true);
  });
});

test('Gym Office links Gym Setup beside Board Seats and Capabilities', async () => {
  global.fetch = fetchMock({ rows: [] }) as never;
  render(<PeopleConsolePage />);
  const setup = await screen.findByRole('link', { name: 'Gym Setup' });
  expect(setup.getAttribute('href')).toBe('/admin/setup');
});
