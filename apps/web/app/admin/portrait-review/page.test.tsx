/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

/** The queue row for one member, so a per-row control is never picked by index. */
function rowFor(fullName: string): HTMLElement {
  const row = screen.getByText(fullName).closest('tr');
  if (!row) throw new Error(`no queue row for ${fullName}`);
  return row as HTMLElement;
}

function approveButton(fullName: string): HTMLElement {
  return within(rowFor(fullName)).getByRole('button', { name: 'Approve' });
}

function portraitAltText(fullName: string): string {
  return `Portrait submitted for ${fullName}, awaiting review`;
}

/**
 * Do what a reviewer has to do before they are allowed to approve: put the
 * photograph on screen and let it paint. jsdom never loads an <img>, so the load
 * event is fired by hand -- which is also the only honest way to test the gate,
 * because painting the bytes is precisely the thing being required.
 */
async function inspectPortrait(fullName: string): Promise<HTMLElement> {
  fireEvent.click(within(rowFor(fullName)).getByRole('button', { name: 'Show portrait' }));
  const image = await screen.findByAltText(portraitAltText(fullName));
  fireEvent.load(image);
  return image;
}

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

test('no child\'s face is on screen until the reviewer asks for one', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, portraits: PENDING })) as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  // The queue itself is metadata. Opening this console must not paint two
  // children's photographs onto a screen in a shared office.
  expect(screen.queryByAltText(portraitAltText('Sample Athlete One'))).not.toBeInTheDocument();
  expect(screen.queryByAltText(portraitAltText('Sample Athlete Two'))).not.toBeInTheDocument();
});

test('showing a portrait serves it from the review-only route, never from the released read path', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, portraits: PENDING })) as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  const image = await inspectPortrait('Sample Athlete One');

  // /api/pilot/profile/photo/[accountId] runs decidePortrait() and answers 404
  // for anything not 'released', so pointing at it here would render a broken
  // image and leave the reviewer judging metadata again.
  expect(image.getAttribute('src')).toContain('/api/pilot/admin/portrait-review/photo/acct-1');
  expect(image.getAttribute('src')).not.toContain('/api/pilot/profile/photo/');
  // A bare <img>: the Next optimizer's shared, server-side cache must never
  // hold a session-scoped, undecided photograph of a child.
  expect(image.tagName).toBe('IMG');
});

test('approve is refused until the reviewer has actually looked at the portrait', async () => {
  window.confirm = jest.fn().mockReturnValue(true);
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true, portraits: PENDING }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  expect(approveButton('Sample Athlete One')).toBeDisabled();
  // The refusal is in ink on the row (Law 7) and it is also in words, so the
  // reviewer is never left guessing at a greyed control.
  expect(within(rowFor('Sample Athlete One')).getByText('Not viewed')).toBeInTheDocument();
  expect(screen.getByTestId('approve-gate-acct-1')).toBeInTheDocument();

  // And no release escapes even if the click lands anyway.
  fireEvent.click(approveButton('Sample Athlete One'));
  expect(fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
  expect(window.confirm).not.toHaveBeenCalled();
});

test('a portrait the browser could not render is not an inspection', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, portraits: PENDING })) as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  fireEvent.click(within(rowFor('Sample Athlete One')).getByRole('button', { name: 'Show portrait' }));
  const image = await screen.findByAltText(portraitAltText('Sample Athlete One'));
  fireEvent.error(image);

  // A 404 (already decided by another reviewer, or bytes gone) or a file that
  // will not decode leaves Approve exactly as shut as it was.
  expect(approveButton('Sample Athlete One')).toBeDisabled();
  expect(screen.getByText('Portrait unavailable')).toBeInTheDocument();
});

test('looking at one member\'s portrait does not unlock approval for another', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true, portraits: PENDING })) as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  await inspectPortrait('Sample Athlete One');

  expect(approveButton('Sample Athlete One')).not.toBeDisabled();
  expect(approveButton('Sample Athlete Two')).toBeDisabled();
});

test('replacing the pending photo re-locks approve -- the attestation is about the photograph, not the member', async () => {
  window.confirm = jest.fn().mockReturnValue(true);
  // Second load of the queue: acct-1 is still pending, but with a NEW
  // photo_uploaded_at, i.e. the member replaced the photo the reviewer looked at.
  const REUPLOADED = [
    { ...PENDING[0], uploaded_at: '2026-08-03T09:30:00Z' },
  ];
  let queueReads = 0;
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return jsonResponse({ ok: true, review_state: 'blocked' });
    queueReads += 1;
    return jsonResponse({ ok: true, portraits: queueReads === 1 ? PENDING : REUPLOADED });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  await inspectPortrait('Sample Athlete One');
  expect(approveButton('Sample Athlete One')).not.toBeDisabled();

  // Deciding the other row reloads the queue, which is when the replacement
  // arrives. Rejecting is the decision that needs no inspection, so it is the
  // one that can drive this.
  fireEvent.click(within(rowFor('Sample Athlete Two')).getByRole('button', { name: 'Reject' }));
  await waitFor(() => expect(screen.queryByText('Sample Athlete Two')).not.toBeInTheDocument());

  expect(approveButton('Sample Athlete One')).toBeDisabled();
  expect(screen.getByTestId('approve-gate-acct-1')).toBeInTheDocument();
});

test('approving posts decision=approve for that account and reloads the queue', async () => {
  // Approve now requires the reviewer to have seen the photograph and to
  // confirm the attestation, so the happy path has to do both before it can
  // prove the route contract it was written to prove.
  window.confirm = jest.fn().mockReturnValue(true);
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

  await inspectPortrait('Sample Athlete One');
  fireEvent.click(approveButton('Sample Athlete One'));

  await waitFor(() => expect(screen.getByText('Portrait approved.')).toBeInTheDocument());
  expect(window.confirm).toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/api/pilot/admin/portrait-review'),
    expect.objectContaining({ method: 'POST' }),
  );
});

test('cancelling the approve confirmation abandons the release', async () => {
  window.confirm = jest.fn().mockReturnValue(false);
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ ok: true, portraits: PENDING }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  await inspectPortrait('Sample Athlete One');
  fireEvent.click(approveButton('Sample Athlete One'));

  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  // Only the initial GET happened -- no POST was ever sent.
  expect(fetchMock).toHaveBeenCalledTimes(1);
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

test('rejecting, once confirmed, posts decision=reject -- and never needs the portrait to have been viewed', async () => {
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

  // No inspection anywhere in this test, on purpose: the gate sits only on the
  // releasing direction. Refusing a photograph must never be slowed down.
  fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);

  await waitFor(() => expect(screen.getByText('Portrait rejected.')).toBeInTheDocument());
});

test("a pending decision on one row never disables another row's buttons, and starting a second row's decision does not re-enable the first row's still-in-flight buttons", async () => {
  window.confirm = jest.fn().mockReturnValue(true);
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

  // Both rows are inspected up front: Approve is now gated on having seen the
  // photograph, and this test is about the in-flight bookkeeping, not the gate.
  // Only one portrait is on screen at a time, which is exactly why "have I seen
  // this one" is tracked separately from "is one showing now".
  await inspectPortrait('Sample Athlete One');
  await inspectPortrait('Sample Athlete Two');

  const firstApprove = approveButton('Sample Athlete One');
  const secondApprove = approveButton('Sample Athlete Two');
  fireEvent.click(firstApprove); // acct-1 -- its request stays in flight

  await waitFor(() => expect(firstApprove).toBeDisabled());
  // A different row's in-flight request must never disable this one.
  expect(secondApprove).not.toBeDisabled();

  fireEvent.click(secondApprove); // acct-2 -- resolves immediately
  await waitFor(() => expect(screen.getByText('Portrait approved.')).toBeInTheDocument());
  // Starting and finishing row 2's decision must not touch row 1's pending state.
  expect(firstApprove).toBeDisabled();

  resolveFirstPost(jsonResponse({ ok: true, review_state: 'released' }));
  await waitFor(() => expect(firstApprove).not.toBeDisabled());
});

test('a failed decision surfaces the server error rather than silently reloading', async () => {
  window.confirm = jest.fn().mockReturnValue(true);
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return jsonResponse({ error: 'Unsupported: portrait was already decided by another reviewer' }, false);
    }
    return jsonResponse({ ok: true, portraits: PENDING });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<PortraitReviewPage />);
  await screen.findByText('Sample Athlete One');

  await inspectPortrait('Sample Athlete One');
  fireEvent.click(approveButton('Sample Athlete One'));

  await screen.findByText('Unsupported: portrait was already decided by another reviewer');
  // The portrait stays on screen after a refused decision: the reviewer is
  // still working on this row.
  expect(screen.getByAltText(portraitAltText('Sample Athlete One'))).toBeInTheDocument();
});
