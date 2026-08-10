/**
 * @jest-environment jsdom
 */

// The admin console for quarantined video.
//
// POST /api/pilot/video/scan-review existed and worked for the whole time
// 'blocked' had no exit: no .tsx file anywhere called it, so the refusal
// message telling a coach to "ask an administrator to review it" pointed at a
// surface that did not exist. These tests pin the things that make this page
// worth having rather than its layout: it offers only decisions the server
// will accept, it sends the shape scan-review actually reads, it does not let
// a reviewer release footage of a child sight-unseen, and it never reports a
// settled queue when the queue merely failed to load.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import VideoReviewPage from './page';
import { getRoleSessionSnapshot } from '@/components/roleSession';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/roleSession', () => ({
  __esModule: true,
  getRoleSessionSnapshot: jest.fn(() => ({ role: 'admin' })),
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

const QUARANTINED = {
  video_session_id: 'vid-blocked',
  title: 'Tuesday sparring',
  notes: 'Dark gym, mostly footwork',
  file_name: 'tuesday.mp4',
  file_size_bytes: 1024,
  mime_type: 'video/mp4',
  status: 'quarantined',
  scan_state: 'blocked',
  athlete_id: 'ath-001',
  uploaded_by_account_id: 'coach-1',
  created_at: '2026-08-04T18:00:00.000Z',
};

// Two rows the server would refuse a decision on, for different reasons:
// 'infected' is refused on every surface by authorizeVideoScanReview, and a
// 'ready' video has nothing to review.
const INFECTED = { ...QUARANTINED, video_session_id: 'vid-infected', status: 'infected', scan_state: 'blocked', file_name: 'bad.mp4' };
const READY = { ...QUARANTINED, video_session_id: 'vid-ready', status: 'ready', scan_state: 'clean', file_name: 'fine.mp4' };

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
  (getRoleSessionSnapshot as jest.Mock).mockReturnValue({ role: 'admin' });
});

function mockApi(options: {
  items?: unknown[];
  listOk?: boolean;
  linkOk?: boolean;
  reviewOk?: boolean;
  reviewBody?: unknown;
} = {}) {
  const {
    items = [QUARANTINED],
    listOk = true,
    linkOk = true,
    reviewOk = true,
    reviewBody = { ok: true, status: 'ready', scan_state: 'human_approved' },
  } = options;

  return jest.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/video/list')) {
      return listOk ? jsonResponse({ items }) : jsonResponse({ error: 'Database unavailable' }, false);
    }
    if (target.includes('/video/review-link')) {
      return linkOk
        ? jsonResponse({
            ok: true,
            url: 'https://blob.example/vid-blocked?sig=x',
            expires_in_minutes: 15,
            scan_detail: 'Content screen: low confidence match',
          })
        : jsonResponse({ error: 'Not found', reason: 'VIDEO_SESSION_NOT_FOUND' }, false);
    }
    if (target.includes('/video/scan-review')) {
      return jsonResponse(reviewBody, reviewOk);
    }
    void init;
    return jsonResponse({}, false);
  });
}

async function renderQueue(fetchMock: jest.Mock) {
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<VideoReviewPage />);
  await screen.findByText('Tuesday sparring');
}

function sentBody(fetchMock: jest.Mock, fragment: string) {
  const call = fetchMock.mock.calls.find(([u]) => String(u).includes(fragment));
  return JSON.parse(String((call?.[1] as RequestInit).body));
}

it('lists only the videos the review route will actually accept a decision on', async () => {
  const fetchMock = mockApi({ items: [QUARANTINED, INFECTED, READY] });
  await renderQueue(fetchMock);

  expect(screen.getByText('File: tuesday.mp4')).toBeTruthy();
  // A malware verdict is not a judgment call and no reviewer may overturn it;
  // offering the row would offer a decision that always 409s.
  expect(screen.queryByText('File: bad.mp4')).toBeNull();
  expect(screen.queryByText('File: fine.mp4')).toBeNull();
});

it('tells the reviewer what the machine concluded, not the raw column', async () => {
  const fetchMock = mockApi();
  await renderQueue(fetchMock);

  expect(screen.getByText('Content screen refused it')).toBeTruthy();
});

// The rubber stamp this whole review path exists to avoid. Approve is the only
// control on the page that widens who can watch a child's footage.
it('will not release footage that has not been opened', async () => {
  const fetchMock = mockApi();
  await renderQueue(fetchMock);

  expect(screen.getByRole('button', { name: /approve and release/i }).hasAttribute('disabled')).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: /watch first/i }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /approve and release/i }).hasAttribute('disabled')).toBe(false),
  );

  // And the reviewer is shown what the scanner objected to, which only
  // review-link carries.
  expect(screen.getByText(/Content screen: low confidence match/)).toBeTruthy();
  expect(screen.getByText(/Link expires in 15 minutes/)).toBeTruthy();
});

it('sends the shape scan-review reads when approving', async () => {
  const fetchMock = mockApi();
  await renderQueue(fetchMock);

  fireEvent.click(screen.getByRole('button', { name: /watch first/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /approve and release/i }).hasAttribute('disabled')).toBe(false));

  fireEvent.change(screen.getByLabelText(/reviewer notes/i), { target: { value: 'Watched it, ordinary footwork drill.' } });
  fireEvent.click(screen.getByRole('button', { name: /approve and release/i }));

  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/scan-review'))).toBe(true));

  const sent = sentBody(fetchMock, '/scan-review');
  expect(sent.video_session_id).toBe('vid-blocked');
  expect(sent.decision).toBe('approve');
  expect(sent.notes).toBe('Watched it, ordinary footwork drill.');

  expect(await screen.findByText(/Approved\. The video is now released/i)).toBeTruthy();
});

// Refusing footage without watching it is always safe, so block is never
// gated -- and it must say plainly that nothing widened, because a reviewer
// who thinks a block "did something" to access is reading the opposite of the
// truth.
it('records a block without requiring the clip to be opened, and says nothing widened', async () => {
  const fetchMock = mockApi({ reviewBody: { ok: true, status: 'quarantined', scan_state: 'human_blocked' } });
  await renderQueue(fetchMock);

  expect(screen.getByRole('button', { name: /^block$/i }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /^block$/i }));

  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/scan-review'))).toBe(true));

  const sent = sentBody(fetchMock, '/scan-review');
  expect(sent.decision).toBe('block');
  expect(await screen.findByText(/stays quarantined/i)).toBeTruthy();
  expect(screen.getByText(/nothing widened/i)).toBeTruthy();
});

// The route's own 409. Telling a reviewer their decision stuck when another
// admin had already settled the row is the one lie this screen must not tell.
it('reports a decision that did not stick instead of claiming success', async () => {
  const fetchMock = mockApi({
    reviewOk: false,
    reviewBody: {
      error: 'This video changed state while you were reviewing it. Reload and check before deciding again.',
      reason: 'VIDEO_SESSION_CHANGED',
    },
  });
  await renderQueue(fetchMock);

  fireEvent.click(screen.getByRole('button', { name: /^block$/i }));

  expect(await screen.findByText(/changed state while you were reviewing it/i)).toBeTruthy();
  expect(screen.queryByText(/stays quarantined/i)).toBeNull();
});

it('surfaces a refused decision with the server’s own reason', async () => {
  const fetchMock = mockApi({ reviewOk: false, reviewBody: { error: 'Forbidden: role not allowed' } });
  await renderQueue(fetchMock);

  fireEvent.click(screen.getByRole('button', { name: /^block$/i }));

  expect(await screen.findByText(/Forbidden: role not allowed/i)).toBeTruthy();
});

// "No videos are waiting for review" on a failed request tells an
// administrator that footage of a minor is settled while it sits in
// quarantine. Same failure the consent screen is pinned against.
it('never reports an empty queue when the queue failed to load', async () => {
  const fetchMock = mockApi({ listOk: false });
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<VideoReviewPage />);

  expect(await screen.findByText(/Database unavailable/i)).toBeTruthy();
  expect(screen.queryByText(/No videos are waiting for review/i)).toBeNull();
});

it('says the queue is empty only when it loaded and was empty', async () => {
  const fetchMock = mockApi({ items: [] });
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<VideoReviewPage />);

  expect(await screen.findByText(/No videos are waiting for review/i)).toBeTruthy();
});

it('reports a playback link that could not be issued rather than failing silently', async () => {
  const fetchMock = mockApi({ linkOk: false });
  await renderQueue(fetchMock);

  fireEvent.click(screen.getByRole('button', { name: /watch first/i }));

  expect(await screen.findByText(/Not found/i)).toBeTruthy();
  // Still refused, because nothing was watched.
  expect(screen.getByRole('button', { name: /approve and release/i }).hasAttribute('disabled')).toBe(true);
});

// VIDEO_REVIEW_DECIDE_ROLES is organization_admin alone. A platform owner
// meeting this console would otherwise get a queue whose every decision the
// server refuses.
it('sends a platform owner to the right console instead of a dead one', async () => {
  (getRoleSessionSnapshot as jest.Mock).mockReturnValue({ role: 'platform_owner' });
  const fetchMock = mockApi();
  global.fetch = fetchMock as unknown as typeof fetch;
  render(<VideoReviewPage />);

  expect(await screen.findByText(/Quarantined video is reviewed by the gym/i)).toBeTruthy();
  expect(screen.queryByText('Awaiting Review')).toBeNull();
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/video/list'))).toBe(false);
});
