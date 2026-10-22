/**
 * @jest-environment jsdom
 */

// Lane L31 P6 (Overwatch Q4): an admin scheduling a class names the coach who
// runs it, picked by name from the gym's active coaches. An admin is not a
// coach; a class the admin scheduled used to name the admin as its coach. A
// coach's own class is still theirs, with no picker.

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

function installFetchMock(role: 'organization_admin' | 'coach', staffOk = true, members: unknown[] = MEMBERS): jest.Mock {
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (payload: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(payload) } as Response);

    if (url.endsWith('/api/pilot/auth/session')) return json({ authenticated: true, role, athlete_id: null });
    if (url.endsWith('/api/pilot/athletes/list')) return json({ items: [{ athlete_id: 'athlete-1', full_name: 'My Athlete' }] });
    if (url.endsWith('/api/pilot/admin/staff')) {
      return staffOk ? json({ ok: true, members }) : json({ error: 'Forbidden' }, false);
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

describe('the class coach picker (lane L31 P6)', () => {
  async function fillClass() {
    fireEvent.change(screen.getByPlaceholderText('Class title'), { target: { value: 'Youth Boxing' } });
    fireEvent.change(screen.getByLabelText('Class starts'), { target: { value: '2099-03-02T17:00' } });
    fireEvent.change(screen.getByLabelText('Class ends'), { target: { value: '2099-03-02T18:00' } });
    fireEvent.change(screen.getByPlaceholderText('Location'), { target: { value: 'Main Floor' } });
  }

  test('an admin picks the class coach from the active coaches; nothing is sent until one is chosen', async () => {
    const fetchMock = installFetchMock('organization_admin');
    await renderPage();
    await fillClass();

    const picker = await screen.findByLabelText('Class coach');
    expect(picker.tagName).toBe('SELECT');
    await within(picker).findByRole('option', { name: 'Coach Jane Doe' });
    expect(Array.from((picker as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
      'Select the coach who runs it',
      'Coach Jane Doe',
      'Coach Sam Ruiz',
    ]);
    const schedule = screen.getByRole('button', { name: 'Schedule Class' });
    expect(schedule).toBeDisabled();

    fireEvent.change(picker, { target: { value: 'acct-sam' } });
    expect(schedule).toBeEnabled();
    await act(async () => {
      fireEvent.click(schedule);
    });

    const created = posts(fetchMock).filter((post) => post.action === 'create_class');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ action: 'create_class', title: 'Youth Boxing', coach_account_id: 'acct-sam' });
  });

  test('the name the gym typed for a coach (Q1 part B) names them in the picker and on the class row', async () => {
    installFetchMock('organization_admin', true, [{ ...MEMBERS[0], staff_display_name: 'Jordan Rivera' }, ...MEMBERS.slice(1)]);
    await renderPage();
    await fillClass();

    const picker = await screen.findByLabelText('Class coach');
    await within(picker).findByRole('option', { name: 'Coach Jordan Rivera' });
    expect(Array.from((picker as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
      'Select the coach who runs it',
      'Coach Jordan Rivera',
      'Coach Sam Ruiz',
    ]);
    expect(await screen.findByText(/Coach: Coach Jordan Rivera/)).toBeTruthy();
    expect(screen.queryByText(/Coach Jane Doe/)).toBeNull();
  });

  test('with the coach list unreadable, the admin cannot schedule and is told why', async () => {
    installFetchMock('organization_admin', false);
    await renderPage();
    const picker = await screen.findByLabelText('Class coach');
    expect(picker).toBeDisabled();
    expect(within(picker).getByText('The coach list could not be loaded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule Class' })).toBeDisabled();
  });

  test('a coach schedules their own class: no picker, and no coach is sent', async () => {
    const fetchMock = installFetchMock('coach');
    await renderPage();
    await fillClass();
    expect(screen.queryByLabelText('Class coach')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Schedule Class' }));
    });
    const created = posts(fetchMock).filter((post) => post.action === 'create_class');
    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty('coach_account_id');
  });
});
