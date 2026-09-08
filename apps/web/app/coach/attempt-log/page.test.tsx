/**
 * @jest-environment jsdom
 */

// The attempt log. What these pin: recording posts the raw facts (target,
// achieved) and NEVER a client-computed verdict; a missed attempt renders
// with its miss badge, not hidden; an empty target posts null (a
// measurement); and the page frames misses as the point.

import { act, fireEvent, render, screen } from '@testing-library/react';

import AttemptLogPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The page reads the current normalized role from the authoritative session
// store (the same getRoleSessionSnapshot/subscribeRoleSession pair the admin
// pages use) to decide whether the review mutation controls are the current
// actor's capability. getSnapshot must return a stable reference across
// renders, so the mock caches the snapshot and rebuilds it only when the test
// changes the role.
let mockedSnapshot: { role: string } | null = { role: 'coach' };
function setMockedRole(role: string | null) {
  mockedSnapshot = role ? { role } : null;
}
jest.mock('@/components/roleSession', () => ({
  getRoleSessionSnapshot: () => mockedSnapshot,
  subscribeRoleSession: () => () => {},
}));

beforeEach(() => {
  setMockedRole('coach');
});

const MISSED_ATTEMPT = {
  attempt_id: 'att-1',
  athlete_name: 'Jordan P.',
  context_type: 'open_sparring',
  metric_kind: 'time_seconds',
  direction: 'at_most',
  target_value: '90',
  achieved_value: '92',
  made: false,
  note: 'gassed at 300m',
  attempted_at: '2026-08-15T22:00:00.000Z',
};

function mockFetch(capture: { posts: unknown[] }) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/training-attempts') && init?.method === 'POST') {
      capture.posts.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/training-attempts')) {
      return { ok: true, json: async () => ({ items: [MISSED_ATTEMPT] }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('a missed attempt renders with its miss badge and note -- failures are shown, not smoothed', async () => {
  global.fetch = mockFetch({ posts: [] });

  await act(async () => {
    render(<AttemptLogPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });

  expect(await screen.findByText('missed')).toBeTruthy();
  expect(screen.getByText(/92s \/ target 90s/)).toBeTruthy();
  expect(screen.getByText('gassed at 300m')).toBeTruthy();
  expect(screen.getByText(/the misses are the point/i)).toBeTruthy();
});

test('recording posts raw facts only; an empty target posts null (a measurement)', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<AttemptLogPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/Achieved/), { target: { value: '12' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record attempt' }));
  });

  expect(capture.posts).toHaveLength(1);
  const posted = capture.posts[0] as Record<string, unknown>;
  expect(posted).toMatchObject({ athlete_id: 'ath-1', metric_kind: 'reps', target_value: null, achieved_value: 12 });
  // The verdict is the server's to compute.
  expect(posted).not.toHaveProperty('made');
});

test('a sparring-context miss posts its context and renders it -- where it failed is part of the fact', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<AttemptLogPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Context (where it happened)'), { target: { value: 'sparring_drills' } });
    fireEvent.change(screen.getByLabelText(/Achieved/), { target: { value: '3' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record attempt' }));
  });

  expect(capture.posts).toHaveLength(1);
  expect(capture.posts[0]).toMatchObject({ context_type: 'sparring_drills' });
  // The listed miss shows where it happened.
  expect(screen.getByText(/open sparring/)).toBeTruthy();
});

test('a non-numeric achieved never leaves the page', async () => {
  const capture = { posts: [] as unknown[] };
  global.fetch = mockFetch(capture);

  await act(async () => {
    render(<AttemptLogPage />);
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Record attempt' }));
  });

  expect(capture.posts).toHaveLength(0);
  expect(screen.getByText(/Achieved must be a non-negative number/)).toBeTruthy();
});

// BASE-06 coach review. What these pin: confirm posts a review and never a
// verdict; a correction posts the corrected numbers and its reason, never a
// verdict; a dispute needs a reason before it will post; and a reviewed
// attempt shows the coach's disposition BESIDE the athlete's source numbers,
// never over them.

const REVIEWED_ATTEMPT = {
  attempt_id: 'att-2',
  athlete_name: 'Jordan P.',
  context_type: 'assessment',
  metric_kind: 'reps',
  direction: 'at_least',
  target_value: '10',
  achieved_value: '8',
  made: false,
  note: '',
  attempted_at: '2026-08-15T22:00:00.000Z',
  recorded_by_role: 'athlete',
  review_state: 'corrected',
  corrected_target_value: '10',
  corrected_achieved_value: '10',
  corrected_made: true,
  review_reason: 'miscount confirmed on film',
};

function mockReviewFetch(capture: { reviews: Array<Record<string, unknown>> }, listItem: Record<string, unknown>) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/training-attempts/review') && init?.method === 'POST') {
      capture.reviews.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ item: {} }) } as Response;
    }
    if (url.includes('/training-attempts/review')) {
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }
    if (url.includes('/training-attempts')) {
      return { ok: true, json: async () => ({ items: [listItem] }) } as Response;
    }
    if (url.includes('/athletes/list')) {
      return { ok: true, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Jordan P.' }] }) } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
}

async function pickAthlete() {
  await act(async () => { render(<AttemptLogPage />); });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });
  await screen.findByText('missed');
}

test('confirming an attempt posts a confirmed review and no verdict', async () => {
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  global.fetch = mockReviewFetch(capture, { ...MISSED_ATTEMPT, review_state: null });

  await pickAthlete();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  });

  expect(capture.reviews).toHaveLength(1);
  expect(capture.reviews[0]).toMatchObject({ attempt_id: 'att-1', review_state: 'confirmed' });
  expect(capture.reviews[0]).not.toHaveProperty('corrected_made');
  expect(capture.reviews[0]).not.toHaveProperty('made');
});

test('a correction posts corrected numbers and a reason, never a verdict', async () => {
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  global.fetch = mockReviewFetch(capture, { ...MISSED_ATTEMPT, review_state: null });

  await pickAthlete();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Correct' })); });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Corrected achieved'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Corrected target (optional)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'miscount confirmed on film' } });
  });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save correction' })); });

  expect(capture.reviews).toHaveLength(1);
  expect(capture.reviews[0]).toMatchObject({
    attempt_id: 'att-1',
    review_state: 'corrected',
    corrected_achieved_value: 10,
    corrected_target_value: 10,
    reason: 'miscount confirmed on film',
  });
  expect(capture.reviews[0]).not.toHaveProperty('corrected_made');
});

test('a dispute will not post without a reason', async () => {
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  global.fetch = mockReviewFetch(capture, { ...MISSED_ATTEMPT, review_state: null });

  await pickAthlete();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dispute' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save dispute' })); });

  expect(capture.reviews).toHaveLength(0);
  expect(screen.getByText(/a reason of at least 10 characters/i)).toBeTruthy();
});

test('a corrected attempt shows the coach correction beside the athlete source, not over it', async () => {
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  global.fetch = mockReviewFetch(capture, REVIEWED_ATTEMPT);

  await act(async () => { render(<AttemptLogPage />); });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });

  // Athlete source is still shown as recorded (8, missed) ...
  expect(await screen.findByText('missed')).toBeTruthy();
  expect(screen.getByText(/8reps \/ target 10reps/)).toBeTruthy();
  // ... and the coach correction is shown beside it (10, made).
  expect(screen.getByText(/Coach correction:/)).toBeTruthy();
  expect(screen.getByText(/miscount confirmed on film/)).toBeTruthy();
  expect(screen.getByText(/Recorded by athlete/)).toBeTruthy();
});

// BASE06-D001: only an actor BASE-06 authorizes to mutate reviews (coach) may
// see the confirm/correct/dispute controls. An admin retains read-only page
// access -- source attempts and review state stay visible -- but the mutation
// controls are not offered, matching the server's coach-only route.
test('an admin sees the attempt and its review state but no review mutation controls', async () => {
  setMockedRole('admin');
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  global.fetch = mockReviewFetch(capture, REVIEWED_ATTEMPT);

  await act(async () => { render(<AttemptLogPage />); });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: 'ath-1' } });
  });

  // Read-only visibility is preserved: the source attempt and the coach review
  // both render for an admin.
  expect(await screen.findByText('missed')).toBeTruthy();
  expect(screen.getByText(/Coach correction:/)).toBeTruthy();
  // But the mutation controls are not this actor's capability.
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Dispute' })).toBeNull();
});

test('a coach does see the review mutation controls', async () => {
  setMockedRole('coach');
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  global.fetch = mockReviewFetch(capture, { ...MISSED_ATTEMPT, review_state: null });

  await pickAthlete();

  expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Correct' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Dispute' })).toBeTruthy();
});
