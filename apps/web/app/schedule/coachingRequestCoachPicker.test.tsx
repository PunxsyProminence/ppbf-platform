/**
 * @jest-environment jsdom
 */

// The coach for a coaching request is picked from the gym's coaches by name,
// never typed as an id (#1536, F-059). The admin also reads coaches by name on
// the class row and on an approved request (Overwatch Q3); a coach keeps the
// stored value until a coach-readable name source exists.

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

const MEMBERS = [
  { account_id: 'acct-jane', login_email: 'jane.doe@gym.example', role: 'coach', active_flag: true, membership_active: true },
  { account_id: 'acct-sam', login_email: 'sam_ruiz2@gym.example', role: 'coach', active_flag: true, membership_active: true },
  { account_id: 'acct-gone', login_email: 'old.coach@gym.example', role: 'coach', active_flag: false, membership_active: true },
  { account_id: 'acct-left', login_email: 'left.coach@gym.example', role: 'coach', active_flag: true, membership_active: false },
  { account_id: 'acct-staff', login_email: 'front.desk@gym.example', role: 'staff', active_flag: true, membership_active: true },
];

const REQUESTS = [
  { request_id: 'req-pending', athlete_id: 'athlete-1', preferred_at: '2099-01-01T15:00:00.000Z', goals: 'Footwork', status: 'pending', created_at: '2026-10-01T00:00:00.000Z' },
  { request_id: 'req-done', athlete_id: 'athlete-1', preferred_at: '2099-01-02T15:00:00.000Z', goals: 'Defence', status: 'approved', assigned_coach_account_id: 'acct-sam', created_at: '2026-10-01T00:00:00.000Z' },
];

const CLASSES = [{
  class_id: 'class-1',
  title: 'Youth Boxing',
  start_at: new Date(Date.now() + 86_400_000).toISOString(),
  end_at: new Date(Date.now() + 90_000_000).toISOString(),
  location: 'Main Floor',
  capacity: 16,
  coach_account_id: 'acct-jane',
  covering_coach_account_id: 'acct-sam',
  status: 'open',
  registered_count: 0,
}];

function installFetchMock(role: 'organization_admin' | 'coach', staffOk = true): jest.Mock {
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (payload: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(payload) } as Response);

    if (url.endsWith('/api/pilot/auth/session')) return json({ authenticated: true, role, athlete_id: null });
    if (url.endsWith('/api/pilot/athletes/list')) return json({ items: [{ athlete_id: 'athlete-1', full_name: 'My Athlete' }] });
    if (url.endsWith('/api/pilot/admin/staff')) {
      return staffOk ? json({ ok: true, members: MEMBERS }) : json({ error: 'Forbidden' }, false);
    }
    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') return json({ ok: true });
    if (url.endsWith('/api/pilot/scheduler')) {
      return json({ ok: true, role, classes: CLASSES, registrations: [], coaching_requests: REQUESTS, attendance: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function posts(fetchMock: jest.Mock): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/api/pilot/scheduler') && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

async function renderPage() {
  render(<SchedulerPage />);
  await screen.findByText('Class Schedule');
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the coaching-request coach picker (#1536)', () => {
  test('lists the gym\'s active coaches by name, and approves with the chosen coach', async () => {
    const fetchMock = installFetchMock('organization_admin');
    await renderPage();

    const picker = await screen.findByLabelText(/Coach to assign/);
    expect(picker.tagName).toBe('SELECT');
    expect(screen.queryByPlaceholderText('coach account id')).not.toBeInTheDocument();
    const options = Array.from((picker as HTMLSelectElement).options).map((option) => option.textContent);
    expect(options).toEqual([
      'Select a coach',
      'Coach Jane Doe',
      'Coach Sam Ruiz',
    ]);

    fireEvent.change(picker, { target: { value: 'acct-jane' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve & Assign' }));
    });

    expect(posts(fetchMock)).toEqual([{
      action: 'review_coaching_request',
      request_id: 'req-pending',
      decision: 'approve',
      assigned_coach_account_id: 'acct-jane',
    }]);
  });

  test('approving with no coach chosen asks for one, and sends nothing', async () => {
    const fetchMock = installFetchMock('organization_admin');
    await renderPage();
    await screen.findByLabelText(/Coach to assign/);

    fireEvent.click(screen.getByRole('button', { name: 'Approve & Assign' }));

    expect(await screen.findByText('Choose the coach to assign first.')).toBeInTheDocument();
    expect(posts(fetchMock)).toEqual([]);
  });

  test('a coach list that cannot be read says so, with no box to type an id into', async () => {
    installFetchMock('organization_admin', false);
    await renderPage();

    const picker = await screen.findByLabelText(/Coach to assign/);
    expect(picker).toBeDisabled();
    // Scoped to this picker: the class form's coach picker (lane L31 P6) says the same.
    expect(within(picker).getByText('The coach list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Coach to assign/ })).not.toBeInTheDocument();
  });

  // OD-2026-10-06-025 "Show coach name, hide ID" (#1596): a row names the
  // coach and never prints the login; the admin's picker keeps its own label.
  test('the admin reads coaches by name, without the login, on the class row and on an approved request', async () => {
    installFetchMock('organization_admin');
    await renderPage();
    await screen.findByLabelText(/Coach to assign/);

    expect(screen.getByText(/Coach: Coach Jane Doe \| Cover: Coach Sam Ruiz$/)).toBeInTheDocument();
    expect(screen.getByText(/Status: approved \| Coach: Coach Sam Ruiz$/)).toBeInTheDocument();
    expect(screen.queryByText(/Coach: .*@gym\.example/)).toBeNull();
  });

  test('a coach is never shown a name made up from an id that is not a login (#1596)', async () => {
    const fetchMock = installFetchMock('coach');
    await renderPage();

    // 'acct-jane' is not an email-shaped login, so no "Coach Acct Jane":
    // the row says the name is not available (F-058, as the athletes page).
    expect(
      await screen.findByText(/Coach: coach name not available \| Cover: coach name not available/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Acct/)).toBeNull();
    expect(screen.queryByText(/Coach: acct-jane/)).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/pilot/admin/staff'))).toBe(false);
  });
});
