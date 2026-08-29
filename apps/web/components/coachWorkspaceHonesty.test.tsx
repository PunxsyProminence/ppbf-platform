/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { AnnouncementItem } from './AnnouncementBanner';
import CoachWorkspace from './CoachWorkspace';
// The same date formatter CoachWorkspace filters "today's classes" with, so
// the fixture below cannot drift out of agreement with the code under test.
import { formatGymDateNumeric } from '../src/lib/gymTime';

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
  liveRun?: () => Promise<Response> | Response;
  scheduler?: () => Promise<Response> | Response;
  credentials?: () => Promise<Response> | Response;
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
    // { run: null } is the route's own success shape for "you have nothing
    // running" -- not a 404 -- so the default here is a HEALTHY read of an
    // idle coach, which is what makes an 'unavailable' rendering in these
    // tests a real signal rather than a mock artefact.
    if (url.includes('/api/pilot/session-scripts/runs')) {
      return routes.liveRun ? routes.liveRun() : jsonResponse({ run: null });
    }
    if (url.includes('/api/pilot/scheduler')) {
      return routes.scheduler ? routes.scheduler() : jsonResponse({ ok: true, classes: [] });
    }
    if (url.includes('/api/pilot/coach/credentials')) {
      return routes.credentials ? routes.credentials() : jsonResponse({ ok: true, items: [] });
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

/**
 * A staff credential row as GET /api/pilot/coach/credentials returns it.
 * `band` is the SERVER's derivation (deriveCredentialBand), which is why these
 * fixtures set it explicitly rather than letting the component infer one --
 * a second derivation on the client is the thing these tests exist to keep out.
 */
function credentialRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clearance_type_id: 'clr_safesport',
    name: 'SafeSport Training',
    issuing_authority: 'U.S. Center for SafeSport',
    validity_months: 12,
    status: 'current',
    band: 'current',
    issued_on: '2026-02-01',
    expires_on: '2027-02-01',
    verification_note: null,
    has_document: true,
    ...overrides,
  };
}

/** A live run as GET /api/pilot/session-scripts/runs returns it in `run`. */
function liveRunRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'run_1',
    script_id: 'scr_1',
    script_version: 3,
    activity_id: null,
    delivered_by_account_id: 'acct_coach_1',
    delivered_on: '2026-08-28',
    athletes_present: 11,
    run_state: 'in_progress',
    started_at: '2026-08-28T22:00:00.000Z',
    ended_at: null,
    current_block_id: 'blk_2',
    paused_at: null,
    paused_seconds: 0,
    elapsed_seconds: 1530,
    is_paused: false,
    ...overrides,
  };
}

/**
 * A scheduled class starting `hour`:00 on TODAY at the gym, as
 * GET /api/pilot/scheduler returns it in `classes`.
 *
 * Built from the current instant rather than a frozen literal because the
 * dashboard filters to the gym's own calendar day; a fixed date would make
 * this suite pass on one day and fail on the next.
 *
 * AND THE OFFSET STEPS BACKWARDS NEAR MIDNIGHT, which the comment above used
 * to miss. A flat `now + 1h` is not "today" for the last hour of the gym's
 * day: CoachWorkspace keeps a class only when
 * formatGymDateNumeric(start_at) === formatGymDateNumeric(new Date()), so
 * between 23:00 and midnight at the gym the fixture built a class dated
 * TOMORROW, the dashboard correctly dropped it, and both assertions here
 * failed. Nothing was wrong with the component or with this suite's subject
 * -- main simply went red for one hour every night and healed itself, which
 * is the worst shape a failure can have, because the window closes before
 * anyone finishes reading it. Observed on 2026-08-29 at 23:09 America/New_York,
 * on commits whose CI had passed hours earlier.
 *
 * The offset now asks the SAME function the component asks, so the fixture
 * and the filter cannot disagree. If +1h would land on the next gym day, step
 * back an hour instead: `now` is then in the day's final hour, so -1h is
 * comfortably inside it, and the two cases cannot both apply.
 */
function classToday(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  const ahead = new Date(now.getTime() + 60 * 60 * 1000);
  const start = formatGymDateNumeric(ahead) === formatGymDateNumeric(now)
    ? ahead
    : new Date(now.getTime() - 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    class_id: 'cls_1',
    title: 'Foundations Boxing',
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    location: 'Main Floor',
    capacity: 20,
    scheduled_by_account_id: 'acct_coach_1',
    coach_account_id: 'acct_coach_1',
    status: 'open',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    registered_count: 4,
    ...overrides,
  };
}

/*
 * THE HUB USED TO DENY CAPABILITIES THIS PLATFORM ALREADY HAS.
 *
 * Three claims sat on the Coach Workspace against three shipped backends:
 *
 *   "Live session tracking is not built yet."   pilot.session_script_runs +
 *                                               /api/pilot/session-scripts/runs
 *   "There is no backend feed for coach         pilot.person_clearances +
 *    certifications yet"                        /api/pilot/coach/credentials
 *   "Video Upload: FRONT-END PLACEHOLDER"       /api/pilot/video/* +
 *                                               /coach/video-analysis
 *
 * A denial is the same defect as a fabrication, pointed the other way. The
 * coach acts on the sentence either way: told the platform cannot hold a
 * SafeSport certificate, they do not upload one -- on a safeguarding record
 * about work with minors. These tests pin the direction the copy may not drift
 * back in, by naming the exact words that were on the screen.
 */
describe('the hub does not deny a capability the platform has', () => {
  test('the dashboard does not say live session tracking is unbuilt, while the run route answers', async () => {
    await renderWorkspace();

    expect(screen.queryByText(/Live session tracking is not built/i)).toBeNull();
    expect(screen.queryByText(/There is no scheduling backend feed/i)).toBeNull();
    expect(screen.queryByText(/not yet tracked/i)).toBeNull();
  });

  test('the dashboard actually reads the live-run route rather than assuming an answer', async () => {
    const fetchMock = await renderWorkspace();

    const runCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/pilot/session-scripts/runs'),
    );
    expect(runCalls.length).toBeGreaterThan(0);
  });

  test('a session in progress is shown with the server\'s own clock, not a local count', async () => {
    await renderWorkspace({ liveRun: () => jsonResponse({ run: liveRunRow() }) });

    // 1530s from the server -> 25m 30s. The component must never derive this
    // from started_at and the browser's clock: that is the reading a phone
    // that slept through half the class would get wrong.
    expect(screen.queryByText('25m 30s')).not.toBeNull();
    // The head count the coach entered when they started this delivery --
    // shown as the number, never as the roster-derived guess the old panel used.
    expect(screen.queryByText('11')).not.toBeNull();
    expect(screen.queryByText('Not recorded for this run')).toBeNull();
    expect(screen.getByRole('link', { name: 'Return to live delivery' }).getAttribute('href'))
      .toBe('/coach/session-scripts');
  });

  test('a paused run says paused rather than showing a clock that looks like it is running', async () => {
    await renderWorkspace({
      liveRun: () => jsonResponse({ run: liveRunRow({ is_paused: true, paused_at: '2026-08-28T22:20:00.000Z' }) }),
    });

    expect(screen.queryByText('Paused')).not.toBeNull();
  });

  test('a failed live-run read is UNKNOWN, never "no session in progress"', async () => {
    // The distinction is operational, not cosmetic: /coach/session-scripts
    // disables its start button while this check is failing, precisely so a
    // coach cannot open a second delivery over a live one. A hub that answered
    // "nothing is running" here would undo that.
    await renderWorkspace({ liveRun: () => jsonResponse({}, { ok: false, status: 503 }) });

    // Twice on purpose: the KPI summary line and the Today's Session panel
    // both say it, and a coach who reads either one must not be told the
    // opposite by the other.
    expect(screen.queryAllByText(/could not be checked/i).length).toBe(2);
    expect(screen.queryByText('No session in progress.')).toBeNull();
  });

  test('a healthy read with nothing running says so plainly', async () => {
    await renderWorkspace();

    expect(screen.queryByText('No session in progress.')).not.toBeNull();
    expect(screen.queryAllByText(/could not be checked/i)).toHaveLength(0);
  });
});

describe("today's schedule comes from the scheduler, and a failed read is not an empty evening", () => {
  test("a class scheduled today is named with its real title and time", async () => {
    await renderWorkspace({ scheduler: () => jsonResponse({ ok: true, classes: [classToday()] }) });

    expect(screen.queryByText('Foundations Boxing')).not.toBeNull();
    expect(screen.queryByText(/No class is scheduled for you today/i)).toBeNull();
  });

  test('a cancelled class stays listed and is marked cancelled', async () => {
    // Dropping it would leave a coach who remembers it on the calendar unable
    // to tell a cancellation from a class the read never returned.
    await renderWorkspace({
      scheduler: () => jsonResponse({ ok: true, classes: [classToday({ status: 'cancelled' })] }),
    });

    expect(screen.queryByText('Foundations Boxing')).not.toBeNull();
    expect(screen.queryByText('Cancelled')).not.toBeNull();
  });

  test("a class on another day is not drawn under today's heading", async () => {
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await renderWorkspace({
      scheduler: () => jsonResponse({
        ok: true,
        classes: [classToday({
          title: 'Thursday Sparring',
          start_at: start.toISOString(),
          end_at: new Date(start.getTime() + 3600000).toISOString(),
        })],
      }),
    });

    expect(screen.queryByText('Thursday Sparring')).toBeNull();
    expect(screen.queryByText(/No class is scheduled for you today/i)).not.toBeNull();
  });

  test('a failed schedule read never renders as "nothing is on tonight"', async () => {
    await renderWorkspace({ scheduler: () => jsonResponse({}, { ok: false, status: 500 }) });

    expect(screen.queryByText(/schedule could not be loaded/i)).not.toBeNull();
    expect(screen.queryByText(/No class is scheduled for you today/i)).toBeNull();
  });
});

describe("the Development tab shows the coach's real credential record", () => {
  test('the certification panel no longer denies that a credential backend exists', async () => {
    await renderWorkspace({ credentials: () => jsonResponse({ ok: true, items: [credentialRow()] }) });
    openTab('Development');

    expect(screen.queryByText(/no backend feed for coach certifications/i)).toBeNull();
    expect(screen.queryByText('SafeSport Training')).not.toBeNull();
    expect(screen.queryByText('Current')).not.toBeNull();
    expect(screen.queryByText(/Expires 2027-02-01/)).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Manage your credentials' }).getAttribute('href'))
      .toBe('/coach/credentials');
  });

  test("the server's band is displayed, not recomputed -- an expired row reads expired", async () => {
    await renderWorkspace({
      credentials: () => jsonResponse({
        ok: true,
        items: [credentialRow({ status: 'expired', band: 'expired', expires_on: '2025-01-01' })],
      }),
    });
    openTab('Development');

    expect(screen.queryByText('Expired')).not.toBeNull();
    expect(screen.queryByText(/Expired 2025-01-01/)).not.toBeNull();
  });

  test('a submitted credential is not dated, because nobody has confirmed the dates yet', async () => {
    await renderWorkspace({
      credentials: () => jsonResponse({
        ok: true,
        items: [credentialRow({ status: 'submitted', band: 'submitted', issued_on: null, expires_on: '2027-02-01' })],
      }),
    });
    openTab('Development');

    expect(screen.queryByText('Awaiting review')).not.toBeNull();
    expect(screen.queryByText(/Expires 2027-02-01/)).toBeNull();
  });

  test('an unrecognised band falls to "Not on file", never to "Current"', async () => {
    await renderWorkspace({
      credentials: () => jsonResponse({ ok: true, items: [credentialRow({ band: 'some_future_band' })] }),
    });
    openTab('Development');

    expect(screen.queryByText('Not on file')).not.toBeNull();
    expect(screen.queryByText('Current')).toBeNull();
  });

  test('a failed credential read is UNAVAILABLE, not "nothing on file"', async () => {
    await renderWorkspace({ credentials: () => jsonResponse({}, { ok: false, status: 503 }) });
    openTab('Development');

    expect(screen.queryByText(/could not be read/i)).not.toBeNull();
    expect(screen.queryByText(/no active clearance types/i)).toBeNull();
  });

  test('no document reference reaches this hub, even for the document\'s own owner', async () => {
    // The list response withholds document_ref on purpose;
    // /api/pilot/credentials/document is the single path to the bytes. If this
    // panel ever starts rendering a link to a file, that decision gets made
    // deliberately rather than by a spread of the row.
    await renderWorkspace({ credentials: () => jsonResponse({ ok: true, items: [credentialRow()] }) });
    openTab('Development');

    const documentLinks = screen.queryAllByRole('link').filter((node) =>
      (node.getAttribute('href') ?? '').includes('/credentials/document'),
    );
    expect(documentLinks).toHaveLength(0);
  });

  test('Development topics are a reference list, not controls that save nothing', async () => {
    await renderWorkspace();
    openTab('Development');

    expect(screen.queryByText('Injury Prevention Basics')).not.toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('Film Study names the human workflow that exists and the machine one that does not', () => {
  test('the tab no longer calls video upload a front-end placeholder', async () => {
    await renderWorkspace();
    openTab('Film Study');

    expect(screen.queryByText(/FRONT-END PLACEHOLDER/i)).toBeNull();
    expect(screen.queryByText(/Coming soon: Video upload/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Video Analysis Surface' }).getAttribute('href'))
      .toBe('/coach/video-analysis');
  });

  test('automatic technique scoring is still refused, and is not promised as coming soon', async () => {
    // BACKLOG-video-skill-scoring is parked by owner decision, not queued.
    // "Coming soon" would be a schedule nobody agreed to for machine
    // judgements about a child's athletic ability.
    await renderWorkspace();
    openTab('Film Study');

    expect(screen.queryByText(/parked, not scheduled/i)).not.toBeNull();
    expect(screen.queryByText(/Per-skill machine scoring/i)).not.toBeNull();
  });
});

describe('the Athlete Reviews tab does not call progression intelligence a placeholder', () => {
  test('the surface is described as real, and coach confirmation is still stated', async () => {
    await renderWorkspace();
    openTab('Athlete Reviews');

    expect(screen.queryByText(/PLACEHOLDER/)).toBeNull();
    expect(screen.queryByText(/Closed-Loop Progression Intelligence - Planned/i)).toBeNull();
    expect(screen.queryByText(/until a coach confirms or dismisses/i)).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Open Progression Intelligence Surface' }).getAttribute('href'))
      .toBe('/coach/progression-intelligence');
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

  test('the template says THIS panel tracks nothing, not that the platform tracks nothing', async () => {
    await renderWorkspace();
    openTab('Floor');

    expect(screen.queryByText(/completion and session progress are not tracked yet/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Session Scripts' }).getAttribute('href'))
      .toBe('/coach/session-scripts');
  });

  test('with a run live, the floor tab points back at it instead of offering a fresh start', async () => {
    await renderWorkspace({ liveRun: () => jsonResponse({ run: liveRunRow() }) });
    openTab('Floor');

    expect(screen.queryByRole('link', { name: 'Open Session Scripts' })).toBeNull();
    expect(screen.queryAllByRole('link', { name: 'Return to live delivery' }).length).toBeGreaterThan(0);
  });
});

/*
 * The "Athlete Floor Plans" tab is deliberately gone, and this pins the
 * removal. Every plan it listed was auto-generated at athlete check-in from
 * the unvalidated readiness slider and headed with a CLIENT-SUPPLIED
 * athleteName -- the literal 'Current Athlete' -- which the panel rendered as
 * if it were a real athlete's identity over individualized work. A test here
 * used to pin that panel's error handling; it went with the panel.
 */
describe('the auto-generated athlete floor-plan surface is gone', () => {
  test('no floor-plans tab, no floor-plans read, and no client-supplied name shown as identity', async () => {
    // The stub answers with exactly the payload the old panel displayed. If
    // anything in this workspace still fetched it, the name would be on the
    // screen and the call in the log.
    const fetchMock = await renderWorkspace({
      floorPlans: async () => jsonResponse({
        items: [{
          athleteName: 'Current Athlete',
          readiness: 'GREEN',
          generatedAt: '2026-08-20T17:00:00.000Z',
          tasks: [{ id: 'wf_1', title: 'Conditioning Finisher', category: 'Training', description: 'High-output intervals: 6 rounds x 90s on / 60s active recovery.', dueDate: '5:30 PM', priority: 'Normal' }],
        }],
      }),
    });

    expect(screen.queryByRole('button', { name: /^Athlete Floor Plans\b/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review Athlete Plans' })).toBeNull();
    expect(screen.queryByText('Current Athlete')).toBeNull();

    const floorPlanCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/pilot/floor-plans'),
    );
    expect(floorPlanCalls).toHaveLength(0);
  });
});

describe('read failures are never rendered as an empty queue', () => {
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
    // The masthead. It named the workspace on every tab until the approved
    // board (AF-09) put the open surface in the heading and the workspace's
    // name on the line under it -- this checks the line, which is the half
    // that does not move when the coach changes tabs.
    expect(screen.queryByText('Coach workspace · Live session management')).not.toBeNull();

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

  /** A board entry from a method somebody actually established. Nothing in
   *  production produces one today -- that is the point of the gate -- so the
   *  cases that need an authoritative band have to construct it. */
  const validatedEntry = (athleteId: string, status: string, score: number) => ({
    athlete_id: athleteId,
    status,
    score,
    measured_at: '2026-08-15T12:00:00.000Z',
    method: 'established_instrument',
    reliability_status: 'ESTABLISHED',
    validity_status: 'ESTABLISHED',
    evidence_class: 'ESTABLISHED',
  });

  test('validated statuses color the tile and the absent athlete stays unknown, said out loud', async () => {
    await renderWorkspace({
      athletesList: threeAthletes,
      readinessBoard: () => jsonResponse({
        items: [validatedEntry('ath_1', 'GREEN', 8), validatedEntry('ath_2', 'RED', 2)],
      }),
    });

    // One RED, zero YELLOW; ath_3 has no fresh reading and is counted as
    // unknown rather than silently folded into "no alerts".
    expect(screen.getByText(/1 RED, 0 YELLOW, 1 unknown — unknown is not clear/)).toBeTruthy();
    expect(screen.queryByText(/No fresh readiness check-ins/)).toBeNull();
  });

  /* THE GATE ITSELF. The same two entries, from the method every stored row
     actually has, must NOT become a band. GREEN/YELLOW/RED here is an
     authoritative reading a coach acts on; a staff judgement cannot carry it.
     The athletes fall back to unknown -- which this tile already refuses to
     read as "clear" -- and the judgements are still shown, as judgements. */
  test('an unvalidated reading is not promoted into a RED or YELLOW count', async () => {
    await renderWorkspace({
      athletesList: threeAthletes,
      readinessBoard: () => jsonResponse({
        items: [
          {
            athlete_id: 'ath_1', status: 'GREEN', score: 8,
            measured_at: '2026-08-15T12:00:00.000Z',
            method: 'staff_entered_intake',
            reliability_status: 'UNVALIDATED - PPBF MUST ESTABLISH',
            validity_status: 'UNKNOWN',
          },
          {
            athlete_id: 'ath_2', status: 'RED', score: 2,
            measured_at: '2026-08-15T12:00:00.000Z',
            method: 'staff_entered_intake',
            reliability_status: 'UNVALIDATED - PPBF MUST ESTABLISH',
            validity_status: 'UNKNOWN',
          },
        ],
      }),
    });

    expect(screen.getByText(/0 RED, 0 YELLOW, 3 unknown — unknown is not clear/)).toBeTruthy();
    // Not deleted, not hidden: still on screen, as something written down.
    expect(screen.getByText(/staff judgement\(s\) recorded but not counted above/i)).toBeTruthy();
    expect(screen.getByText(/written down, not measured/i)).toBeTruthy();
    // AND NOT "No signal". A feed that answered is not a feed that failed --
    // gating the bands made every athlete unknown, which briefly flipped this
    // tile to the failure copy and took the caveat down with it.
    expect(screen.queryByText('No signal')).toBeNull();
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

  /* PER ATHLETE, NOT ACROSS THE FEED. This was `items.some(...)`: one validated
     reading anywhere in the organization retired the caveat for every athlete
     on the tile, including the ones still carrying staff judgements. A mixed
     feed is exactly what the first validated method will produce, and it is
     exactly when the old flag went quiet. */
  test('one validated reading does not retire the caveat for the unvalidated ones', async () => {
    await renderWorkspace({
      athletesList: threeAthletes,
      readinessBoard: () => jsonResponse({
        items: [
          validatedEntry('ath_1', 'GREEN', 8),
          {
            athlete_id: 'ath_2', status: 'RED', score: 2,
            measured_at: '2026-08-15T12:00:00.000Z',
            method: 'staff_entered_intake',
            reliability_status: 'UNVALIDATED - PPBF MUST ESTABLISH',
            validity_status: 'UNKNOWN',
          },
        ],
      }),
    });

    // ath_1 is a real reading; ath_2 and ath_3 are not, and the caveat says so
    // rather than disappearing because ath_1 qualified.
    expect(screen.getByText(/staff judgement\(s\) recorded but not counted above/i)).toBeTruthy();
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

  test('the existing operational quick actions were not displaced by the new links', async () => {
    await renderWorkspace();

    expect(screen.getByRole('link', { name: 'Open Scheduler' }).getAttribute('href')).toBe('/schedule');
  });

  // Operations V1 (2026-08-21): the SHADOW Chat launcher and the Rabbit Hole
  // shortcut left the quick-action row -- a coach's Quick Actions are
  // operational work. Neither surface lost any access: the SHADOW Intel tab
  // below remains the coach's own intelligence surface, and /rabbit-holes
  // keeps its corridor door for the coach role.
  test('the lab shortcuts are gone from Quick Actions, and SHADOW Intel stays', async () => {
    await renderWorkspace();

    expect(screen.queryByRole('link', { name: /SHADOW Chat/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Write a Rabbit Hole' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open SHADOW Intel' })).toBeTruthy();
  });
});

// pilot.sessions.rpe is nullable as of
// pilot_slice_postgres_session_rpe_semantics_migration.sql, and the review
// picker labels each session with its RPE. normalizeReviewableSession ran
// `Number(record.rpe)` straight into `Number.isFinite`, and since Number(null)
// is 0 and Number.isFinite(0) is true, every unrated session was labelled for a
// coach as "RPE 0" -- a self-report the athlete never gave, on the screen where
// a coach decides what to say about that session.
describe('the review picker does not invent an RPE for a session nobody rated', () => {
  async function sessionOptionLabel(row: Record<string, unknown>): Promise<string> {
    await renderWorkspace({
      athletesList: () => jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'Jordan P.' }] }),
      sessionsList: () => jsonResponse({ items: [row] }),
    });
    openTab('Athlete Reviews');
    await pickReviewAthlete('ath_1');

    const option = screen
      .getAllByRole('option')
      .find((element) => (element as HTMLOptionElement).value === 'session_1');
    expect(option).toBeTruthy();
    return option?.textContent ?? '';
  }

  test('a null RPE is left off the label rather than shown as 0', async () => {
    const label = await sessionOptionLabel(sessionRow('session_1', { rpe: null }));
    expect(label).not.toMatch(/RPE/);
    expect(label).not.toMatch(/RPE 0/);
    // The rest of the label is real stored data and still has to be there.
    expect(label).toContain('2026-08-10');
    expect(label).toContain('completed');
  });

  test('a missing rpe key is left off the label too', async () => {
    const withoutRpe = sessionRow('session_1');
    delete withoutRpe.rpe;
    expect(await sessionOptionLabel(withoutRpe)).not.toMatch(/RPE/);
  });

  // The other half of the same rule: 0 is a real rung on this scale, so a
  // session the athlete genuinely rated 0 must still be labelled 0.
  test('a genuine RPE of 0 is still shown as 0', async () => {
    expect(await sessionOptionLabel(sessionRow('session_1', { rpe: 0 }))).toContain('RPE 0');
  });

  test('an ordinary reading is unaffected', async () => {
    expect(await sessionOptionLabel(sessionRow('session_1', { rpe: 6 }))).toContain('RPE 6');
  });
});
