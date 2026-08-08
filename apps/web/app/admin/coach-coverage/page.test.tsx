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

  await screen.findByText('Sample Athlete One');
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

test('granting posts the form fields and reloads the list', async () => {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ athlete_id: 'ath-2', covering_coach_id: 'coach-new', ttl_hours: 48 });
      return jsonResponse({ ok: true, coverage_id: 'cov-2' });
    }
    return jsonResponse({ coverage: ACTIVE });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CoachCoveragePage />);
  await screen.findByText('Sample Athlete One');

  fireEvent.change(screen.getByLabelText('Athlete ID'), { target: { value: 'ath-2' } });
  fireEvent.change(screen.getByLabelText('Covering coach account ID'), { target: { value: 'coach-new' } });
  fireEvent.change(screen.getByLabelText('Hours (default 24, max 336)'), { target: { value: '48' } });
  fireEvent.click(screen.getByRole('button', { name: 'Grant' }));

  await waitFor(() => expect(screen.getByText('Coverage granted.')).toBeInTheDocument());
  // The form clears after a successful grant.
  expect(screen.getByLabelText('Athlete ID')).toHaveValue('');
});

test('a failed grant surfaces the server error and keeps the typed values', async () => {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return jsonResponse({ error: 'Missing covering_coach_id: must be an active coach account in this organization' }, false);
    }
    return jsonResponse({ coverage: [] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CoachCoveragePage />);
  await screen.findByText('No active coverage grants');

  fireEvent.change(screen.getByLabelText('Athlete ID'), { target: { value: 'ath-2' } });
  fireEvent.change(screen.getByLabelText('Covering coach account ID'), { target: { value: 'not-a-coach' } });
  fireEvent.click(screen.getByRole('button', { name: 'Grant' }));

  await screen.findByText('Missing covering_coach_id: must be an active coach account in this organization');
  expect(screen.getByLabelText('Athlete ID')).toHaveValue('ath-2');
});

test('revoking asks for confirmation first and does nothing if declined', async () => {
  window.confirm = jest.fn().mockReturnValue(false);
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ coverage: ACTIVE }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CoachCoveragePage />);
  await screen.findByText('Sample Athlete One');

  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  // Only the initial GET happened -- no DELETE was ever sent.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('revoking, once confirmed, sends the coverage_id and reloads the list', async () => {
  window.confirm = jest.fn().mockReturnValue(true);
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ coverage_id: 'cov-1' });
      return jsonResponse({ ok: true, revoked: true });
    }
    return jsonResponse({ coverage: ACTIVE });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CoachCoveragePage />);
  await screen.findByText('Sample Athlete One');

  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

  await waitFor(() => expect(screen.getByText('Coverage revoked.')).toBeInTheDocument());
});
