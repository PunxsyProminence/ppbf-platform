/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import CoachCoveragePage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const ACTIVE = [
  {
    coverage_id: 'cov-1',
    athlete_id: 'ath-1',
    athlete_full_name: 'Sample Athlete One',
    covering_coach_id: 'coach-sub',
    covering_coach_email: 'sub@example.org',
    granted_by_account_id: 'admin-1',
    granted_by_email: 'admin@example.org',
    starts_at: '2026-08-01T12:00:00Z',
    expires_at: '2026-08-02T12:00:00Z',
  },
];

const MEMBERS = [
  { account_id: 'coach-new', login_email: 'newcoach@example.org', role: 'coach', active_flag: true, membership_active: true },
  { account_id: 'coach-old', login_email: 'retired@example.org', role: 'coach', active_flag: false, membership_active: true },
  { account_id: 'coach-out', login_email: 'left@example.org', role: 'coach', active_flag: true, membership_active: false },
  { account_id: 'admin-1', login_email: 'admin@example.org', role: 'organization_admin', active_flag: true, membership_active: true },
];

const ATHLETES = [
  { athlete_id: 'ath-1', full_name: 'Sample Athlete One' },
  { athlete_id: 'ath-2', full_name: 'Sample Athlete Two' },
];

/** Routes the three mount reads plus the POST/DELETE mutations. */
function routedFetch(overrides: {
  coverage?: () => Response;
  athletes?: () => Response;
  staff?: () => Response;
  post?: (body: Record<string, unknown>) => Response;
  del?: (body: Record<string, unknown>) => Response;
} = {}) {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (overrides.post) return overrides.post(body);
      throw new Error('Unexpected POST');
    }
    if (init?.method === 'DELETE') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (overrides.del) return overrides.del(body);
      throw new Error('Unexpected DELETE');
    }
    if (String(url).includes('/api/pilot/athletes/list')) {
      return overrides.athletes ? overrides.athletes() : jsonResponse({ items: ATHLETES });
    }
    if (String(url).includes('/api/pilot/admin/staff')) {
      return overrides.staff ? overrides.staff() : jsonResponse({ ok: true, members: MEMBERS });
    }
    return overrides.coverage ? overrides.coverage() : jsonResponse({ coverage: ACTIVE });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const originalFetch = global.fetch;
const originalConfirm = window.confirm;

afterEach(() => {
  global.fetch = originalFetch;
  window.confirm = originalConfirm;
  jest.clearAllMocks();
});

test('lists active coverage grants', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ coverage: ACTIVE })) as unknown as typeof fetch;

  render(<CoachCoveragePage />);

  await screen.findAllByText('Sample Athlete One');
  expect(screen.getByText('sub@example.org')).toBeInTheDocument();
  expect(screen.getByText('admin@example.org')).toBeInTheDocument();
});

test('no active grants renders the empty state, not a blank table', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ coverage: [] })) as unknown as typeof fetch;

  render(<CoachCoveragePage />);

  await screen.findByText('No active coverage grants');
});

test('a failed load shows the error state, never a false "no active grants"', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<CoachCoveragePage />);

  await screen.findByText('Database unavailable');
  expect(screen.getByText('The list could not be loaded')).toBeInTheDocument();
  expect(screen.queryByText('No active coverage grants')).not.toBeInTheDocument();
});

test('the pickers offer the server\'s own lists: athletes by name, active coaches by email', async () => {
  routedFetch();

  render(<CoachCoveragePage />);
  await screen.findAllByText('Sample Athlete One');

  const athleteOptions = Array.from((screen.getByLabelText('Athlete') as HTMLSelectElement).options)
    .map((option) => ({ value: option.value, label: option.textContent }));
  expect(athleteOptions).toEqual([
    { value: '', label: 'Select an athlete' },
    { value: 'ath-1', label: 'Sample Athlete One' },
    { value: 'ath-2', label: 'Sample Athlete Two' },
  ]);

  // Exactly the set the server would accept: active coach accounts only.
  // The retired coach, the departed coach, and the admin are not offered.
  const coachOptions = Array.from((screen.getByLabelText('Covering coach') as HTMLSelectElement).options)
    .map((option) => ({ value: option.value, label: option.textContent }));
  expect(coachOptions).toEqual([
    { value: '', label: 'Select a coach' },
    { value: 'coach-new', label: 'newcoach@example.org' },
  ]);
});

test('granting posts the selected real ids and reloads the list', async () => {
  const posted: Record<string, unknown>[] = [];
  routedFetch({
    post: (body) => {
      posted.push(body);
      return jsonResponse({ ok: true, coverage_id: 'cov-2' });
    },
  });

  render(<CoachCoveragePage />);
  await screen.findAllByText('Sample Athlete One');

  fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-2' } });
  fireEvent.change(screen.getByLabelText('Covering coach'), { target: { value: 'coach-new' } });
  fireEvent.change(screen.getByLabelText('Hours (default 24, max 336)'), { target: { value: '48' } });
  fireEvent.click(screen.getByRole('button', { name: 'Grant' }));

  await waitFor(() => expect(screen.getByText('Coverage granted.')).toBeInTheDocument());
  expect(posted).toEqual([{ athlete_id: 'ath-2', covering_coach_id: 'coach-new', ttl_hours: 48 }]);
  // The form clears after a successful grant.
  expect(screen.getByLabelText('Athlete')).toHaveValue('');
});

test('a failed grant surfaces the server error and keeps the selection', async () => {
  routedFetch({
    coverage: () => jsonResponse({ coverage: [] }),
    post: () => jsonResponse({ error: 'Coverage already exists: grant cov-9 for this coach and athlete is still active' }, false),
  });

  render(<CoachCoveragePage />);
  await screen.findByText('No active coverage grants');

  fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-2' } });
  fireEvent.change(screen.getByLabelText('Covering coach'), { target: { value: 'coach-new' } });
  fireEvent.click(screen.getByRole('button', { name: 'Grant' }));

  await screen.findByText(/Coverage already exists: grant cov-9/);
  expect(screen.getByLabelText('Athlete')).toHaveValue('ath-2');
});

test('a failed picker read disables granting and says so -- no raw-id fallback', async () => {
  routedFetch({ staff: () => jsonResponse({ error: 'boom' }, false) });

  render(<CoachCoveragePage />);
  await screen.findAllByText('Sample Athlete One');

  await screen.findByText(/The coach list could not be loaded/);
  expect(screen.getByText(/Granting is disabled until the lists load/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Grant' })).toBeDisabled();
  // The defect this page had was a free-text id field; it must not return as
  // a fallback.
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

test('an organization with no active coaches says so instead of offering an empty picker silently', async () => {
  routedFetch({ staff: () => jsonResponse({ ok: true, members: [MEMBERS[1], MEMBERS[3]] }) });

  render(<CoachCoveragePage />);
  await screen.findAllByText('Sample Athlete One');

  await screen.findByText(/No active coach accounts exist in this organization/);
});

test('revoking asks for confirmation first and does nothing if declined', async () => {
  window.confirm = jest.fn().mockReturnValue(false);
  const fetchMock = routedFetch();

  render(<CoachCoveragePage />);
  await screen.findAllByText('Sample Athlete One');

  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  // No DELETE was ever sent.
  expect(fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'DELETE')).toHaveLength(0);
});

test('revoking, once confirmed, sends the coverage_id and reloads the list', async () => {
  window.confirm = jest.fn().mockReturnValue(true);
  const deleted: Record<string, unknown>[] = [];
  routedFetch({
    del: (body) => {
      deleted.push(body);
      return jsonResponse({ ok: true, revoked: true });
    },
  });

  render(<CoachCoveragePage />);
  await screen.findAllByText('Sample Athlete One');

  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

  await waitFor(() => expect(screen.getByText('Coverage revoked.')).toBeInTheDocument());
  expect(deleted).toEqual([{ coverage_id: 'cov-1' }]);
});
