/**
 * @jest-environment jsdom
 */

// Lane AS-10, PR AS10-3 (app scrub OFF-03; Overwatch Q1 A, Q2 A, Q3 A): the
// morning check's queues on the Gym Office. Each row names its page by the
// page's own title, links it, and counts what that page shows as waiting from
// the page's own read. A read that fails is never 0; a cut read never looks
// whole; no name or row detail reaches the screen.

import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import GymOfficeQueues, {
  FEEDBACK_NEW_LIMIT,
  QUEUES,
  SHADOW_REVIEWS_LIMIT,
  VIDEO_COMPLIANCE_LIMIT,
  VIDEO_LIST_LIMIT,
  queueWords,
  type QueueSpec,
} from './GymOfficeQueues';
import GymOfficeSafetyStrip from './GymOfficeSafetyStrip';
import { BUILDING } from './buildingMap';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className }: { readonly children: ReactNode; readonly href: string; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const NAME = 'Jordan Fixture';
const waiverRow = (active: boolean, statuses: string[]) => ({
  athlete_id: `ath-${Math.random()}`,
  athlete_name: NAME,
  active_flag: active,
  waivers: Object.fromEntries(['general', 'medical_release', 'photo_media', 'travel'].map((type, i) => [type, statuses[i] ?? 'signed'])),
});

/** Payloads in each route's own shape, with names in them that must never reach the screen. */
const PAYLOADS: Record<string, unknown> = {
  '/api/pilot/admin/waiver-status': {
    ok: true,
    items: [
      waiverRow(true, ['missing']),
      waiverRow(true, ['signed', 'signed', 'declined']),
      waiverRow(true, []),
      waiverRow(false, ['missing']), // inactive: not on the page's default view
    ],
  },
  '/api/pilot/admin/athlete-consent': {
    items: [
      { athlete_id: 'a1', athlete_name: NAME, consent_ok: false },
      { athlete_id: 'a2', athlete_name: NAME, consent_ok: true },
      { athlete_id: 'a3', athlete_name: NAME, consent_ok: false },
    ],
  },
  '/api/pilot/publications/create?status=pending_review': { items: [{ publication_id: 'p1', title: NAME }, { publication_id: 'p2', title: NAME }] },
  '/api/pilot/video/list?scope=all': {
    items: [
      { video_id: 'v1', title: NAME, status: 'quarantined', scan_state: 'clear' },
      { video_id: 'v2', title: NAME, status: 'ready', scan_state: 'needs_human_review' },
      { video_id: 'v3', title: NAME, status: 'ready', scan_state: 'blocked' },
      { video_id: 'v4', title: NAME, status: 'ready', scan_state: 'clear' },
    ],
  },
  '/api/pilot/admin/portrait-review': { portraits: [{ account_id: 'x', display_name: NAME }] },
  // Asked for triage_status 'new' only, so only new rows come back.
  '/api/pilot/feedback/list': {
    items: [
      { triage_status: 'new', message: NAME },
      { triage_status: 'new', message: NAME },
    ],
  },
  '/api/pilot/shadow/reviews?status=open': { reviews: [{ review_id: 'r1', summary: NAME }, { review_id: 'r2', summary: NAME }, { review_id: 'r3', summary: NAME }] },
  '/api/pilot/admin/credentials': {
    items: [
      { band: 'expired', name: NAME },
      { band: 'submitted', name: NAME },
      { band: 'expiring_soon', name: NAME },
      { band: 'revoked', name: NAME },
      { band: 'current', name: NAME },
      { band: 'missing', name: NAME },
      { band: 'not_required', name: NAME },
    ],
  },
};

type Answer = { status: number; body: unknown } | 'network-error';

function routes(overrides: Record<string, Answer> = {}) {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const answer: Answer = overrides[url] ?? { status: 200, body: PAYLOADS[url] ?? {} };
    if (answer === 'network-error') throw new TypeError('Failed to fetch');
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as Response;
  }) as unknown as typeof fetch;
}

function rowOf(title: string) {
  return screen.getByRole('link', { name: title }).closest('li') as HTMLElement;
}

async function settled() {
  await screen.findByText('2 pending review');
}

test('every title is the queue page\'s own h1', () => {
  for (const spec of QUEUES) {
    const page = readFileSync(path.resolve(__dirname, '..', `app${spec.href}/page.tsx`), 'utf8');
    // The h1 element's text, however the JSX wraps it.
    const h1 = /<h1[^>]*>\s*([^<{]+?)\s*<\/h1>/.exec(page)?.[1];
    expect(h1).toBe(spec.title);
  }
});

test('every queue is a page the gym admin may open, named by the page\'s own title', () => {
  expect(QUEUES.map((spec) => spec.title)).toEqual([
    'Waiver Compliance',
    'Media Consent Audit',
    'Video Compliance Review',
    'Video Scan Review',
    'Portrait Review',
    'Feedback Triage',
    'SHADOW Human Review',
    'Staff Credentials',
  ]);
  for (const spec of QUEUES) {
    const door = BUILDING.find((entry) => entry.href === spec.href);
    expect(door?.label).toBe(spec.title);
    expect(Array.isArray(door?.roles) && (door?.roles as readonly string[]).includes('admin')).toBe(true);
  }
});

test('each row counts what its page shows as waiting, and links the page', async () => {
  routes();
  render(<GymOfficeQueues />);
  await settled();
  const expected: Array<[string, string, string]> = [
    ['Waiver Compliance', '/admin/waiver-status', '2 missing a waiver'],
    ['Media Consent Audit', '/admin/athlete-consent', '2 missing consent'],
    ['Video Compliance Review', '/admin/video-compliance', '2 pending review'],
    ['Video Scan Review', '/admin/video-review', '3 quarantined or flagged'],
    ['Portrait Review', '/admin/portrait-review', '1 pending'],
    ['Feedback Triage', '/admin/feedback', '2 new'],
    ['SHADOW Human Review', '/admin/shadow-reviews', '3 open'],
    ['Staff Credentials', '/admin/credentials', '4 needing attention'],
  ];
  for (const [title, href, words] of expected) {
    expect(screen.getByRole('link', { name: title }).getAttribute('href')).toBe(href);
    expect(within(rowOf(title)).getByText(words)).toBeTruthy();
  }
});

test('reads each page\'s own request, and never the console read that signs footage links', async () => {
  routes();
  render(<GymOfficeQueues />);
  await settled();
  const calls = (global.fetch as jest.Mock).mock.calls.map(([url, init]) => [String(url), (init as RequestInit)?.method ?? 'GET', (init as RequestInit)?.body ?? null]);
  expect(calls).toEqual(expect.arrayContaining([
    ['/api/pilot/admin/waiver-status', 'GET', null],
    ['/api/pilot/admin/athlete-consent', 'GET', null],
    ['/api/pilot/publications/create?status=pending_review', 'GET', null],
    ['/api/pilot/video/list?scope=all', 'GET', null],
    ['/api/pilot/admin/portrait-review', 'GET', null],
    ['/api/pilot/feedback/list', 'POST', JSON.stringify({ triage_status: 'new', limit: 100 })],
    ['/api/pilot/shadow/reviews?status=open', 'GET', null],
    ['/api/pilot/admin/credentials', 'GET', null],
  ]));
  expect(calls).toHaveLength(8);
  expect(calls.some(([url]) => String(url).includes('/api/pilot/admin/video-compliance'))).toBe(false);
});

test('counts only: no name or row detail reaches the screen', async () => {
  routes();
  const { container } = render(<GymOfficeQueues />);
  await settled();
  expect(container.textContent).not.toContain(NAME);
});

test.each([
  ['a refused read', { status: 403, body: { error: 'Forbidden' } } as Answer],
  ['a failed read', { status: 500, body: { error: 'boom' } } as Answer],
  ['a network failure', 'network-error' as Answer],
  ['a payload in another shape', { status: 200, body: { ok: true } } as Answer],
  ['a refusal that still carries an empty list', { status: 403, body: { items: [] } } as Answer],
])('%s says "Could not be read", never 0, and the other rows still count', async (_label, answer) => {
  routes({ '/api/pilot/admin/credentials': answer, '/api/pilot/admin/waiver-status': answer });
  render(<GymOfficeQueues />);
  await settled();
  for (const title of ['Staff Credentials', 'Waiver Compliance']) {
    const row = rowOf(title);
    expect(within(row).getByText('Could not be read')).toBeTruthy();
    expect(row.textContent).not.toMatch(/\d/);
  }
  expect(within(rowOf('SHADOW Human Review')).getByText('3 open')).toBeTruthy();
});

test('a waiver or consent row the page could not judge makes the whole count unread, not a smaller number', async () => {
  routes({
    '/api/pilot/admin/waiver-status': { status: 200, body: { items: [waiverRow(true, ['missing']), { athlete_id: 'x', active_flag: true }] } },
    '/api/pilot/admin/athlete-consent': { status: 200, body: { items: [{ athlete_id: 'a1', consent_ok: false }, { athlete_id: 'a2' }] } },
  });
  render(<GymOfficeQueues />);
  await settled();
  expect(within(rowOf('Waiver Compliance')).getByText('Could not be read')).toBeTruthy();
  expect(within(rowOf('Media Consent Audit')).getByText('Could not be read')).toBeTruthy();
});

test('a read cut at its limit says so: "50+" for a whole queue, "in the newest ..." for a filter over a cut list', async () => {
  const many = (n: number, row: (i: number) => unknown) => Array.from({ length: n }, (_, i) => row(i));
  routes({
    '/api/pilot/publications/create?status=pending_review': { status: 200, body: { items: many(50, (i) => ({ publication_id: `p${i}` })) } },
    '/api/pilot/video/list?scope=all': {
      status: 200,
      body: { items: many(50, (i) => ({ video_id: `v${i}`, status: i < 4 ? 'quarantined' : 'ready', scan_state: 'clear' })) },
    },
    '/api/pilot/feedback/list': { status: 200, body: { items: many(100, () => ({ triage_status: 'new' })) } },
    '/api/pilot/shadow/reviews?status=open': { status: 200, body: { reviews: many(200, (i) => ({ review_id: `r${i}` })) } },
  });
  render(<GymOfficeQueues />);
  await screen.findByText('50+ pending review');
  expect(within(rowOf('Video Scan Review')).getByText('4 quarantined or flagged in the newest 50 uploads')).toBeTruthy();
  expect(within(rowOf('Feedback Triage')).getByText('100+ new')).toBeTruthy();
  expect(within(rowOf('SHADOW Human Review')).getByText('200+ open')).toBeTruthy();
});

test('one slow read never holds the others back', async () => {
  routes();
  const inner = global.fetch as jest.Mock;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === '/api/pilot/admin/athlete-consent' ? new Promise<Response>(() => undefined) : inner(input, init)) as unknown as typeof fetch;
  render(<GymOfficeQueues />);
  await settled();
  expect(within(rowOf('Media Consent Audit')).getByText('Reading…')).toBeTruthy();
  expect(within(rowOf('Staff Credentials')).getByText('4 needing attention')).toBeTruthy();
});

test('queueWords: reading, unread, whole, plus-cut and window-cut', () => {
  const spec = QUEUES.find((item) => item.key === 'video-scan') as QueueSpec;
  const plus = QUEUES.find((item) => item.key === 'shadow-reviews') as QueueSpec;
  expect(queueWords(spec, { state: 'reading' })).toBe('Reading…');
  expect(queueWords(spec, { state: 'unread' })).toBe('Could not be read');
  expect(queueWords(spec, { state: 'read', count: { n: 0, cut: false } })).toBe('0 quarantined or flagged');
  expect(queueWords(spec, { state: 'read', count: { n: 0, cut: true } })).toBe('0 quarantined or flagged in the newest 50 uploads');
  expect(queueWords(plus, { state: 'read', count: { n: 200, cut: true } })).toBe('200+ open');
});

test('the Gym Office strip is one morning check: the five safety counts first, then the queues', async () => {
  routes({
    '/api/pilot/admin/safety-review': {
      status: 200,
      body: { ok: true, openHolds: [], failingGates: [], openEscalations: [], openViolations: [], openFlags: [], violationsTruncated: false },
    },
  });
  render(<GymOfficeSafetyStrip />);
  const section = screen.getByRole('region', { name: 'Morning check' });
  await within(section).findByText('2 pending review');
  const headings = within(section).getAllByRole('heading').map((heading) => heading.textContent);
  expect(headings).toEqual(['Morning check', 'Safety', 'Needs review']);
  expect(within(section).getByText('Training holds')).toBeTruthy();
});

test('one row short of a limit is a whole count, said without "+" or a window', async () => {
  const many = (n: number, row: (i: number) => unknown) => Array.from({ length: n }, (_, i) => row(i));
  routes({
    '/api/pilot/publications/create?status=pending_review': { status: 200, body: { items: many(VIDEO_COMPLIANCE_LIMIT - 1, (i) => ({ publication_id: `p${i}` })) } },
    '/api/pilot/video/list?scope=all': {
      status: 200,
      body: { items: many(VIDEO_LIST_LIMIT - 1, (i) => ({ video_id: `v${i}`, status: i < 2 ? 'quarantined' : 'ready', scan_state: 'clear' })) },
    },
    '/api/pilot/feedback/list': { status: 200, body: { items: many(FEEDBACK_NEW_LIMIT - 1, () => ({ triage_status: 'new' })) } },
    '/api/pilot/shadow/reviews?status=open': { status: 200, body: { reviews: many(SHADOW_REVIEWS_LIMIT - 1, (i) => ({ review_id: `r${i}` })) } },
  });
  render(<GymOfficeQueues />);
  await screen.findByText(`${VIDEO_COMPLIANCE_LIMIT - 1} pending review`);
  expect(within(rowOf('Video Scan Review')).getByText('2 quarantined or flagged')).toBeTruthy();
  expect(within(rowOf('Feedback Triage')).getByText(`${FEEDBACK_NEW_LIMIT - 1} new`)).toBeTruthy();
  expect(within(rowOf('SHADOW Human Review')).getByText(`${SHADOW_REVIEWS_LIMIT - 1} open`)).toBeTruthy();
});

test.each([
  ['Video Scan Review', '/api/pilot/video/list?scope=all', { items: [{ video_id: 'v1', status: 'quarantined' }] }],
  ['Feedback Triage', '/api/pilot/feedback/list', { items: [{ triage_status: 'new' }, { triage_status: 'done' }] }],
  ['Staff Credentials', '/api/pilot/admin/credentials', { items: [{ band: 'expired' }, { name: 'no band' }] }],
  ['Waiver Compliance', '/api/pilot/admin/waiver-status', { items: [{ athlete_id: 'x', active_flag: true, waivers: {} }] }],
])('%s: a row in a shape the count does not know makes the read unread, never a smaller number', async (title, url, body) => {
  routes({ [url]: { status: 200, body } });
  render(<GymOfficeQueues />);
  await settled();
  expect(within(rowOf(title)).getByText('Could not be read')).toBeTruthy();
});

// The words "50+", "in the newest 50 uploads" and "200+" are only true while
// these numbers are the routes' own limits. Read them from the routes.
describe('the limits are the routes\' own', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  test('video list and publications default to 50 rows', () => {
    expect(read('app/api/pilot/video/list/route.ts')).toContain(`const limit = parseSafeLimit(searchParams.get('limit'), ${VIDEO_LIST_LIMIT}, 100);`);
    expect(read('app/api/pilot/publications/create/route.ts')).toContain(
      `const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), ${VIDEO_COMPLIANCE_LIMIT}, 100);`,
    );
  });

  test('the SHADOW review queue reads at most 200', () => {
    const source = read('src/server/pilot/shadowConversations.ts');
    const query = source.slice(source.indexOf('from pilot.shadow_human_review_queue\n     where organization_id = $1 and status = $2'));
    expect(query).toMatch(new RegExp(`^[\\s\\S]*?limit ${SHADOW_REVIEWS_LIMIT}\``));
  });

  test('the feedback route returns at least the 100 asked for', () => {
    const max = Number(/const FEEDBACK_LIST_MAX_LIMIT = (\d+);/.exec(read('src/server/pilot/feedback.ts'))?.[1]);
    expect(max).toBeGreaterThanOrEqual(FEEDBACK_NEW_LIMIT);
  });
});

test('every read goes with the session cookie', async () => {
  routes();
  render(<GymOfficeQueues />);
  await settled();
  for (const [, init] of (global.fetch as jest.Mock).mock.calls) {
    expect((init as RequestInit).credentials).toBe('include');
  }
});

test('leaving the page stops the reads and sets nothing afterwards', async () => {
  const answers: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    signals.push((init as RequestInit).signal as AbortSignal);
    return new Promise<Response>((resolve) => {
      answers.push(() => resolve({ ok: true, status: 200, json: async () => PAYLOADS[String(input)] ?? {} } as Response));
    });
  }) as unknown as typeof fetch;
  const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const { unmount } = render(<GymOfficeQueues />);
  unmount();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  for (const answer of answers) answer();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});
