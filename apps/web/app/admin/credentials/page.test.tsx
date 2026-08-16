/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import AdminCredentialsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const SUBMITTED_ROW = {
  clearance_id: 'clr-1', person_account_id: 'acct-9', person_display_name: 'Jane Okafor', person_role: 'coach',
  clearance_type_id: 'ct-safesport', clearance_name: 'SafeSport Training', issuing_authority: 'U.S. Center for SafeSport',
  validity_months: 12, status: 'submitted', band: 'submitted', issued_on: null, expires_on: null,
  has_document: true, verified_by_account_id: null, verified_at: null, verification_note: null,
};

const EXPIRED_ROW = {
  clearance_id: 'clr-2', person_account_id: 'acct-2', person_display_name: 'Sam Reyes', person_role: 'coach',
  clearance_type_id: 'ct-cpr', clearance_name: 'CPR/First Aid', issuing_authority: 'American Red Cross',
  validity_months: 24, status: 'current', band: 'expired', issued_on: '2023-01-01', expires_on: '2025-01-01',
  has_document: true, verified_by_account_id: 'admin-1', verified_at: '2023-01-01T00:00:00Z', verification_note: null,
};

function mockFetch(capturePosts?: unknown[], rows = [SUBMITTED_ROW, EXPIRED_ROW]) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      capturePosts?.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ ok: true, item: { status: 'current' } }) } as Response;
    }
    if (url.includes('/admin/credentials')) {
      return { ok: true, json: async () => ({ items: rows }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('separates rows needing attention from everything else, and flags expired critical', async () => {
  global.fetch = mockFetch();

  await act(async () => {
    render(<AdminCredentialsPage />);
  });

  expect(await screen.findByText('Jane Okafor')).toBeTruthy();
  expect(screen.getByText('Sam Reyes')).toBeTruthy();
  expect(screen.getByText('Needs attention')).toBeTruthy();
  expect(screen.getAllByText(/expired/i).length).toBeGreaterThan(0);
});

test('verifying requires an issued_on date and posts the verify action', async () => {
  const posts: unknown[] = [];
  global.fetch = mockFetch(posts, [SUBMITTED_ROW]);

  await act(async () => {
    render(<AdminCredentialsPage />);
  });

  await screen.findByText('Jane Okafor');
  const verifyButtons = screen.getAllByRole('button', { name: /^verify$/i });
  await act(async () => {
    fireEvent.click(verifyButtons[0]);
  });

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    action: 'verify', person_account_id: 'acct-9', clearance_type_id: 'ct-safesport',
  });
  expect((posts[0] as { issued_on: string }).issued_on).toBeTruthy();
});

test('rejecting without a note is refused client-side', async () => {
  const posts: unknown[] = [];
  global.fetch = mockFetch(posts, [SUBMITTED_ROW]);

  await act(async () => {
    render(<AdminCredentialsPage />);
  });

  await screen.findByText('Jane Okafor');
  const rejectButtons = screen.getAllByRole('button', { name: /^reject$/i });
  await act(async () => {
    fireEvent.click(rejectButtons[0]);
  });

  expect(posts).toHaveLength(0);
  expect(screen.getByText(/a rejection needs a note/i)).toBeTruthy();
});

test('rejecting with a note posts the reject action and the note', async () => {
  const posts: unknown[] = [];
  global.fetch = mockFetch(posts, [SUBMITTED_ROW]);

  await act(async () => {
    render(<AdminCredentialsPage />);
  });

  await screen.findByText('Jane Okafor');
  const noteInput = screen.getByPlaceholderText(/reason for rejecting/i);
  await act(async () => {
    fireEvent.change(noteInput, { target: { value: 'photo is illegible, please rescan' } });
  });
  const rejectButtons = screen.getAllByRole('button', { name: /^reject$/i });
  await act(async () => {
    fireEvent.click(rejectButtons[0]);
  });

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    action: 'reject', person_account_id: 'acct-9', clearance_type_id: 'ct-safesport',
    note: 'photo is illegible, please rescan',
  });
});

test('a submitted row with a document offers a view-document link, scoped to that person and type', async () => {
  global.fetch = mockFetch(undefined, [SUBMITTED_ROW]);

  await act(async () => {
    render(<AdminCredentialsPage />);
  });

  const link = await screen.findByRole('link', { name: /view document/i });
  expect(link.getAttribute('href')).toContain('/api/pilot/credentials/document/acct-9/ct-safesport');
});
