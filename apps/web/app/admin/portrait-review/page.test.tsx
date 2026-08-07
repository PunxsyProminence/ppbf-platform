/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import PortraitReviewPage from './page';

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

const PENDING = [
  { account_id: 'acct-1', full_name: 'Sample Athlete One', athlete_id: 'ath-1', uploaded_at: '2026-08-01T12:00:00Z' },
  { account_id: 'acct-2', full_name: 'Sample Athlete Two', athlete_id: 'ath-2', uploaded_at: '2026-08-02T12:00:00Z' },
];

const originalFetch = global.fetch;
const originalConfirm = window.confirm;

afterEach(() => {
  global.fetch = originalFetch;
  window.confirm = originalConfirm;
  jest.clearAllMocks();
});

test('lists the pending-review queue', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, portraits: PENDING })) as unknown as typeof fetch;

  render(<PortraitReviewPage />);

  await screen.findByText('Sample Athlete One');
  expect(screen.getByText('Sample Athlete Two')).toBeInTheDocument();
});

test('an empty queue renders the empty state, not a blank table', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, portraits: [] })) as unknown as typeof fetch;

  render(<PortraitReviewPage />);

  await screen.findByText('Nothing pending');
});

test('a failed load shows the error state, never a false "nothing pending"', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<PortraitReviewPage />);

  await screen.findByText('Database unavailable');
  expect(screen.getByText('The queue could not be loaded')).toBeInTheDocument();
  expect(screen.queryByText('Nothing pending')).not.toBeInTheDocument();
});

test('approving posts decision=approve for that account and reloads the queue', async () => {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ account_id: 'acct-1', decision: 'approve' });
      return jsonResponse({ ok: true, review_state: 'released' });
    }
    return jsonResponse({ ok: true, portraits: PENDING });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);

  await waitFor(() => expect(screen.getByText('Portrait approved.')).toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/api/pilot/admin/portrait-review'),
    expect.objectContaining({ method: 'POST' }),
  );
});

test('rejecting asks for confirmation first and does nothing if declined', async () => {
  window.confirm = jest.fn().mockReturnValue(false);
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true, portraits: PENDING }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);

  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  // Only the initial GET happened -- no POST was ever sent.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('rejecting, once confirmed, posts decision=reject', async () => {
  window.confirm = jest.fn().mockReturnValue(true);
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ account_id: 'acct-1', decision: 'reject' });
      return jsonResponse({ ok: true, review_state: 'blocked' });
    }
    return jsonResponse({ ok: true, portraits: PENDING });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);

  await waitFor(() => expect(screen.getByText('Portrait rejected.')).toBeInTheDocument());
});

test("a pending decision on one row never disables another row's buttons, and starting a second row's decision does not re-enable the first row's still-in-flight buttons", async () => {
  let resolveFirstPost: (value: Response) => void = () => {};
  const firstPostPromise = new Promise<Response>((resolve) => {
    resolveFirstPost = resolve;
  });

  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (body.account_id === 'acct-1') {
        return firstPostPromise;
      }
      return Promise.resolve(jsonResponse({ ok: true, review_state: 'released' }));
    }
    return Promise.resolve(jsonResponse({ ok: true, portraits: PENDING }));
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  const approveButtons = screen.getAllByRole('button', { name: 'Approve' });
  fireEvent.click(approveButtons[0]); // acct-1 -- its request stays in flight

  await waitFor(() => expect(approveButtons[0]).toBeDisabled());
  // A different row's in-flight request must never disable this one.
  expect(approveButtons[1]).not.toBeDisabled();

  fireEvent.click(approveButtons[1]); // acct-2 -- resolves immediately
  await waitFor(() => expect(screen.getByText('Portrait approved.')).toBeInTheDocument());
  // Starting and finishing row 2's decision must not touch row 1's pending state.
  expect(approveButtons[0]).toBeDisabled();

  resolveFirstPost(jsonResponse({ ok: true, review_state: 'released' }));
  await waitFor(() => expect(approveButtons[0]).not.toBeDisabled());
});

test('a failed decision surfaces the server error rather than silently reloading', async () => {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return jsonResponse({ error: 'Unsupported: portrait was already decided by another reviewer' }, false);
    }
    return jsonResponse({ ok: true, portraits: PENDING });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);

  await screen.findByText('Unsupported: portrait was already decided by another reviewer');
});
