/**
 * @jest-environment jsdom
 */

// The seat console's job is to make the database's one-primary-per-seat rule
// legible before it is hit. A generic failure on an occupied seat tells the
// person nothing they can act on -- who holds it, and what the two real choices
// are -- so that path is covered here, along with the handover, which is a join
// followed by a promotion because promotion does not seat someone new.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import BoardSeatsPage from './page';
import { usePilotSession, type PilotSessionState } from '@/components/usePilotSession';

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

jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: jest.fn(),
}));

const mockUsePilotSession = usePilotSession as jest.Mock;

const originalFetch = global.fetch;

function session(role: PilotSessionState['role'], accountId = 'admin@punxsyprominence.org'): PilotSessionState {
  return {
    role,
    organizationId: 'org-ppbf',
    authProvider: 'microsoft',
    accountId,
    mustChangePin: false,
    loading: false,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

// The roster read carries the appointment only -- no email, no athlete
// identifier -- so the console works from account ids.
const rosterBody = {
  ok: true,
  organization_id: 'org-ppbf',
  seats: ['president', 'chair', 'vice-chair', 'treasurer', 'secretary', 'safety-director', 'community-director', 'at-large'],
  holders: [
    { seat: 'president', account_id: 'nadia', is_primary: true, assigned_at: '2026-07-01T00:00:00.000Z' },
    { seat: 'chair', account_id: 'dana', is_primary: true, assigned_at: '2026-07-01T00:00:00.000Z' },
    { seat: 'chair', account_id: 'rosa', is_primary: false, assigned_at: '2026-07-02T00:00:00.000Z' },
  ],
};

const directoryBody = {
  ok: true,
  members: [
    { account_id: 'nadia', login_email: 'nadia@example.org', role: 'board' },
    { account_id: 'dana', login_email: 'dana@example.org', role: 'board' },
    { account_id: 'rosa', login_email: 'rosa@example.org', role: 'board' },
    { account_id: 'nils', login_email: 'nils@example.org', role: 'board' },
  ],
};

function seatsFetch(handler?: (url: string, init?: RequestInit) => Response | undefined) {
  return jest.fn(async (url: string, init?: RequestInit) => {
    const handled = handler?.(String(url), init);
    if (handled) {
      return handled;
    }
    if (String(url).includes('/api/pilot/admin/staff')) {
      return jsonResponse(directoryBody);
    }
    return jsonResponse(rosterBody);
  });
}

function callsTo(fetchMock: jest.Mock, method: string) {
  return fetchMock.mock.calls.filter(
    ([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  );
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPage(
  fetchMock: jest.Mock,
  role: PilotSessionState['role'] = 'organization_admin',
  accountId?: string,
) {
  mockUsePilotSession.mockReturnValue(session(role, accountId));
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<BoardSeatsPage />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
}

it('shows every seat, its holder, its additional holders, and the unfilled ones', async () => {
  await renderPage(seatsFetch());

  await screen.findByText('Board Chair');
  expect(screen.getAllByText('dana@example.org').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Holds the seat').length).toBeGreaterThan(0);
  expect(screen.getAllByText('rosa@example.org').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Additional holder').length).toBeGreaterThan(0);

  // Two of the eight are filled, and the other six are still listed.
  expect(screen.getByText('Director-at-Large')).toBeTruthy();
  expect(screen.getAllByText('Unfilled')).toHaveLength(6);
});

it('names the current holder instead of failing generically on an occupied seat', async () => {
  const fetchMock = seatsFetch();
  await renderPage(fetchMock);

  await screen.findByText('Board Chair');
  fireEvent.change(screen.getByLabelText('Seat'), { target: { value: 'chair' } });
  fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'nils' } });

  await screen.findByText(/Board Chair is held by dana@example\.org/);
  expect((screen.getByRole('button', { name: /assign seat/i }) as HTMLButtonElement).disabled).toBe(true);
  expect(callsTo(fetchMock, 'POST')).toHaveLength(0);
});

it('hands a seat to someone new by joining them to it and then promoting', async () => {
  const fetchMock = seatsFetch((url, init) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      return jsonResponse({ ok: true });
    }
    return undefined;
  });

  await renderPage(fetchMock);

  await screen.findByText('Board Chair');
  fireEvent.change(screen.getByLabelText('Seat'), { target: { value: 'chair' } });
  fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'nils' } });
  await screen.findByText(/Board Chair is held by dana@example\.org/);

  fireEvent.click(screen.getByRole('button', { name: /hand the seat over/i }));

  await waitFor(() => expect(callsTo(fetchMock, 'PATCH')).toHaveLength(1));
  // Joined as an additional holder first: a second primary is refused outright,
  // and promotion does not seat someone who is not on the seat.
  expect(JSON.parse(String((callsTo(fetchMock, 'POST')[0][1] as RequestInit).body))).toEqual({
    seat: 'chair',
    account_id: 'nils',
    is_primary: false,
  });
  expect(JSON.parse(String((callsTo(fetchMock, 'PATCH')[0][1] as RequestInit).body))).toEqual({
    seat: 'chair',
    account_id: 'nils',
  });
});

it('promotes an existing additional holder without seating them twice', async () => {
  const fetchMock = seatsFetch((url, init) => {
    if (init?.method === 'PATCH') {
      return jsonResponse({ ok: true });
    }
    return undefined;
  });

  await renderPage(fetchMock);

  await screen.findByText('Board Chair');
  fireEvent.click(screen.getByRole('button', { name: /hand seat over/i }));

  await waitFor(() => expect(callsTo(fetchMock, 'PATCH')).toHaveLength(1));
  expect(callsTo(fetchMock, 'POST')).toHaveLength(0);
  expect(JSON.parse(String((callsTo(fetchMock, 'PATCH')[0][1] as RequestInit).body))).toEqual({
    seat: 'chair',
    account_id: 'rosa',
  });
});

it('assigns an additional holder without claiming the seat', async () => {
  const fetchMock = seatsFetch((url, init) => (init?.method === 'POST' ? jsonResponse({ ok: true }) : undefined));

  await renderPage(fetchMock);

  await screen.findByText('Board Chair');
  fireEvent.change(screen.getByLabelText('Seat'), { target: { value: 'chair' } });
  fireEvent.change(screen.getByLabelText('Member'), { target: { value: 'nils' } });
  fireEvent.click(screen.getByLabelText(/Additional holder/));
  fireEvent.click(screen.getByRole('button', { name: /assign seat/i }));

  await waitFor(() => expect(callsTo(fetchMock, 'POST')).toHaveLength(1));
  expect(JSON.parse(String((callsTo(fetchMock, 'POST')[0][1] as RequestInit).body))).toEqual({
    seat: 'chair',
    account_id: 'nils',
    is_primary: false,
  });
});

it('removes a holder by seat and account', async () => {
  const fetchMock = seatsFetch((url, init) => (init?.method === 'DELETE' ? jsonResponse({ ok: true }) : undefined));

  await renderPage(fetchMock);

  await screen.findByText('Board Chair');
  fireEvent.click(screen.getAllByRole('button', { name: /^remove$/i })[0]);

  await waitFor(() => expect(callsTo(fetchMock, 'DELETE')).toHaveLength(1));
  expect(String(callsTo(fetchMock, 'DELETE')[0][0])).toContain('seat=president&account_id=nadia');
});

// The organization directory belongs to an admin, so a board session falls back
// to a typed account id rather than losing the ability to seat anyone.
function boardSessionFetch() {
  return seatsFetch((url) => (
    url.includes('/api/pilot/admin/staff') ? jsonResponse({ error: 'Forbidden' }, false, 403) : undefined
  ));
}

it('lets the board member holding the President seat manage seats', async () => {
  await renderPage(boardSessionFetch(), 'board', 'nadia');

  await screen.findByText('Board Chair');
  expect(screen.getByRole('button', { name: /assign seat/i })).toBeTruthy();
  expect(screen.queryByText(/You can see the roster but not change it/)).toBeNull();
});

it('keeps every other board member read-only', async () => {
  await renderPage(boardSessionFetch(), 'board', 'rosa');

  await screen.findByText(/You can see the roster but not change it/);
  expect(screen.queryByRole('button', { name: /assign seat/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^remove$/i })).toBeNull();
});

it('reports a refused roster read instead of showing eight empty seats as fact', async () => {
  const fetchMock = jest.fn(async () => jsonResponse({ error: 'Forbidden: role not allowed' }, false, 403));

  await renderPage(fetchMock, 'board', 'rosa');

  await screen.findByText('Forbidden: role not allowed');
  expect(screen.queryByRole('button', { name: /assign seat/i })).toBeNull();
});
