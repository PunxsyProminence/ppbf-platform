/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import VideoCompliancePage from './page';

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
  {
    publication_id: 'pub-1',
    title: 'Sparring Round 1',
    description: 'Session footage.',
    athlete_id: 'ath-1',
    athlete_name: 'Sample Athlete One',
    uploader_account_id: 'acct-coach',
    uploader_name: 'Coach Alice',
    created_at: '2026-08-01T12:00:00Z',
    compliance_check_status: 'pending',
    stream_url: 'https://blob.example/vs-1',
  },
  {
    publication_id: 'pub-2',
    title: 'Footwork Drill',
    description: 'Drill footage.',
    athlete_id: 'ath-2',
    athlete_name: 'Sample Athlete Two',
    uploader_account_id: 'acct-coach-2',
    uploader_name: 'Coach Bob',
    created_at: '2026-08-02T12:00:00Z',
    compliance_check_status: 'pending',
    stream_url: null,
  },
];

const originalFetch = global.fetch;
const originalPrompt = window.prompt;

afterEach(() => {
  global.fetch = originalFetch;
  window.prompt = originalPrompt;
  jest.clearAllMocks();
});

test('lists the pending-review queue with athlete and uploader names', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: PENDING })) as unknown as typeof fetch;

  render(<VideoCompliancePage />);

  await screen.findByText('Sparring Round 1');
  expect(screen.getByText('Sample Athlete One')).toBeInTheDocument();
  expect(screen.getByText('Coach Alice')).toBeInTheDocument();
  expect(screen.getByText('Footwork Drill')).toBeInTheDocument();
});

test('a video with no stream_url shows the not-playable state instead of a broken player', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: PENDING })) as unknown as typeof fetch;

  render(<VideoCompliancePage />);

  await screen.findByText('Footwork Drill');
  expect(screen.getByText('Video not playable')).toBeInTheDocument();
});

test('an empty queue renders the empty state, not a blank list', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] })) as unknown as typeof fetch;

  render(<VideoCompliancePage />);

  await screen.findByText('Nothing pending');
});

test('a failed load shows the error state, never a false "nothing pending"', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'Database unavailable' }, false)) as unknown as typeof fetch;

  render(<VideoCompliancePage />);

  await screen.findByText('Database unavailable');
  expect(screen.getByText('The queue could not be loaded')).toBeInTheDocument();
  expect(screen.queryByText('Nothing pending')).not.toBeInTheDocument();
});

test('approving posts decision=approve with no note prompt', async () => {
  window.prompt = jest.fn();
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ publication_id: 'pub-1', decision: 'approve', note: undefined });
      return jsonResponse({ ok: true, status: 'approved' });
    }
    return jsonResponse({ ok: true, items: PENDING });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<VideoCompliancePage />);
  await screen.findByText('Sparring Round 1');

  fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);

  await waitFor(() => expect(screen.getByText('Video approved for publication.')).toBeInTheDocument());
  expect(window.prompt).not.toHaveBeenCalled();
});

test('rejecting prompts for a reason and sends it as the note', async () => {
  window.prompt = jest.fn().mockReturnValue('Off-topic subject visible in frame.');
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ publication_id: 'pub-1', decision: 'reject', note: 'Off-topic subject visible in frame.' });
      return jsonResponse({ ok: true, status: 'rejected' });
    }
    return jsonResponse({ ok: true, items: PENDING });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<VideoCompliancePage />);
  await screen.findByText('Sparring Round 1');

  fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);

  await waitFor(() => expect(screen.getByText('Video rejected.')).toBeInTheDocument());
});

test('rejecting with an empty reason sends no request', async () => {
  window.prompt = jest.fn().mockReturnValue('   ');
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: PENDING }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<VideoCompliancePage />);
  await screen.findByText('Sparring Round 1');

  fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);

  await waitFor(() => expect(screen.getByText(/needs a stated reason/)).toBeInTheDocument());
  // Only the initial GET happened -- no POST was ever sent.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('cancelling the reason prompt sends no request', async () => {
  window.prompt = jest.fn().mockReturnValue(null);
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: PENDING }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<VideoCompliancePage />);
  await screen.findByText('Sparring Round 1');

  fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);

  await waitFor(() => expect(window.prompt).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('requesting changes prompts for what needs to change', async () => {
  window.prompt = jest.fn().mockReturnValue('Trim the last 10 seconds.');
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ publication_id: 'pub-1', decision: 'request_changes', note: 'Trim the last 10 seconds.' });
      return jsonResponse({ ok: true, status: 'pending_review' });
    }
    return jsonResponse({ ok: true, items: PENDING });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<VideoCompliancePage />);
  await screen.findByText('Sparring Round 1');

  fireEvent.click(screen.getAllByRole('button', { name: 'Request Changes' })[0]);

  await waitFor(() => expect(screen.getByText('Changes requested.')).toBeInTheDocument());
});

test("a pending decision on one row never disables another row's buttons", async () => {
  window.prompt = jest.fn();
  let resolveFirstPost: (value: Response) => void = () => {};
  const firstPostPromise = new Promise<Response>((resolve) => {
    resolveFirstPost = resolve;
  });

  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (body.publication_id === 'pub-1') {
        return firstPostPromise;
      }
      return Promise.resolve(jsonResponse({ ok: true, status: 'approved' }));
    }
    return Promise.resolve(jsonResponse({ ok: true, items: PENDING }));
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<VideoCompliancePage />);
  await screen.findByText('Sparring Round 1');

  const approveButtons = screen.getAllByRole('button', { name: 'Approve' });
  fireEvent.click(approveButtons[0]); // pub-1 -- stays in flight

  await waitFor(() => expect(approveButtons[0]).toBeDisabled());
  expect(approveButtons[1]).not.toBeDisabled();

  resolveFirstPost(jsonResponse({ ok: true, status: 'approved' }));
  await waitFor(() => expect(approveButtons[0]).not.toBeDisabled());
});

test('a failed decision surfaces the server error rather than silently reloading', async () => {
  window.prompt = jest.fn();
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return jsonResponse({ error: 'Unsupported: publication was already decided by another reviewer' }, false);
    }
    return jsonResponse({ ok: true, items: PENDING });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<VideoCompliancePage />);
  await screen.findByText('Sparring Round 1');

  fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);

  await screen.findByText('Unsupported: publication was already decided by another reviewer');
});
