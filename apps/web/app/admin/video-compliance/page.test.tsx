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
    previous_review_note: null,
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
    previous_review_note: null,
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

test('lists the pending-review queue with every ticket-mandated field: title, description, athlete, uploader, and upload date', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: PENDING })) as unknown as typeof fetch;

  render(<VideoCompliancePage />);

  await screen.findByText('Sparring Round 1');
  expect(screen.getByText('Session footage.')).toBeInTheDocument();
  expect(screen.getByText('Sample Athlete One')).toBeInTheDocument();
  expect(screen.getByText('Coach Alice')).toBeInTheDocument();
  // Not an exact formatted-string match -- toLocaleString's output shifts
  // with the runner's timezone. The month name is enough to prove
  // formatDate(item.created_at) actually rendered, not an empty cell. Both
  // fixture rows are in August, so at least one match is expected.
  expect(screen.getAllByText(/Aug/).length).toBeGreaterThan(0);
  expect(screen.getByText('Footwork Drill')).toBeInTheDocument();
});

test('an item whose athlete/uploader identity lookup failed falls back to the raw id, not a blank cell', async () => {
  const noNames = [
    { ...PENDING[0], athlete_name: null, uploader_name: null },
  ];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: noNames })) as unknown as typeof fetch;

  render(<VideoCompliancePage />);

  await screen.findByText('Sparring Round 1');
  expect(screen.getByText('ath-1')).toBeInTheDocument();
  expect(screen.getByText('acct-coach')).toBeInTheDocument();
});

test('a re-queued item (manual_review) shows the previous-review badge and note', async () => {
  const requeued = [
    { ...PENDING[0], compliance_check_status: 'manual_review', previous_review_note: 'Trim the last 10 seconds.' },
  ];
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: requeued })) as unknown as typeof fetch;

  render(<VideoCompliancePage />);

  await screen.findByText('Sparring Round 1');
  expect(screen.getByText('Changes were previously requested on this video')).toBeInTheDocument();
  expect(screen.getByText(/Trim the last 10 seconds\./)).toBeInTheDocument();
});

test('a first-pass item (pending) shows neither the previous-review badge nor a note', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: PENDING })) as unknown as typeof fetch;

  render(<VideoCompliancePage />);

  await screen.findByText('Sparring Round 1');
  expect(screen.queryByText('Changes were previously requested on this video')).not.toBeInTheDocument();
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

// Round-6 review finding: two decisions on two different rows can each
// trigger their own reload, and nothing guaranteed the responses landed in
// the order they were sent. Simulates R1 (issued first, for pub-1's
// decision) resolving AFTER R2 (issued second, for pub-2's decision) --
// the fresher R2 must win, not be overwritten by the stale R1.
test('an out-of-order reload response never overwrites a fresher one', async () => {
  window.prompt = jest.fn();
  let resolveFirstReload: (value: Response) => void = () => {};
  const firstReloadPromise = new Promise<Response>((resolve) => {
    resolveFirstReload = resolve;
  });

  let getCount = 0;
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return Promise.resolve(jsonResponse({ ok: true, status: 'approved', publication_id: body.publication_id }));
    }
    getCount += 1;
    if (getCount === 1) {
      // Initial mount load -- resolves immediately.
      return Promise.resolve(jsonResponse({ ok: true, items: PENDING }));
    }
    if (getCount === 2) {
      // R1: triggered by deciding pub-1. Stays pending until released below.
      return firstReloadPromise;
    }
    // R2: triggered by deciding pub-2, arrives before R1 resolves.
    return Promise.resolve(
      jsonResponse({
        ok: true,
        items: [{ ...PENDING[0], title: 'Sparring Round 1 (fresher)' }],
      }),
    );
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<VideoCompliancePage />);
  await screen.findByText('Sparring Round 1');

  const approveButtons = screen.getAllByRole('button', { name: 'Approve' });
  fireEvent.click(approveButtons[0]); // decide pub-1 -> fires R1, left pending
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3)); // mount GET, pub-1 POST, R1 GET

  fireEvent.click(approveButtons[1]); // decide pub-2 -> fires R2, resolves immediately
  await screen.findByText('Sparring Round 1 (fresher)');

  // R1 (stale) resolves last -- it must NOT stomp the fresher state R2 set.
  resolveFirstReload(jsonResponse({ ok: true, items: PENDING }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByText('Sparring Round 1 (fresher)')).toBeInTheDocument();
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

const DRAFTS = [
  {
    publication_id: 'pub-draft-1',
    title: 'Orphaned Draft',
    description: 'Created by a coach who left.',
    athlete_id: 'ath-3',
    athlete_name: 'Sample Athlete Three',
    uploader_account_id: 'acct-departed',
    uploader_name: 'Coach Departed',
    created_at: '2026-08-03T12:00:00Z',
  },
];

test('stranded drafts are listed with their creator and a submit-for-review lever', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: [], drafts: DRAFTS })) as unknown as typeof fetch;

  render(<VideoCompliancePage />);

  await screen.findByText('Drafts not yet submitted');
  expect(screen.getByText('Orphaned Draft')).toBeInTheDocument();
  expect(screen.getByText('Coach Departed')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Submit for review' })).toBeInTheDocument();
});

test('no drafts means no drafts section at all', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, items: PENDING, drafts: [] })) as unknown as typeof fetch;

  render(<VideoCompliancePage />);

  await screen.findByText('Sparring Round 1');
  expect(screen.queryByText('Drafts not yet submitted')).not.toBeInTheDocument();
});

test('submitting a draft posts to the submit route and moves it into the queue on reload', async () => {
  let submitted = false;
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/pilot/publications/submit')) {
      submitted = true;
      expect(JSON.parse(String(init?.body))).toEqual({ publication_id: 'pub-draft-1' });
      return jsonResponse({ ok: true, publication_id: 'pub-draft-1', status: 'pending_review' });
    }
    return jsonResponse(
      submitted
        ? { ok: true, items: PENDING, drafts: [] }
        : { ok: true, items: [], drafts: DRAFTS },
    );
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<VideoCompliancePage />);
  await screen.findByText('Orphaned Draft');

  fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));

  await screen.findByText('Draft submitted into the review queue.');
  await waitFor(() => expect(screen.queryByText('Drafts not yet submitted')).not.toBeInTheDocument());
  expect(screen.getByText('Sparring Round 1')).toBeInTheDocument();
});

test("a refused draft submit surfaces the server's reason", async () => {
  const fetchMock = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/publications/submit')) {
      return jsonResponse({ error: 'Only a draft can be submitted for review.' }, false);
    }
    return jsonResponse({ ok: true, items: [], drafts: DRAFTS });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<VideoCompliancePage />);
  await screen.findByText('Orphaned Draft');

  fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));

  await screen.findByText('Only a draft can be submitted for review.');
});
