/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { GYM_TIME_ZONE, formatGymDateNumeric } from '@/src/lib/gymTime';

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
  liveRun?: () => Promise<Response> | Response;
  scheduler?: () => Promise<Response> | Response;
  credentials?: () => Promise<Response> | Response;
  development?: () => Promise<Response> | Response;
  attendanceToday?: () => Promise<Response> | Response;
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
    // Default: a HEALTHY read of a coach who has written nothing down yet.
    // That matters for the same reason the live-run default does -- it makes
    // an 'unavailable' rendering in these tests a real signal rather than an
    // unstubbed-fetch artefact.
    if (url.includes('/api/pilot/coach/attendance-today')) {
      // Default is a HEALTHY read that found no marks -- an unregistered gym,
      // which is the ordinary state before class. That makes an 'Unavailable'
      // rendering in these tests a real signal rather than a mock artefact.
      return routes.attendanceToday
        ? routes.attendanceToday()
        : jsonResponse({ ok: true, day: '2026-08-28', covered: ['ath_1', 'ath_2'], marks: [] });
    }
    if (url.includes('/api/pilot/coach/development')) {
      return routes.development
        ? routes.development()
        : jsonResponse({ ok: true, goals: [], activities: [] });
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
 * Midday at the gym, on whatever day it is there right now.
 *
 * `now + 1 hour` -- what this fixture used -- is the gym's TOMORROW for the
 * last hour of every gym day. The dashboard filters classes to the gym's own
 * calendar day, so between 11pm and midnight Eastern the "class scheduled
 * today" was scheduled for tomorrow and the two tests below failed. Not a
 * flake and not a race: a one-hour window, every day, in which the suite is
 * red for a reason that has nothing to do with the code under test.
 *
 * Anchoring to midday keeps the fixture RELATIVE -- which is the reason it
 * was built from the clock in the first place, and still right, since a
 * frozen literal would drift out of "today" tomorrow -- while putting it
 * twelve hours from either boundary. The shift is computed in the gym's zone
 * from the same constant gymDayIso() uses, so the fixture and the filter
 * cannot disagree about which day it is.
 */
function gymMiddayToday(): Date {
  const now = new Date();
  const gymHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: GYM_TIME_ZONE,
    hour: 'numeric',
    hour12: false,
  }).format(now));
  return new Date(now.getTime() + (12 - gymHour) * 60 * 60 * 1000);
}

/**
 * A scheduled class starting around midday TODAY at the gym, as
 * GET /api/pilot/scheduler returns it in `classes`.
 *
 * Built from the current instant rather than a frozen literal because the
 * dashboard filters to the gym's own calendar day; a fixed date would make
 * this suite pass on one day and fail on the next.
 */
function classToday(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Anchored to NOW. It used to be now + 1h, and that made the suite depend on
  // what time of day it ran.
  //
  // CoachWorkspace keeps only classes whose gym-date equals today's -- it
  // filters on formatGymDateNumeric, and GYM_TIME_ZONE is America/New_York.
  // A class an hour in the future is TOMORROW's class during the last hour
  // before gym midnight, so the panel correctly rendered "No class is
  // scheduled for you today" and these assertions failed -- every night
  // between 23:00 and 00:00 New York, and passed the other twenty-three hours.
  //
  // That is what turned main red on 2026-08-29: 74d81b0 went green at 22:58 NY
  // and the very same code failed at 23:07 NY, with nothing changed in between
  // but the clock.
  //
  // Any FIXED offset from now can cross the boundary -- a positive one at
  // 23:59, a negative one at 00:01 -- so the offset has to be computed from
  // where in the gym's day we actually are. gymMiddayToday() does that,
  // landing twelve hours from either edge. Cases that need a different day
  // override start_at outright, the way "a class on another day" does.
  //
  // TWO LANES FIXED THIS FLAKE AT ONCE and a merge kept both of their `start`
  // lines, which is what took main red on TS2451 immediately after it had
  // just been taken green. The other line was `const start = now`: correct on
  // its own -- a zero offset cannot cross either -- and dropped rather than
  // merged because keeping it would leave gymMiddayToday() defined,
  // documented and uncalled. Midday keeps the wider margin of the two.
  const now = new Date();
  const start = gymMiddayToday();
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
 * Two more were added to that list when coach self-development shipped, and
 * they are the same defect one more time:
 *
 *   "There is no backend feed for coach         pilot.coach_development_goals +
 *    goals yet, so this section is always       /api/pilot/coach/development
 *    empty."
 *   "There is no backend store for              pilot.coach_development_activities
 *    completion yet"                            + the same route
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

/*
 * THE FIXTURE ITSELF, TESTED, because it is the thing that was wrong.
 *
 * The two tests below assert that a class scheduled today is drawn under
 * today's heading. They can only do that if the fixture really does schedule
 * one for today -- and for the last hour of every gym day, `now + 1 hour`
 * did not. The suite went red at 11pm Eastern and green again at midnight,
 * for a reason with nothing to do with the code under test.
 *
 * So the fixture is checked at the boundary hours rather than at whatever
 * hour the suite happens to run. `formatGymDateNumeric` is the component's
 * own filter (CoachWorkspace's loadTodayClasses compares exactly these two
 * values), so this asserts against the real comparison and not a restatement
 * of it.
 */
describe('the "class scheduled today" fixture is scheduled today, at every hour', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test.each([
    ['the last hour of the gym\'s day', '2026-08-29T03:30:00Z'],
    ['the first hour of the next one', '2026-08-29T04:30:00Z'],
    ['the middle of the gym\'s afternoon', '2026-08-29T18:00:00Z'],
    ['the small hours', '2026-08-29T07:00:00Z'],
    ['a winter instant, when the offset is an hour different', '2026-01-15T04:30:00Z'],
  ])('holds at %s', (_label, instant) => {
    jest.useFakeTimers().setSystemTime(new Date(instant));

    const scheduled = classToday().start_at as string;
    expect([instant, formatGymDateNumeric(scheduled)])
      .toEqual([instant, formatGymDateNumeric(new Date())]);
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

    // Named specifically. The development panel beside this one has its own
    // "could not be read" box, and a bare /could not be read/ match would go
    // green whichever of the two failed -- including when this one did not.
    expect(screen.queryByText(/credential record could not be read/i)).not.toBeNull();
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

  test('Development topics are a reference list, not a checklist', async () => {
    await renderWorkspace();
    openTab('Development');

    // Still named, and still nothing to tick. Ticking one off would need this
    // platform to decide what "completed Adaptive Coaching" means, which is
    // coaching curriculum it does not possess -- so a topic a coach worked
    // through is recorded as work they did, in their own words.
    expect(screen.queryByText(/Injury Prevention Basics/)).not.toBeNull();
    expect(screen.queryByText(/reference list, not a syllabus and not a checklist/i)).not.toBeNull();
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

/*
 * COACH SELF-DEVELOPMENT: the hub's last two "not built" claims.
 *
 * The Goals tab said "There is no backend feed for coach goals yet, so this
 * section is always empty", and the Development tab said "There is no backend
 * store for completion yet". Both were true when written. Both stopped being
 * true when /api/pilot/coach/development shipped, and a coach reading either
 * one keeps their development in a notebook.
 *
 * The other half of this is a fabrication rather than a denial, and it is the
 * more dangerous of the two: the Goals tab shipped with three hardcoded goals
 * carrying progress bars -- "68%", "45%" -- rendered identically for every
 * coach who logged in. The goals were deleted; the BAR AND THE PERCENTAGE
 * STAYED, dead code over an always-empty list, waiting for somebody to point a
 * real feed at them. That is exactly what this slice does, so the shape is
 * asserted gone rather than assumed gone.
 */
function developmentGoalRow(overrides: Record<string, unknown> = {}) {
  return {
    goal_id: 'goal-1',
    title: 'Corner work under pressure',
    development_focus: 'Keep the anxious kids in the room during hard rounds.',
    target_on: '2026-12-01',
    status: 'draft',
    ...overrides,
  };
}

function developmentActivityRow(overrides: Record<string, unknown> = {}) {
  return {
    activity_id: 'act-1',
    title: 'Youth coaching clinic',
    provider: 'USA Boxing',
    occurred_on: '2026-03-12',
    duration_minutes: 180,
    ...overrides,
  };
}

describe("the hub reads the coach's own development record", () => {
  test('the Goals tab no longer denies that a coach-goal backend exists', async () => {
    await renderWorkspace({
      development: () => jsonResponse({ ok: true, goals: [developmentGoalRow()], activities: [] }),
    });
    openTab('Goals');

    expect(screen.queryByText(/no backend feed for coach goals/i)).toBeNull();
    expect(screen.queryByText(/Planned — Not Yet Implemented/)).toBeNull();
    expect(screen.queryByText('Corner work under pressure')).not.toBeNull();
    expect(screen.queryByText(/Keep the anxious kids in the room/)).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Write or change a goal' }).getAttribute('href'))
      .toBe('/coach/development');
  });

  test('the Development tab no longer denies that recorded work can be stored', async () => {
    await renderWorkspace({
      development: () => jsonResponse({
        ok: true, goals: [], activities: [developmentActivityRow()],
      }),
    });
    openTab('Development');

    expect(screen.queryByText(/no backend store for completion/i)).toBeNull();
    expect(screen.queryByText('Youth coaching clinic')).not.toBeNull();
    expect(screen.queryByText('March 12, 2026 · USA Boxing')).not.toBeNull();
  });

  test('the hub actually reads the development route rather than assuming an answer', async () => {
    const fetchMock = await renderWorkspace();
    const called = fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/api/pilot/coach/development'));
    expect(called).toBe(true);
  });

  test('NO PROGRESS BAR AND NO PERCENTAGE survives against a real goal', async () => {
    await renderWorkspace({
      development: () => jsonResponse({
        ok: true,
        goals: [
          developmentGoalRow(),
          developmentGoalRow({ goal_id: 'goal-2', title: 'Read the room', status: 'active' }),
        ],
        activities: [],
      }),
    });
    openTab('Goals');

    /* The dead bar this slice removed rendered `{goal.progress}%` inside the
       goal's own card, above a div whose width was set from it. Both shapes
       are asserted absent -- the word, and the element that would draw one
       without it.

       Scoped to the card, because an unscoped /Progress/i match hits the
       dashboard's "No session in progress" line, which renders whatever tab is
       open and has nothing to do with this.

       `.mat-leather`, not `div`: the first version of this said
       `.closest('div')`, which lands on the flex row holding the title and the
       badge -- NOT the card. A mutation adding a progress bar below that row
       survived it. The card is the mat-leather panel, and that is what has to
       be free of one. */
    const card = screen.getByText('Corner work under pressure').closest('.mat-leather') as HTMLElement;
    expect(card.textContent ?? '').not.toMatch(/progress/i);
    expect(card.textContent ?? '').not.toMatch(/\d+\s*%/);
    expect(card.querySelectorAll('[style*="width"]')).toHaveLength(0);
    expect(document.querySelectorAll('progress')).toHaveLength(0);
    expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(0);

    // Guards the guard: both goals really did render.
    expect(screen.queryByText('Read the room')).not.toBeNull();
  });

  test('a goal with no target date shows no date line rather than an empty "Due:"', async () => {
    await renderWorkspace({
      development: () => jsonResponse({
        ok: true, goals: [developmentGoalRow({ target_on: null })], activities: [],
      }),
    });
    openTab('Goals');

    expect(screen.queryByText('Corner work under pressure')).not.toBeNull();
    expect(screen.queryByText(/Target date/)).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('Due:');
    expect(document.body.textContent ?? '').not.toContain('null');
  });

  test('a failed development read is UNAVAILABLE, not "you have written nothing down"', async () => {
    await renderWorkspace({ development: () => jsonResponse({}, { ok: false, status: 503 }) });
    openTab('Goals');

    expect(screen.queryByText(/goals could not be read/i)).not.toBeNull();
    // The claim this must never collapse into. A coach who reads it writes
    // down a goal they already had.
    expect(screen.queryByText(/have not written down a development goal/i)).toBeNull();
  });

  test('a failed development read does not blank the credential panel beside it', async () => {
    await renderWorkspace({
      development: () => jsonResponse({}, { ok: false, status: 503 }),
      credentials: () => jsonResponse({ ok: true, items: [credentialRow()] }),
    });
    openTab('Development');

    // Two records of very different standing on one tab. One read failing
    // must not take the other down with it -- the credential panel is the
    // verified one, and it answered.
    expect(screen.queryByText('SafeSport Training')).not.toBeNull();
    expect(screen.queryByText('Current')).not.toBeNull();
    expect(screen.queryByText(/development record could not be read/i)).not.toBeNull();
  });

  test('recorded work is never presented as a verified credential', async () => {
    await renderWorkspace({
      development: () => jsonResponse({
        ok: true,
        goals: [],
        activities: [developmentActivityRow({
          title: 'SafeSport refresher', provider: 'US Center for SafeSport',
        })],
      }),
    });
    openTab('Development');

    // A coach may well log this. What must never appear with it is a band, an
    // expiry or the word verified -- that record lives in
    // pilot.person_clearances and an administrator confirms it.
    expect(screen.queryByText('SafeSport refresher')).not.toBeNull();
    // The panel says plainly which record is the verified one, rather than
    // leaving a coach to work out that this list is not it.
    expect(screen.queryByText(/Self-entered/i)).not.toBeNull();
    /* Scoped to the ROW, not the panel: the panel's own sentence contains the
       word "verified" on purpose, and asserting over the whole panel would
       force that sentence to be deleted to make a test pass. What must carry
       no verification language is the entry itself. */
    const row = screen.getByText('SafeSport refresher').closest('li') as HTMLElement;
    expect(row.textContent ?? '').not.toMatch(/verified|expires|awaiting review|current/i);
    expect(row.querySelectorAll('.badge')).toHaveLength(0);
  });
});

/*
 * A GOAL STATE THIS BUILD DOES NOT KNOW.
 *
 * The status union was written down three times -- server, hub, standalone
 * page -- so a fifth state added server-side compiled clean everywhere and
 * failed only once a coach had one. The union now has one home
 * (src/shared/coachDevelopment.ts) and both surfaces read it, but a client is
 * always some deploys behind a server, so an unknown state still has to
 * render, and it has to render honestly.
 */
describe('a goal state the hub does not recognise', () => {
  const unknownStatusGoal = () => jsonResponse({
    ok: true,
    goals: [developmentGoalRow({ status: 'paused' })],
    activities: [],
  });

  test('the card survives, rather than taking the tab down with it', async () => {
    await renderWorkspace({ development: unknownStatusGoal });
    openTab('Goals');

    expect(screen.queryByText('Corner work under pressure')).not.toBeNull();
    expect(screen.queryByText(/goals could not be read/i)).toBeNull();
  });

  test('the state is shown as the word it arrived as, never as a state we do know', async () => {
    await renderWorkspace({ development: unknownStatusGoal });
    openTab('Goals');

    const card = screen.getByText('Corner work under pressure').closest('.mat-leather') as HTMLElement;
    expect(card.textContent ?? '').toContain('paused');
    for (const known of ['Draft', 'Working on it', 'Completed', 'Cancelled']) {
      expect([known, (card.textContent ?? '').includes(known)]).toEqual([known, false]);
    }
  });

  /* THE FALLBACK'S SHAPE, which nothing checked. It supplied a `className`
     while this render reads `badge.tone`, so an unknown status produced
     `class="badge badge--undefined"` and no glyph -- a badge that renders as
     an unstyled word. TypeScript could not see it: Record<K, V> indexing is
     typed non-nullable, so `?? fallback` narrows to the left operand and the
     fallback is checked against nothing at all. */
  test('the badge is a real neutral badge, not an undefined one', async () => {
    await renderWorkspace({ development: unknownStatusGoal });
    openTab('Goals');

    const card = screen.getByText('Corner work under pressure').closest('.mat-leather') as HTMLElement;
    const badge = card.querySelector('.badge') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.className).toContain('badge--filed');
    expect(badge.className).not.toContain('undefined');
    expect(document.querySelectorAll('[class*="badge--undefined"]')).toHaveLength(0);
    // 'neutral' renders the open circle. No glyph at all is what the broken
    // shape produced.
    expect(badge.textContent ?? '').toContain('◌');
  });

  test('a known state is unaffected and still reads in the shared wording', async () => {
    await renderWorkspace({
      development: () => jsonResponse({
        ok: true, goals: [developmentGoalRow({ status: 'active' })], activities: [],
      }),
    });
    openTab('Goals');

    const card = screen.getByText('Corner work under pressure').closest('.mat-leather') as HTMLElement;
    expect(card.textContent ?? '').toContain('Working on it');
  });
});

/*
 * DATES READ AS DAYS, NOT AS COLUMNS. These are calendar days a coach typed,
 * and 'YYYY-MM-DD' is the storage spelling, not a rendering. formatGymDay
 * formats a date-only value in UTC deliberately -- it was parsed as UTC
 * midnight, so any other zone can only move it backwards a day.
 */
describe("the hub's development dates are days", () => {
  test('a goal target date is written out', async () => {
    await renderWorkspace({
      development: () => jsonResponse({
        ok: true, goals: [developmentGoalRow({ target_on: '2026-12-01' })], activities: [],
      }),
    });
    openTab('Goals');

    expect(screen.queryByText('Target date December 1, 2026')).not.toBeNull();
    expect(document.body.textContent ?? '').not.toContain('2026-12-01');
  });

  test('a date on the first of a month does not slip to the last of the one before', async () => {
    await renderWorkspace({
      development: () => jsonResponse({
        ok: true, goals: [developmentGoalRow({ target_on: '2026-01-01' })], activities: [],
      }),
    });
    openTab('Goals');

    expect(screen.queryByText('Target date January 1, 2026')).not.toBeNull();
    expect(document.body.textContent ?? '').not.toContain('December 31, 2025');
  });
});

/*
 * ONE ATHLETE'S SESSIONS UNDER ANOTHER ATHLETE'S NAME.
 *
 * loadReviewSessions checked `reviewAthleteRef.current !== athleteId` once,
 * straight after `await fetch`. Reading the body is a SECOND suspension
 * point, and a coach who changed athlete during it landed the previous
 * athlete's session list under the new athlete's name -- one athlete's
 * training record attributed to another, with nothing on screen saying so.
 *
 * The existing "switching athletes clears the panel" test above cannot see
 * this: it switches between two loads that have already finished.
 */
describe('a slow session read that lands after the coach moved on', () => {
  function deferredBody(body: unknown): { response: Response; release: () => void } {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const response = {
      ok: true,
      status: 200,
      json: async () => { await gate; return body; },
    } as unknown as Response;
    return { response, release };
  }

  test("the stale athlete's sessions never replace the athlete the coach is on", async () => {
    const stale = deferredBody({ items: [sessionRow('session_stale', { date: '2026-01-01' })] });

    await renderWorkspace({
      athletesList: () =>
        jsonResponse({
          items: [
            { athlete_id: 'ath_1', full_name: 'Jordan P.' },
            { athlete_id: 'ath_2', full_name: 'Sam R.' },
          ],
        }),
      sessionsList: (athleteId: string) =>
        athleteId === 'ath_1'
          ? stale.response
          : jsonResponse({ items: [sessionRow('session_fresh', { date: '2026-08-10' })] }),
    });

    openTab('Athlete Reviews');
    // Parks inside `await response.json()` -- the fetch has resolved and the
    // first guard has already passed.
    await pickReviewAthlete('ath_1');
    // The coach moves on. This load completes.
    await pickReviewAthlete('ath_2');

    const optionValues = () =>
      screen.queryAllByRole('option').map((element) => (element as HTMLOptionElement).value);
    expect(optionValues()).toContain('session_fresh');

    // Now the abandoned read finishes.
    await act(async () => { stale.release(); });

    expect(optionValues()).toContain('session_fresh');
    expect(optionValues()).not.toContain('session_stale');
  });
});

/*
 * THE SUMMARY ROW AT THE TOP OF THE COACH'S OWN SCREEN.
 *
 * Four tiles and one empty-floor line, and every one of them was making a
 * claim from something the platform does not actually read. This is the
 * highest-traffic surface in the building -- it is what a coach sees before
 * anything else -- and it is the last place in the room where the null
 * contract ParentSummaryPanel documents had not been applied.
 */
describe('the coach summary row claims only what was actually read', () => {
  const roster = () => jsonResponse({
    items: [
      { athlete_id: 'ath_1', full_name: 'Jordan P.' },
      { athlete_id: 'ath_2', full_name: 'Rosa D.' },
    ],
  });

  test('a coach with a roster is not told nobody is assigned to them', async () => {
    /* THE ONE THAT WAS WRONG FOR EVERY COACH, ALWAYS. The empty-floor branch
       keyed off athletes whose attendance was not 'Unknown', and loadAthletes
       hardcodes 'Unknown' for all of them because no attendance feed exists.
       So the count was permanently 0 and this sentence printed above every
       real roster in the gym. */
    await renderWorkspace({ athletesList: roster });

    expect(screen.queryByText(/Nobody is assigned to you yet/i)).toBeNull();
  });

  test('a coach who genuinely has nobody is still told so', async () => {
    // The other direction. An empty floor is a real state and keeps its line;
    // it is just no longer the only state the panel can reach.
    await renderWorkspace({ athletesList: () => jsonResponse({ items: [] }) });

    expect(screen.queryByText(/Nobody is assigned to you yet/i)).not.toBeNull();
  });

  /* Read ONE named tile's value, by walking from its label to the tile.
     A bare queryAllByText('Unavailable') is not good enough here and proved
     it: the word appears elsewhere on this screen, so that assertion passed
     against a panel still printing 0 on every tile. The mutation survived
     until this helper replaced it. */
  function tileValue(label: string): string {
    const labels = Array.from(document.querySelectorAll('.stat-label, .t-label'))
      .filter((node) => node.textContent?.trim() === label);
    expect(labels).toHaveLength(1);
    const tile = labels[0].parentElement;
    // The label itself is stripped so only the value remains to assert on.
    return (tile?.textContent ?? '').replace(label, '').trim();
  }

  test('the summary tiles say Unavailable rather than 0 when nothing answered', async () => {
    /* coachTasks is empty whenever the review queue read failed, so both
       counts derived from it were 0 -- a confident "nothing waiting for you"
       over a queue nobody could look at. And injuryFlag is null for every
       athlete, because no injury feed exists at all. */
    await renderWorkspace({
      athletesList: roster,
      reviewProjection: async () => jsonResponse({}, { ok: false, status: 503 }),
    });

    for (const label of ['Injuries', 'Reviews', 'Due']) {
      expect([label, tileValue(label)]).toEqual([label, 'Unavailable']);
    }
  });

  test('a real count still renders as a number, including a real zero', async () => {
    /* The other direction, and the one that keeps the fix honest: a panel
       that printed "Unavailable" unconditionally would satisfy the test above
       while telling a coach nothing. A queue that WAS read and holds nothing
       is the good news they came for. */
    await renderWorkspace({ athletesList: roster });

    expect(tileValue('Reviews')).toBe('0');
    expect(tileValue('Due')).toBe('0');
    // Injuries has no feed at all, so it is Unavailable even on a good read.
    expect(tileValue('Injuries')).toBe('Unavailable');
  });

  test('the Open Reviews tile says the queue could not be read, not "0"', async () => {
    /* Its two siblings in the same section already guarded this exact case
       and said so out loud. This tile alone rendered the bare count. */
    await renderWorkspace({
      athletesList: roster,
      reviewProjection: async () => jsonResponse({}, { ok: false, status: 503 }),
    });

    expect(
      screen.queryByText(/The review queue could not be read -- do not read this as "no reviews"/i),
    ).not.toBeNull();
  });

  test('a healthy queue still shows its real counts, including a real zero', async () => {
    /* Without this, a panel that rendered "Unavailable" unconditionally would
       pass every test above. A genuine 0 from a queue that WAS read is the
       good news a coach came for, and it must survive. */
    await renderWorkspace({ athletesList: roster });

    expect(
      screen.queryByText(/The review queue could not be read/i),
    ).toBeNull();
    expect(screen.queryByText(/Resolve queue items this session/i)).not.toBeNull();
  });

  test('the dashboard injury tile still says the feed does not exist', async () => {
    // The pre-existing guard on the dashboard tile, asserted here so the
    // summary-row change above cannot be mistaken for the whole story.
    await renderWorkspace({ athletesList: roster });

    expect(screen.queryByText(/do not read this as "no injuries"/i)).not.toBeNull();
  });
});

/*
 * TODAY'S REGISTER ON THE ROSTER.
 *
 * This column read "Unknown" for every athlete since the workspace was built,
 * because `attendance` was hardcoded with no feed behind it. Wiring a real one
 * introduces the failure this whole file exists to prevent: a register that
 * did not load looks exactly like a register in which nobody is marked, and
 * "Absent" next to a child's name is a claim the platform has to have earned.
 */
describe('the roster shows today\'s marks, and says which ones it does not have', () => {
  const roster = () => jsonResponse({
    items: [
      { athlete_id: 'ath_1', full_name: 'Jordan P.' },
      { athlete_id: 'ath_2', full_name: 'Rosa D.' },
    ],
  });

  test('a recorded mark is shown as itself', async () => {
    await renderWorkspace({
      athletesList: roster,
      attendanceToday: () => jsonResponse({
        ok: true,
        day: '2026-08-28',
        covered: ['ath_1', 'ath_2'],
        marks: [{ athlete_id: 'ath_1', status: 'present', source: 'activity_log' }],
      }),
    });

    expect(screen.queryByText('Present')).not.toBeNull();
  });

  test('an athlete nobody has marked reads "No mark yet", never "Absent"', async () => {
    /* THE ONE THAT MATTERS MOST. Before the register is taken every athlete
       is in this state. Rendering it as Absent would report a child missed
       training because a coach had not got to the tablet yet. */
    await renderWorkspace({
      athletesList: roster,
      attendanceToday: () => jsonResponse({
        ok: true,
        day: '2026-08-28',
        covered: ['ath_1', 'ath_2'],
        marks: [{ athlete_id: 'ath_1', status: 'present', source: 'activity_log' }],
      }),
    });

    expect(screen.queryByText('No mark yet')).not.toBeNull();
    expect(screen.queryByText('Absent')).toBeNull();
  });

  test('a register that could not be read says so, for everyone', async () => {
    await renderWorkspace({
      athletesList: roster,
      attendanceToday: () => jsonResponse({}, { ok: false, status: 503 }),
    });

    /* Everyone, not just the unmarked: the read that failed covered the whole
       roster, so no athlete's attendance on this screen rests on anything. */
    expect(screen.queryAllByText('Register unavailable')).toHaveLength(2);
    expect(screen.queryByText('No mark yet')).toBeNull();
    expect(screen.queryByText('Absent')).toBeNull();
  });

  test('a failed register does not take the roster down with it', async () => {
    // The reason this is a separate read from the athlete list at all: the
    // names are the more important half and must survive.
    await renderWorkspace({
      athletesList: roster,
      attendanceToday: () => jsonResponse({}, { ok: false, status: 503 }),
    });

    expect(screen.queryByText('Jordan P.')).not.toBeNull();
    expect(screen.queryByText('Rosa D.')).not.toBeNull();
  });

  test('a genuinely absent athlete is still shown as absent', async () => {
    /* The other direction. A feed that rendered everything as "No mark yet"
       would satisfy every test above while telling a coach nothing -- a
       recorded absence is a real mark and must survive. */
    await renderWorkspace({
      athletesList: roster,
      attendanceToday: () => jsonResponse({
        ok: true,
        day: '2026-08-28',
        covered: ['ath_1', 'ath_2'],
        marks: [
          { athlete_id: 'ath_1', status: 'absent', source: 'scheduler_attendance' },
          { athlete_id: 'ath_2', status: 'excused', source: 'attendance' },
        ],
      }),
    });

    expect(screen.queryByText('Absent')).not.toBeNull();
    expect(screen.queryByText('Excused')).not.toBeNull();
    expect(screen.queryByText('Register unavailable')).toBeNull();
  });
});

/*
 * THE ROSTER IS WIDER THAN THE REGISTER, AND THE GAP IS A THIRD STATE.
 *
 * /api/pilot/athletes/list returns EVERY athlete in the organization to a
 * coach -- it is a display projection and redacts fields rather than rows.
 * The register is read through the access contract instead, so it is
 * deliberately narrower. An athlete on screen but outside it was never asked
 * about, and the first version of this feature rendered them "No mark yet":
 * the platform claiming it looked, about a child it never looked at.
 *
 * Found by a review bot on the pull request, verified against the roster
 * query, and fixed here rather than argued with.
 */
describe('an athlete the register did not cover is not an athlete with no mark', () => {
  const wholeOrgRoster = () => jsonResponse({
    items: [
      { athlete_id: 'ath_1', full_name: 'Jordan P.' },
      { athlete_id: 'ath_2', full_name: 'Rosa D.' },
      // On the roster, outside this coach's authorized set.
      { athlete_id: 'ath_other', full_name: 'Sam K.' },
    ],
  });

  test('an athlete outside the covered set reads "Not your athlete", never "No mark yet"', async () => {
    await renderWorkspace({
      athletesList: wholeOrgRoster,
      attendanceToday: () => jsonResponse({
        ok: true,
        day: '2026-08-28',
        covered: ['ath_1', 'ath_2'],
        marks: [{ athlete_id: 'ath_1', status: 'present', source: 'activity_log' }],
      }),
    });

    expect(screen.queryByText('Not your athlete')).not.toBeNull();
    // ath_2 IS covered and unmarked, so exactly one "No mark yet" -- the
    // uncovered athlete must not have joined it.
    expect(screen.queryAllByText('No mark yet')).toHaveLength(1);
  });

  test('a covered athlete with no mark still reads "No mark yet"', async () => {
    /* The other direction. A build that rendered everything unmarked as
       "Not your athlete" would satisfy the test above while telling a coach
       their own athletes are somebody else's. */
    await renderWorkspace({
      athletesList: wholeOrgRoster,
      attendanceToday: () => jsonResponse({
        ok: true,
        day: '2026-08-28',
        covered: ['ath_1', 'ath_2', 'ath_other'],
        marks: [],
      }),
    });

    expect(screen.queryAllByText('No mark yet')).toHaveLength(3);
    expect(screen.queryByText('Not your athlete')).toBeNull();
  });

  test('a failed register still covers everyone, uncovered athletes included', async () => {
    // The read failed, so nothing on this column rests on anything -- the
    // covered/uncovered distinction is not knowable either.
    await renderWorkspace({
      athletesList: wholeOrgRoster,
      attendanceToday: () => jsonResponse({}, { ok: false, status: 503 }),
    });

    expect(screen.queryAllByText('Register unavailable')).toHaveLength(3);
    expect(screen.queryByText('Not your athlete')).toBeNull();
    expect(screen.queryByText('No mark yet')).toBeNull();
  });
});
