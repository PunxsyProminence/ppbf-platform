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

// The athlete saw this attempt saved at October 11, 11:39 PM. The row printed
// the first ten characters of the ISO text, which is the UTC day: 2026-10-12.
test('the attempt row shows the gym day and time the athlete saw, not the UTC date', async () => {
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  global.fetch = mockReviewFetch(capture, {
    ...MISSED_ATTEMPT,
    review_state: null,
    attempted_at: '2026-10-12T03:39:53.000Z',
  });

  await pickAthlete();

  expect(screen.getByText(/Oct 11, 2026, 11:39 PM/)).toBeTruthy();
  expect(screen.queryByText(/2026-10-12/)).toBeNull();
});

test('the review history shows the gym day and time a review was written, not the UTC date', async () => {
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  const base = mockReviewFetch(capture, { ...MISSED_ATTEMPT, review_state: null });
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/training-attempts/review') && !init?.method) {
      return {
        ok: true,
        json: async () => ({
          items: [{
            review_id: 'rv-1',
            review_state: 'confirmed',
            corrected_target_value: null,
            corrected_achieved_value: null,
            corrected_made: null,
            reason: '',
            reviewed_at: '2026-10-12T03:45:00.000Z',
          }],
        }),
      } as Response;
    }
    return base(input, init);
  }) as unknown as typeof fetch;

  await pickAthlete();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'History' })); });

  expect(await screen.findByText(/Oct 11, 2026, 11:45 PM · confirmed/)).toBeTruthy();
  expect(screen.queryByText(/2026-10-12/)).toBeNull();
});

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

// BASE06-D003 / P2-B: a nonempty corrected target must parse to a finite
// positive number before the correction posts; a nonnumeric value must NOT
// silently serialize to null. Blank stays a valid target-less measurement.
async function openCorrect() {
  await pickAthlete();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Correct' })); });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Corrected achieved'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'miscount confirmed on film' } });
  });
}

test('a nonnumeric corrected target is rejected client-side and no review posts', async () => {
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  global.fetch = mockReviewFetch(capture, { ...MISSED_ATTEMPT, review_state: null });

  await openCorrect();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Corrected target (optional)'), { target: { value: 'abc' } });
  });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save correction' })); });

  expect(capture.reviews).toHaveLength(0);
  expect(screen.getByText(/must be a number above 0/i)).toBeTruthy();
});

test('a non-positive corrected target is rejected client-side and no review posts', async () => {
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  global.fetch = mockReviewFetch(capture, { ...MISSED_ATTEMPT, review_state: null });

  await openCorrect();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Corrected target (optional)'), { target: { value: '0' } });
  });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save correction' })); });

  expect(capture.reviews).toHaveLength(0);
});

test('a blank corrected target posts as a target-less measurement (null)', async () => {
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  global.fetch = mockReviewFetch(capture, { ...MISSED_ATTEMPT, review_state: null });

  await openCorrect();
  // target left blank
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save correction' })); });

  expect(capture.reviews).toHaveLength(1);
  expect(capture.reviews[0]).toMatchObject({ review_state: 'corrected', corrected_target_value: null, corrected_achieved_value: 10 });
});

test('a valid positive corrected target posts unchanged as a number', async () => {
  const capture = { reviews: [] as Array<Record<string, unknown>> };
  global.fetch = mockReviewFetch(capture, { ...MISSED_ATTEMPT, review_state: null });

  await openCorrect();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Corrected target (optional)'), { target: { value: '12' } });
  });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save correction' })); });

  expect(capture.reviews).toHaveLength(1);
  expect(capture.reviews[0]).toMatchObject({ corrected_target_value: 12, corrected_achieved_value: 10 });
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

// Lane N3-01. The picker lists the whole gym; attempts are per athlete, and a
// coach is refused on an athlete who is not theirs (OD-2026-10-05-024 item 2).
// What these pin: the rows on screen always belong to the athlete picked -- a
// refused athlete shows nothing from the athlete before, and neither a review
// nor a record that finishes late can paint one athlete under another's name.
// And the record form sends a target only when it is a real one.

const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Jordan P.' },
  { athlete_id: 'ath-2', full_name: 'Casey R.' },
];

const CASEY_ATTEMPT = {
  ...MISSED_ATTEMPT,
  attempt_id: 'att-9',
  athlete_name: 'Casey R.',
  note: 'held the pace',
  review_state: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

// Two athletes. `listFor` answers each athlete's list read; `post` answers
// every POST (record or review) and records what was sent.
function mockRosterFetch(options: {
  listFor: (athleteId: string) => Response | Promise<Response>;
  post?: () => Response | Promise<Response>;
  posts?: Array<Record<string, unknown>>;
}) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/athletes/list')) return okJson({ items: ROSTER });
    if (init?.method === 'POST') {
      options.posts?.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return options.post ? options.post() : okJson({ item: {} });
    }
    if (url.includes('/training-attempts/review')) return okJson({ items: [] });
    return options.listFor(url.includes('athlete_id=ath-2') ? 'ath-2' : 'ath-1');
  }) as unknown as typeof fetch;
}

async function pick(athleteId: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: athleteId } });
  });
}

test('an athlete the server refuses shows nothing from the athlete before -- no rows, no review controls', async () => {
  global.fetch = mockRosterFetch({
    listFor: (athleteId) => (athleteId === 'ath-1'
      ? okJson({ items: [{ ...MISSED_ATTEMPT, review_state: null }] })
      : ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) }) as Response),
  });

  await act(async () => { render(<AttemptLogPage />); });
  await pick('ath-1');
  expect(await screen.findByText('gassed at 300m')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();

  await pick('ath-2');
  expect(await screen.findByText('Unable to load attempts.')).toBeTruthy();

  // Jordan's attempt is not Casey's, and must not sit under Casey's name.
  expect(screen.queryByText('gassed at 300m')).toBeNull();
  expect(screen.queryByText('missed')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Dispute' })).toBeNull();
});

test('a review that finishes after the coach switches athlete never paints the old athlete under the new one', async () => {
  const review = deferred<Response>();
  global.fetch = mockRosterFetch({
    listFor: (athleteId) => okJson({
      items: [athleteId === 'ath-1' ? { ...MISSED_ATTEMPT, review_state: null } : CASEY_ATTEMPT],
    }),
    post: () => review.promise,
  });

  await act(async () => { render(<AttemptLogPage />); });
  await pick('ath-1');
  await screen.findByText('gassed at 300m');

  // Confirm Jordan's attempt; the answer is still on its way...
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });
  // ...when the coach moves to Casey.
  await pick('ath-2');
  expect(await screen.findByText('held the pace')).toBeTruthy();

  // The review lands and reloads JORDAN's attempts. They belong to nobody on
  // screen now.
  await act(async () => { review.resolve(okJson({ item: {} })); });

  expect(screen.getByText('held the pace')).toBeTruthy();
  expect(screen.queryByText('gassed at 300m')).toBeNull();
});

test('a refusal for one athlete does not stay on screen once the coach picks nobody', async () => {
  global.fetch = mockRosterFetch({
    listFor: () => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) }) as Response,
  });

  await act(async () => { render(<AttemptLogPage />); });
  await pick('ath-2');
  expect(await screen.findByText('Unable to load attempts.')).toBeTruthy();

  // Nobody picked: nothing was refused for nobody.
  await pick('');
  expect(screen.queryByText('Unable to load attempts.')).toBeNull();
});

test('the athlete picker is held while a record is in flight', async () => {
  const record = deferred<Response>();
  global.fetch = mockRosterFetch({
    listFor: () => okJson({ items: [{ ...MISSED_ATTEMPT, review_state: null }] }),
    post: () => record.promise,
  });

  await act(async () => { render(<AttemptLogPage />); });
  await pick('ath-1');
  await screen.findByText('gassed at 300m');
  const picker = screen.getByLabelText('Athlete') as HTMLSelectElement;
  expect(picker.disabled).toBe(false);

  await act(async () => { fireEvent.change(screen.getByLabelText('Achieved'), { target: { value: '12' } }); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Record attempt' })); });
  expect(picker.disabled).toBe(true);

  await act(async () => { record.resolve(okJson({ item: {} })); });
  expect(picker.disabled).toBe(false);
});

describe('the record form sends a target only when it is a real one', () => {
  async function recordWithTarget(target: string): Promise<Array<Record<string, unknown>>> {
    const posts: Array<Record<string, unknown>> = [];
    global.fetch = mockRosterFetch({ listFor: () => okJson({ items: [] }), posts });

    await act(async () => { render(<AttemptLogPage />); });
    await pick('ath-1');
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/^Target/), { target: { value: target } });
      fireEvent.change(screen.getByLabelText('Achieved'), { target: { value: '12' } });
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Record attempt' })); });
    return posts;
  }

  // "1O" is the letter O. Sent as a number it is NaN, which JSON turns into
  // null: the attempt would be stored as a measurement with no verdict.
  test.each(['1O', 'abc', '0', '-5'])('a target of "%s" never leaves the page', async (target) => {
    const posts = await recordWithTarget(target);

    expect(posts).toHaveLength(0);
    expect(screen.getByText('Target must be a number above 0, or leave it blank for a measurement.')).toBeTruthy();
  });

  test('a real target posts as that number', async () => {
    const posts = await recordWithTarget('10');

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ athlete_id: 'ath-1', target_value: 10, achieved_value: 12 });
    expect(posts[0]).not.toHaveProperty('made');
  });
});
