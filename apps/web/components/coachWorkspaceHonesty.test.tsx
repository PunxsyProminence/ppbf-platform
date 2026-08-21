/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { AnnouncementItem } from './AnnouncementBanner';
import CoachWorkspace from './CoachWorkspace';

interface RouteResponses {
  floorPlans?: () => Promise<Response>;
  reviewProjection?: () => Promise<Response>;
  coachReviews?: () => Promise<Response>;
  announcements?: () => Promise<Response>;
  intakeReviewAction?: (body: { intake_case_id?: string; action?: string }) => Promise<Response>;
  painReports?: () => Promise<Response>;
  barrierReports?: () => Promise<Response>;
  athletesList?: () => Promise<Response> | Response;
  readinessBoard?: () => Promise<Response> | Response;
  sessionsList?: (athleteId: string) => Promise<Response> | Response;
  coachReviewsList?: (sessionId: string) => Promise<Response> | Response;
  escalationsGet?: () => Promise<Response> | Response;
  escalationsPost?: (body: { action?: string; escalation_id?: string }) => Promise<Response> | Response;
}

function announcement(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  return {
    announcement_id: 'ann_1',
    message: 'Lock the room in before the first bell.',
    author_name: 'Coach J.',
    author_role: 'coach',
    created_at: '2026-07-30T12:00:00.000Z',
    placement: 'coach_workspace',
    kind: 'motivation',
    active: true,
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(routes: RouteResponses = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_coach_1' });
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return routes.athletesList ? routes.athletesList() : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/coach/readiness-board')) {
      // Default: a healthy feed with no fresh check-ins -- everyone UNKNOWN.
      return routes.readinessBoard ? routes.readinessBoard() : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/sessions/list')) {
      const athleteId = new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '';
      return routes.sessionsList ? routes.sessionsList(athleteId) : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/floor-plans')) {
      return routes.floorPlans ? routes.floorPlans() : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/shadow/review-projection')) {
      return routes.reviewProjection ? routes.reviewProjection() : jsonResponse({ queue: [] });
    }
    if (url.includes('/api/pilot/shadow/observation-projection')) {
      return jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/coach-reviews/list')) {
      const sessionId = new URL(url, 'http://localhost').searchParams.get('session_id') ?? '';
      return routes.coachReviewsList ? routes.coachReviewsList(sessionId) : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/coach-reviews')) {
      return routes.coachReviews ? routes.coachReviews() : jsonResponse({ ok: true });
    }
    if (url.includes('/api/pilot/announcements/get')) {
      return routes.announcements ? routes.announcements() : jsonResponse({ ok: true, announcements: [] });
    }
    if (url.includes('/api/pilot/coach/pain-reports')) {
      return routes.painReports ? routes.painReports() : jsonResponse({ ok: true, painReports: [], windowDays: 14, truncated: false });
    }
    if (url.includes('/api/pilot/coach/barrier-reports')) {
      return routes.barrierReports ? routes.barrierReports() : jsonResponse({ ok: true, barrierReports: [], truncated: false });
    }
    if (url.includes('/api/pilot/escalations')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; escalation_id?: string };
        if (routes.escalationsPost) return routes.escalationsPost(body);
        return jsonResponse({ ok: true, escalation: { escalation_id: body.escalation_id, status: 'acknowledged' } });
      }
      return routes.escalationsGet ? routes.escalationsGet() : jsonResponse({ ok: true, escalations: [] });
    }
    if (url.includes('/api/pilot/intake/review-action')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { intake_case_id?: string; action?: string };
      if (routes.intakeReviewAction) return routes.intakeReviewAction(body);
      const status = body.action === 'approve' ? 'approved' : 'rejected';
      return jsonResponse({ ok: true, intake_case_id: body.intake_case_id, status });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderWorkspace(routes: RouteResponses = {}): Promise<jest.Mock> {
  const fetchMock = installFetch(routes);
  await act(async () => {
    render(<CoachWorkspace />);
  });
  return fetchMock;
}

// A tab carrying a pending-count badge (see StatusBadge in CoachWorkspace.tsx)
// has that count in its accessible name too -- "Tasks 3 pending", not just
// "Tasks" -- so this matches on the label as a prefix rather than requiring
// an exact string that only holds when the queue happens to be empty.
function openTab(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}\\b`) }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

/** A pilot.sessions row as GET /api/pilot/sessions/list returns it. */
function sessionRow(sessionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: sessionId,
    athlete_id: 'ath_1',
    date: '2026-08-10',
    rpe: 6,
    notes: 'Worked angles off the jab.',
    completed_flag: true,
    created_at: '2026-08-10T18:00:00.000Z',
    updated_at: '2026-08-10T19:00:00.000Z',
    ...overrides,
  };
}

/** Selects an athlete on the review picker and waits for the session list. */
async function pickReviewAthlete(athleteId: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Athlete'), { target: { value: athleteId } });
  });
}

describe('coach workspace does not fabricate the coach\'s own records', () => {
  test('Development shows no certification or expiry date, because none are stored', async () => {
    // Hardcoded credentials with expiry dates read as this coach's real
    // licensing status; an unexpired date is a safety claim, not decoration.
    await renderWorkspace();
    openTab('Development');

    expect(screen.queryByText(/Bronze Certification/i)).toBeNull();
    expect(screen.queryByText(/USA Boxing Coach License/i)).toBeNull();
    expect(screen.queryByText(/Expires:/i)).toBeNull();
    expect(screen.getAllByText(/Planned — Not Yet Implemented/i).length).toBeGreaterThan(0);
  });

  test('Development topics are a reference list, not controls that save nothing', async () => {
    await renderWorkspace();
    openTab('Development');

    expect(screen.queryByText('Injury Prevention Basics')).not.toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('floor tab presents a plan template, not a running session', () => {
  test('no session progress bar and no per-block status badges', async () => {
    await renderWorkspace();
    openTab('Floor');

    expect(screen.queryByText(/Session Workout Plan/i)).not.toBeNull();
    // The bar rendered a completion figure ("Session Progress: 40%"). Matching
    // the bare words would also match copy that says progress is NOT tracked.
    expect(screen.queryByText(/Session Progress:/i)).toBeNull();
    expect(screen.queryByText(/\d+%/)).toBeNull();
    expect(screen.queryByText('Not Started')).toBeNull();
    expect(screen.queryByText('In Progress')).toBeNull();
    expect(screen.queryByText('Completed')).toBeNull();
  });
});

describe('read failures are never rendered as an empty queue', () => {
  test('failed floor-plan fetch shows an error and Retry, not "no plans received yet"', async () => {
    const fetchMock = await renderWorkspace({
      floorPlans: async () => jsonResponse({}, { ok: false, status: 500 }),
    });
    openTab('Athlete Floor Plans');

    expect(screen.queryByText(/No athlete floor plans received yet/i)).toBeNull();
    expect(screen.queryByText(/Error loading athlete floor plans/i)).not.toBeNull();

    const planCallsBeforeRetry = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/pilot/floor-plans'),
    ).length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry loading athlete floor plans' }));
    });
    const planCallsAfterRetry = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/pilot/floor-plans'),
    ).length;
    expect(planCallsAfterRetry).toBe(planCallsBeforeRetry + 1);
  });

  test('failed review-queue fetch stops the Tasks board claiming the queue is clear', async () => {
    await renderWorkspace({
      reviewProjection: async () => jsonResponse({}, { ok: false, status: 503 }),
    });
    openTab('Tasks');

    expect(screen.queryByText(/Unable to load the SHADOW review queue/i)).not.toBeNull();
    expect(screen.queryByText(/No open tasks\. Items appear here/i)).toBeNull();
    expect(screen.queryByText(/an empty board means the queue is clear/i)).toBeNull();
  });

  test('a healthy but empty review queue still says the board is clear', async () => {
    await renderWorkspace();
    openTab('Tasks');

    expect(screen.queryByText(/Unable to load the SHADOW review queue/i)).toBeNull();
    expect(screen.queryByText(/No open tasks\. Items appear here/i)).not.toBeNull();
  });
});

describe('coach review submission', () => {
  test('a double-click persists exactly one review', async () => {
    let releaseReview: (() => void) | undefined;
    const fetchMock = await renderWorkspace({
      athletesList: () => jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'Jordan P.' }] }),
      sessionsList: () => jsonResponse({ items: [sessionRow('session_1')] }),
      coachReviews: () =>
        new Promise<Response>((resolve) => {
          releaseReview = () => resolve(jsonResponse({ ok: true }));
        }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');
    fireEvent.change(screen.getByLabelText('Session'), {
      target: { value: 'session_1' },
    });

    const saveButton = screen.getByRole('button', { name: /Save Coach Review/i });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    fireEvent.click(screen.getByRole('button', { name: /Saving/i }));

    const reviewCalls = () =>
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes('/api/pilot/coach-reviews') && !String(call[0]).includes('/list')).length;
    expect(reviewCalls()).toBe(1);

    await act(async () => {
      releaseReview?.();
    });
    await waitFor(() => expect(screen.queryByText(/Coach review persisted/i)).not.toBeNull());
    expect(reviewCalls()).toBe(1);

    // The guard releases after the request settles, so a genuine second review
    // is still possible.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save Coach Review/i }));
    });
    expect(reviewCalls()).toBe(2);
  });
});

// The escalation inbox: /api/pilot/escalations already authorizes coaches
// (roster + coverage scoped, athlete_voice excluded) and lets them
// acknowledge -- and no coach surface consumed it, so the platform's only
// safety-alarm mechanism had no bell on the coach side.
describe('safety escalations inbox', () => {
  function escalation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      escalation_id: 'esc_1',
      athlete_id: 'ath_1',
      source_type: 'pain_report',
      severity: 'high',
      reason: 'Pain score 8 reported after sparring round.',
      status: 'open',
      created_at: '2026-08-14T18:00:00.000Z',
      ...overrides,
    };
  }

  const rosterWithNames = () =>
    jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'Jordan P.' }] });

  test('open escalations reach the coach with the athlete named and the reason in full', async () => {
    await renderWorkspace({
      athletesList: rosterWithNames,
      escalationsGet: () =>
        jsonResponse({
          ok: true,
          escalations: [
            escalation(),
            escalation({ escalation_id: 'esc_2', source_type: 'near_miss', severity: 'critical', athlete_id: 'ath_unknown' }),
          ],
        }),
    });

    expect(screen.queryByText('Safety Escalations')).not.toBeNull();
    // The name also renders on the roster tab, so assert presence, not
    // uniqueness.
    expect(screen.queryAllByText('Jordan P.').length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Pain score 8 reported after sparring round/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Pain report/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Near miss/).length).toBeGreaterThan(0);
    // An athlete the roster read could not name is shown by id, not dropped.
    expect(screen.queryByText('Athlete ID ath_unknown')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: 'Acknowledge' })).toHaveLength(2);
  });

  test('acknowledge posts the escalation id and shows the state the server returned', async () => {
    const posted: Array<{ action?: string; escalation_id?: string }> = [];
    await renderWorkspace({
      athletesList: rosterWithNames,
      escalationsGet: () => jsonResponse({ ok: true, escalations: [escalation()] }),
      escalationsPost: (body) => {
        posted.push(body);
        return jsonResponse({ ok: true, escalation: escalation({ status: 'acknowledged' }) });
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    });

    expect(posted).toEqual([{ action: 'acknowledge', escalation_id: 'esc_1' }]);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(screen.queryByText(/Closing it out is an admin decision/)).not.toBeNull();
  });

  test('a double-click sends exactly one acknowledge request', async () => {
    let release: (() => void) | undefined;
    const posted: unknown[] = [];
    await renderWorkspace({
      athletesList: rosterWithNames,
      escalationsGet: () => jsonResponse({ ok: true, escalations: [escalation()] }),
      escalationsPost: (body) => {
        posted.push(body);
        return new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse({ ok: true, escalation: escalation({ status: 'acknowledged' }) }));
        });
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    fireEvent.click(screen.getByRole('button', { name: /Acknowledg/ }));
    expect(posted).toHaveLength(1);

    await act(async () => {
      release?.();
    });
    expect(screen.queryByText(/Closing it out is an admin decision/)).not.toBeNull();
  });

  test('the server\'s refusal is surfaced, and the row stays open rather than pretending', async () => {
    await renderWorkspace({
      athletesList: rosterWithNames,
      escalationsGet: () => jsonResponse({ ok: true, escalations: [escalation()] }),
      escalationsPost: () => jsonResponse({ error: 'Missing escalation record' }, { ok: false, status: 400 }),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    });

    expect(screen.queryByText('Missing escalation record')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeNull();
  });

  test('a failed read never renders as "no escalations"', async () => {
    await renderWorkspace({
      escalationsGet: () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
    });

    expect(screen.queryByText(/Escalations may exist that are not shown here/)).not.toBeNull();
    expect(screen.queryByText(/No open escalations for your athletes/)).toBeNull();
  });

  test('a healthy empty inbox says an escalation would appear here', async () => {
    await renderWorkspace({});

    expect(screen.queryByText(/No open escalations for your athletes/)).not.toBeNull();
    expect(screen.queryByText(/Escalations may exist that are not shown here/)).toBeNull();
  });
});

// The read-back: what has already been said about a session, shown before the
// coach writes more. POST /api/pilot/coach-reviews keeps every review (a new
// review_id is minted per submit), so the only duplicate protection a coach
// has is seeing the existing reviews first.
describe('coach review read-back', () => {
  function review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      review_id: 'rev_1',
      session_id: 'session_1',
      coach_id: 'acct_coach_1',
      decision: 'approved',
      notes: 'Clean angles all night.',
      approved_flag: true,
      created_at: '2026-08-13T22:30:00.000Z',
      updated_at: '2026-08-13T22:30:00.000Z',
      ...overrides,
    };
  }

  const oneAthlete = () =>
    jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'Jordan P.' }] });

  async function pickSession(sessionId: string): Promise<void> {
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Session'), { target: { value: sessionId } });
    });
  }

  test('selecting a session shows its existing reviews, attributed honestly', async () => {
    const fetchMock = await renderWorkspace({
      athletesList: oneAthlete,
      sessionsList: () => jsonResponse({ items: [sessionRow('session_1')] }),
      coachReviewsList: () =>
        jsonResponse({
          items: [
            review(),
            review({ review_id: 'rev_2', coach_id: 'acct_coach_2', decision: 'hold', notes: '' }),
          ],
        }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');
    await pickSession('session_1');

    const listCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/pilot/coach-reviews/list'));
    expect(listCalls).toHaveLength(1);
    expect(String(listCalls[0][0])).toContain('session_id=session_1');

    expect(screen.queryByText('Reviews already on this session')).not.toBeNull();
    expect(screen.queryByText(/your review/)).not.toBeNull();
    expect(screen.queryByText('Clean angles all night.')).not.toBeNull();
    // The other coach's review is attributed to another coach, not to this one.
    expect(screen.queryByText(/another coach \(acct_coach_2\)/)).not.toBeNull();
  });

  test('a session with no reviews says so, without the failure warning', async () => {
    await renderWorkspace({
      athletesList: oneAthlete,
      sessionsList: () => jsonResponse({ items: [sessionRow('session_1')] }),
      coachReviewsList: () => jsonResponse({ items: [] }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');
    await pickSession('session_1');

    expect(screen.queryByText('No reviews on this session yet.')).not.toBeNull();
    expect(screen.queryByText(/Reviews may exist on this session/)).toBeNull();
  });

  test('a failed review read admits it rather than claiming the session is unreviewed', async () => {
    await renderWorkspace({
      athletesList: oneAthlete,
      sessionsList: () => jsonResponse({ items: [sessionRow('session_1')] }),
      coachReviewsList: () => jsonResponse({ error: 'Internal error' }, { ok: false, status: 500 }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');
    await pickSession('session_1');

    expect(screen.queryByText(/Reviews may exist on this session that are not shown/)).not.toBeNull();
    expect(screen.queryByText('No reviews on this session yet.')).toBeNull();
  });

  test('a persisted review appears in the panel from the server\'s own read, not from local echo', async () => {
    let listCalls = 0;
    const fetchMock = await renderWorkspace({
      athletesList: oneAthlete,
      sessionsList: () => jsonResponse({ items: [sessionRow('session_1')] }),
      coachReviewsList: () => {
        listCalls += 1;
        // Empty before the submit; the server's stored row after it.
        return listCalls === 1
          ? jsonResponse({ items: [] })
          : jsonResponse({ items: [review({ notes: 'Stored by the server.' })] });
      },
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');
    await pickSession('session_1');
    expect(screen.queryByText('No reviews on this session yet.')).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save Coach Review/i }));
    });

    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/pilot/coach-reviews/list')),
    ).toHaveLength(2);
    expect(screen.queryByText('Stored by the server.')).not.toBeNull();
  });

  test('switching athletes clears the panel -- one session\'s reviews never sit under another athlete', async () => {
    await renderWorkspace({
      athletesList: () =>
        jsonResponse({
          items: [
            { athlete_id: 'ath_1', full_name: 'Jordan P.' },
            { athlete_id: 'ath_2', full_name: 'Sam R.' },
          ],
        }),
      sessionsList: () => jsonResponse({ items: [sessionRow('session_1')] }),
      coachReviewsList: () => jsonResponse({ items: [review()] }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');
    await pickSession('session_1');
    expect(screen.queryByText('Reviews already on this session')).not.toBeNull();

    await pickReviewAthlete('ath_2');

    expect(screen.queryByText('Reviews already on this session')).toBeNull();
    expect(screen.queryByText('Clean angles all night.')).toBeNull();
  });
});

// The session picker replaced a free-text Session ID input: a coach selects a
// real, server-listed session instead of transcribing an opaque id. The
// athlete list is the roster the coach already reads (which, by design, names
// the whole gym), and GET /api/pilot/sessions/list stays the sole authority
// on whether this coach may see this athlete's sessions -- its refusal is
// shown, never smoothed into an empty list.
describe('coach review session picker', () => {
  const twoAthletes = () =>
    jsonResponse({
      items: [
        { athlete_id: 'ath_1', full_name: 'Jordan P.' },
        { athlete_id: 'ath_2', full_name: 'Sam R.' },
      ],
    });

  test('selecting an athlete lists exactly the sessions the server returned, labelled from real fields', async () => {
    const fetchMock = await renderWorkspace({
      athletesList: twoAthletes,
      sessionsList: () =>
        jsonResponse({
          items: [
            sessionRow('session_a', { date: '2026-08-10', rpe: 6, completed_flag: true, created_at: '2026-08-10T18:00:00.000Z' }),
            sessionRow('session_b', { date: '2026-08-12', rpe: 4, completed_flag: false, created_at: '2026-08-12T18:00:00.000Z' }),
          ],
        }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');

    const listCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/pilot/sessions/list'));
    expect(listCalls).toHaveLength(1);
    expect(String(listCalls[0][0])).toContain('athlete_id=ath_1');

    const options = Array.from(
      (screen.getByLabelText('Session') as HTMLSelectElement).options,
    ).map((option) => ({ value: option.value, label: option.textContent }));
    // Newest first (created_at), one option per returned row plus the empty
    // prompt -- nothing invented, nothing dropped.
    expect(options).toEqual([
      { value: '', label: 'Select a session' },
      { value: 'session_b', label: '2026-08-12 - open - RPE 4' },
      { value: 'session_a', label: '2026-08-10 - completed - RPE 6' },
    ]);
  });

  test('a valid selection submits that real session id on the unchanged contract', async () => {
    const fetchMock = await renderWorkspace({
      athletesList: twoAthletes,
      sessionsList: () => jsonResponse({ items: [sessionRow('session_a'), sessionRow('session_b')] }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');
    fireEvent.change(screen.getByLabelText('Session'), { target: { value: 'session_b' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save Coach Review/i }));
    });

    const reviewCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/api/pilot/coach-reviews') && !String(call[0]).includes('/list'));
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(String(reviewCall?.[1]?.body)) as Record<string, unknown>;
    expect(body.session_id).toBe('session_b');
    expect(body.coach_id).toBe('acct_coach_1');
    expect(body.decision).toBe('approved');
  });

  test('no selection blocks submission -- no request leaves with a blank session id', async () => {
    const fetchMock = await renderWorkspace({
      athletesList: twoAthletes,
      sessionsList: () => jsonResponse({ items: [sessionRow('session_a')] }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save Coach Review/i }));
    });

    expect(screen.queryByText('Select a session to review.')).not.toBeNull();
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/pilot/coach-reviews')),
    ).toHaveLength(0);
  });

  test('the server\'s refusal for an athlete outside this coach\'s scope is shown verbatim, not as an empty list', async () => {
    await renderWorkspace({
      athletesList: twoAthletes,
      sessionsList: () =>
        jsonResponse({ error: 'Forbidden: coach not assigned to athlete' }, { ok: false, status: 403 }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_2');

    expect(screen.queryByText(/Forbidden: coach not assigned to athlete/)).not.toBeNull();
    expect(screen.queryByText(/Sessions may exist that are not listed here/)).not.toBeNull();
    // The refusal must not be dressed as "this athlete has no sessions".
    expect(screen.queryByText(/No sessions are recorded for this athlete yet/)).toBeNull();
    expect(screen.queryByLabelText('Session')).toBeNull();
  });

  test('a failed session read is distinct from an empty one', async () => {
    await renderWorkspace({
      athletesList: twoAthletes,
      sessionsList: () => jsonResponse({ error: 'Internal error' }, { ok: false, status: 500 }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');

    expect(screen.queryByText(/Sessions may exist that are not listed here/)).not.toBeNull();
    expect(screen.queryByText(/No sessions are recorded for this athlete yet/)).toBeNull();
  });

  test('an athlete with no sessions says so, without the failure warning', async () => {
    await renderWorkspace({
      athletesList: twoAthletes,
      sessionsList: () => jsonResponse({ items: [] }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');

    expect(screen.queryByText(/No sessions are recorded for this athlete yet/)).not.toBeNull();
    expect(screen.queryByText(/Sessions may exist that are not listed here/)).toBeNull();
    expect(screen.queryByLabelText('Session')).toBeNull();
  });

  test('rows without a usable session_id or date are dropped, never rendered as blank options', async () => {
    await renderWorkspace({
      athletesList: twoAthletes,
      sessionsList: () =>
        jsonResponse({
          items: [
            sessionRow('session_ok'),
            sessionRow('', {}),
            { ...sessionRow('session_no_date'), date: null },
            'not-an-object',
          ],
        }),
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');

    const options = Array.from((screen.getByLabelText('Session') as HTMLSelectElement).options);
    expect(options.map((option) => option.value)).toEqual(['', 'session_ok']);
  });

  test('switching athletes clears the selection and a late response for the old athlete never renders under the new one', async () => {
    let releaseFirst: (() => void) | undefined;
    await renderWorkspace({
      athletesList: twoAthletes,
      sessionsList: (athleteId) => {
        if (athleteId === 'ath_1') {
          return new Promise<Response>((resolve) => {
            releaseFirst = () => resolve(jsonResponse({ items: [sessionRow('session_of_ath_1')] }));
          });
        }
        return jsonResponse({ items: [sessionRow('session_of_ath_2', { athlete_id: 'ath_2' })] });
      },
    });

    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');
    // ath_1's read is still in flight; the coach moves on to ath_2.
    await pickReviewAthlete('ath_2');
    fireEvent.change(screen.getByLabelText('Session'), { target: { value: 'session_of_ath_2' } });

    // The slow response for ath_1 lands now -- it must be discarded.
    await act(async () => {
      releaseFirst?.();
    });

    const options = Array.from((screen.getByLabelText('Session') as HTMLSelectElement).options);
    expect(options.map((option) => option.value)).toEqual(['', 'session_of_ath_2']);
    expect((screen.getByLabelText('Session') as HTMLSelectElement).value).toBe('session_of_ath_2');
  });

  test('a failed roster read says the roster is unavailable, not that there are no athletes', async () => {
    await renderWorkspace({
      athletesList: () => jsonResponse({ error: 'Internal error' }, { ok: false, status: 500 }),
    });

    openTab('Athlete Reviews');

    await waitFor(() => expect(screen.queryByText(/The athlete roster could not be loaded/)).not.toBeNull());
    expect(screen.queryByText(/No athletes are on the roster yet/)).toBeNull();
  });
});

// The Tasks tab's own copy tells a coach to "use the SHADOW tab to act on
// review-queue items" -- these prove that action actually exists and works.
// /api/pilot/intake/review-action already authorizes 'coach' for
// approve/reject server-side; before this, nothing in the coach-facing UI
// ever called it, so the promise in the Tasks tab's copy was false.
describe('the SHADOW tab lets a coach act on review-queue items, as the Tasks tab promises', () => {
  function queueItem(overrides: Record<string, unknown> = {}) {
    return {
      intake_case_id: 'case_1',
      status: 'pending_review',
      summary: 'New athlete intake: Jordan T.',
      document_count: 2,
      updated_at: '2026-08-01T00:00:00.000Z',
      ...overrides,
    };
  }

  function reviewActionCalls(fetchMock: jest.Mock): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((call) => String(call[0]).includes('/api/pilot/intake/review-action'))
      .map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>);
  }

  test('a pending_review item shows working Approve/Reject buttons', async () => {
    const fetchMock = await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: [queueItem()] }),
    });
    openTab('SHADOW Intel');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(reviewActionCalls(fetchMock)).toEqual([
      { intake_case_id: 'case_1', action: 'approve' },
    ]));
    await waitFor(() => expect(screen.queryByText('Status: approved')).not.toBeNull());
  });

  test('an already-decided item shows no action buttons', async () => {
    await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: [queueItem({ status: 'approved' })] }),
    });
    openTab('SHADOW Intel');

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  test('a rejection outside the coach\'s assigned athletes surfaces the server\'s refusal, not a silent no-op', async () => {
    const fetchMock = await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: [queueItem()] }),
      intakeReviewAction: async () => jsonResponse({ error: 'Forbidden: coach not assigned to athlete' }, { ok: false, status: 403 }),
    });
    openTab('SHADOW Intel');

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(screen.queryByText(/Forbidden: coach not assigned to athlete/i)).not.toBeNull());
    // The item's own local status must not be optimistically flipped on a
    // refused request -- it is still exactly what the server last said.
    expect(screen.queryByText('Status: pending_review')).not.toBeNull();
    expect(reviewActionCalls(fetchMock)).toHaveLength(1);
  });

  test('a double-click sends exactly one review-action request', async () => {
    let releaseAction: (() => void) | undefined;
    const fetchMock = await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: [queueItem()] }),
      intakeReviewAction: (body) =>
        new Promise<Response>((resolve) => {
          releaseAction = () => resolve(jsonResponse({ ok: true, intake_case_id: body.intake_case_id, status: 'approved' }));
        }),
    });
    openTab('SHADOW Intel');

    const approveButton = screen.getByRole('button', { name: 'Approve' });
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);

    expect(reviewActionCalls(fetchMock)).toHaveLength(1);

    await act(async () => {
      releaseAction?.();
    });
    await waitFor(() => expect(screen.queryByText('Status: approved')).not.toBeNull());
    expect(reviewActionCalls(fetchMock)).toHaveLength(1);
  });
});

// Authored notices and motivational copy are data, so the workspace has to ask
// for its own surface and has to survive the answer -- including no answer at
// all.
describe('the review queue admits what it is not showing', () => {
  function queueItem(id: string, overrides: Record<string, unknown> = {}) {
    return {
      intake_case_id: id,
      status: 'pending_review',
      summary: `New athlete intake ${id}`,
      document_count: 1,
      updated_at: '2026-08-01T00:00:00.000Z',
      ...overrides,
    };
  }

  // The panel rendered slice(0, 6) against a request for 20, so fourteen
  // pending cases could sit behind the last card with nothing on screen
  // suggesting they existed. On a queue of decisions waiting on a person, an
  // undisclosed cap means the work silently disappears.
  test('renders every case it fetched, not the first six', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => queueItem(`case_${i}`));
    await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: ten, total: 10 }),
    });
    openTab('SHADOW Intel');

    await waitFor(() => {
      expect(screen.getByText('New athlete intake case_9')).toBeTruthy();
    });
    expect(screen.getByText('New athlete intake case_6')).toBeTruthy();
  });

  test('states how many cases exist beyond the ones listed', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => queueItem(`case_${i}`));
    await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: twenty, total: 34 }),
    });
    openTab('SHADOW Intel');

    await waitFor(() => {
      expect(screen.getByText(/Showing 20 of 34/)).toBeTruthy();
    });
    expect(screen.getByText(/14 more cases are in the queue/)).toBeTruthy();
  });

  test('says nothing when it is showing the whole queue', async () => {
    await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: [queueItem('case_1')], total: 1 }),
    });
    openTab('SHADOW Intel');

    await waitFor(() => {
      expect(screen.getByText('New athlete intake case_1')).toBeTruthy();
    });
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  // A projection that omits `total` must not produce "Showing 3 of undefined".
  test('stays quiet rather than guessing when the projection reports no total', async () => {
    const three = Array.from({ length: 3 }, (_, i) => queueItem(`case_${i}`));
    await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: three }),
    });
    openTab('SHADOW Intel');

    await waitFor(() => {
      expect(screen.getByText('New athlete intake case_0')).toBeTruthy();
    });
    expect(screen.queryByText(/Showing/)).toBeNull();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  test('uses the singular for a single withheld case', async () => {
    const two = Array.from({ length: 2 }, (_, i) => queueItem(`case_${i}`));
    await renderWorkspace({
      reviewProjection: async () => jsonResponse({ queue: two, total: 3 }),
    });
    openTab('SHADOW Intel');

    await waitFor(() => {
      expect(screen.getByText(/1 more case is in the queue/)).toBeTruthy();
    });
  });
});

describe('authored announcements on the coach workspace', () => {
  function announcementRequests(fetchMock: jest.Mock): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((call) => String(call[0]).includes('/api/pilot/announcements/get'))
      .map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>);
  }

  test('the workspace asks for its own placement, for both kinds', async () => {
    const fetchMock = await renderWorkspace();

    expect(announcementRequests(fetchMock)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ placement: 'coach_workspace', kind: 'notice' }),
        expect.objectContaining({ placement: 'coach_workspace', kind: 'motivation' }),
      ]),
    );
  });

  test('live motivational copy is drawn where the coach will see it', async () => {
    await renderWorkspace({
      announcements: async () => jsonResponse({ ok: true, announcements: [announcement()] }),
    });

    expect(screen.queryByText('Lock the room in before the first bell.')).not.toBeNull();
    expect(screen.queryByText('From the Gym')).not.toBeNull();
  });

  test('nothing live leaves no heading and no empty box behind', async () => {
    await renderWorkspace();

    expect(screen.queryByText('From the Gym')).toBeNull();
    expect(screen.queryByText('Gym Notices')).toBeNull();
  });

  test('a failed announcements read leaves the rest of the workspace working', async () => {
    await renderWorkspace({
      announcements: async () => {
        throw new Error('announcements offline');
      },
    });

    expect(screen.queryByText('From the Gym')).toBeNull();
    expect(screen.queryByText('Live Session Management')).not.toBeNull();

    openTab('Floor');
    expect(screen.queryByText(/Session Workout Plan/i)).not.toBeNull();
  });
});

// The readiness feed (register module 169): real statuses from fresh
// check-ins color the roster; everyone else stays UNKNOWN, and unknown is
// never presented as clear. A failed feed must look like "no signal", never
// like "zero flags".
describe('roster readiness comes from the board feed, honestly', () => {
  const threeAthletes = () =>
    jsonResponse({
      items: [
        { athlete_id: 'ath_1', full_name: 'Jordan P.' },
        { athlete_id: 'ath_2', full_name: 'Sam R.' },
        { athlete_id: 'ath_3', full_name: 'Rosa D.' },
      ],
    });

  test('fresh statuses color the tile and the absent athlete stays unknown, said out loud', async () => {
    await renderWorkspace({
      athletesList: threeAthletes,
      readinessBoard: () => jsonResponse({
        items: [
          { athlete_id: 'ath_1', status: 'GREEN', score: 8, measured_at: '2026-08-15T12:00:00.000Z' },
          { athlete_id: 'ath_2', status: 'RED', score: 2, measured_at: '2026-08-15T12:00:00.000Z' },
        ],
      }),
    });

    // One RED, zero YELLOW; ath_3 has no fresh check-in and is counted as
    // unknown rather than silently folded into "no alerts".
    expect(screen.getByText(/1 RED, 0 YELLOW, 1 unknown — unknown is not clear/)).toBeTruthy();
    expect(screen.queryByText(/No fresh readiness check-ins/)).toBeNull();
  });

  // The scores driving these colours are typed by staff during intake review;
  // no validated formula produces them (see
  // docs/capabilities/READINESS_PROVENANCE_FACTS.md). The rule that already
  // governs assessment results -- a value is never read without its
  // measurement properties -- applies here too.
  test('an unvalidated readiness method is caveated beside the count, not hidden in a help panel', async () => {
    await renderWorkspace({
      athletesList: threeAthletes,
      readinessBoard: () => jsonResponse({
        items: [
          {
            athlete_id: 'ath_1',
            status: 'GREEN',
            score: 8,
            measured_at: '2026-08-15T12:00:00.000Z',
            method: 'staff_entered_intake',
            reliability_status: 'UNVALIDATED - PPBF MUST ESTABLISH',
            validity_status: 'UNKNOWN',
            evidence_class: 'INSUFFICIENT EVIDENCE',
          },
        ],
      }),
    });

    expect(screen.getByText(/entered by staff during intake review/i)).toBeTruthy();
    expect(screen.getByText(/not as a measurement/i)).toBeTruthy();
  });

  // Fail-closed: a feed that omits provenance entirely (an older server, or a
  // shape change) must be treated as unvalidated, never as validated-by-absence.
  test('a feed carrying no provenance at all is still caveated', async () => {
    await renderWorkspace({
      athletesList: threeAthletes,
      readinessBoard: () => jsonResponse({
        items: [
          { athlete_id: 'ath_1', status: 'GREEN', score: 8, measured_at: '2026-08-15T12:00:00.000Z' },
        ],
      }),
    });

    expect(screen.getByText(/entered by staff during intake review/i)).toBeTruthy();
  });

  // The caveat must not become a permanent fixture nobody can remove: it is
  // computed from the feed, so an established method retires it automatically.
  test('a validated method retires the caveat without a code change', async () => {
    await renderWorkspace({
      athletesList: threeAthletes,
      readinessBoard: () => jsonResponse({
        items: [
          {
            athlete_id: 'ath_1',
            status: 'GREEN',
            score: 8,
            measured_at: '2026-08-15T12:00:00.000Z',
            method: 'some_future_validated_method',
            reliability_status: 'ESTABLISHED',
            validity_status: 'ESTABLISHED',
            evidence_class: 'ESTABLISHED',
          },
        ],
      }),
    });

    // The tile is live (one GREEN reading, two athletes without one), so the
    // caveat's absence is a real decision rather than the tile being empty.
    expect(screen.getByText(/0 RED, 0 YELLOW, 2 unknown/)).toBeTruthy();
    expect(screen.queryByText(/entered by staff during intake review/i)).toBeNull();
  });

  test('a failed feed reads as no signal, never as zero flags', async () => {
    await renderWorkspace({
      athletesList: threeAthletes,
      readinessBoard: () => jsonResponse({}, { ok: false, status: 500 }),
    });

    expect(screen.getByText('No signal')).toBeTruthy();
    expect(screen.getByText(/do not read this as .zero flags./)).toBeTruthy();
  });

  test('a healthy feed with no fresh check-ins reads the same as no signal', async () => {
    await renderWorkspace({ athletesList: threeAthletes });

    expect(screen.getByText('No signal')).toBeTruthy();
  });
});

// The read side of ParentHub's "Sent to your child's coach": the barrier
// panel is where that promise is kept, so its two hazards are pinned -- a
// report rendering as a coach's note, and a failed read rendering as an
// empty inbox.
describe('family barrier reports', () => {
  test('a report is attributed to a guardian, named for the child, and shown in full', async () => {
    await renderWorkspace({
      barrierReports: async () => jsonResponse({
        ok: true,
        truncated: false,
        barrierReports: [{
          note_id: 'note-1',
          athlete_id: 'ath-1',
          athlete_name: 'Rosa Delgado',
          reporter_role: 'parent',
          note_type: 'transportation_barrier',
          note_text: 'We lost our ride on Tuesdays.',
          created_at: '2026-08-10T10:00:00.000Z',
        }],
      }),
    });

    expect(screen.getByText('Rosa Delgado')).not.toBeNull();
    expect(screen.getByText(/Getting to the gym/)).not.toBeNull();
    expect(screen.getByText(/reported by a guardian/)).not.toBeNull();
    expect(screen.getByText('We lost our ride on Tuesdays.')).not.toBeNull();
  });

  test('a failed read never renders as "no family asked for help"', async () => {
    await renderWorkspace({
      barrierReports: async () => jsonResponse({ error: 'offline' }, { ok: false, status: 500 }),
    });

    expect(screen.getByText(/Do not read this as .no family asked for/)).not.toBeNull();
    expect(screen.queryByText(/No guardian on your roster has reported a barrier/)).toBeNull();
  });

  test('an empty inbox says a report would appear here, not that none was ever sent', async () => {
    await renderWorkspace();

    expect(screen.getByText(/No guardian on your roster has reported a barrier/)).not.toBeNull();
  });
});

describe('the hub links to the session-delivery surfaces', () => {
  // The delivery loop worked end to end while nothing linked to it: the
  // scripts page, floor groups, the drill library, the cue library and the
  // template catalog were all reachable only by typing the URL. These pin
  // the Quick Actions links that make that loop part of the coach's day.
  test.each([
    ["Session Scripts: Run Tonight's Plan", '/coach/session-scripts'],
    ["Today's Floor Groups", '/coach/floor-groups'],
    ['Open Drill Library', '/coach/drills'],
    ['Open Cue Library', '/coach/cue-library'],
    ['Browse Workout Templates', '/coach/workout-templates'],
  ])('the dashboard links "%s" to %s', async (label, href) => {
    await renderWorkspace();

    const link = screen.getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe(href);
  });

  test('the existing quick actions were not displaced by the new links', async () => {
    await renderWorkspace();

    expect(screen.getByRole('link', { name: 'Open Scheduler' }).getAttribute('href')).toBe('/schedule');
    expect(screen.getByRole('link', { name: 'Write a Rabbit Hole' }).getAttribute('href')).toBe('/rabbit-holes');
  });
});
