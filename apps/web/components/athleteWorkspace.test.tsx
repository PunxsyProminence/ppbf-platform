/**
 * @jest-environment jsdom
 */

// The athlete workspace is the one surface a minor sees as "their" data, so the
// two failure modes covered here are the ones that mislead hardest: a tile or a
// tab that states something the backend never said, and a control that looks
// like it did something it did not.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: function MockLink({ href, children, ...rest }: { href: string; children: React.ReactNode }) {
    return React.createElement('a', { href, ...rest }, children);
  },
}));

import { GOAL_CATEGORIES } from '@/src/server/pilot/contracts';
import { FORMULA_UNITS, OBSERVATION_KINDS } from '@/src/server/pilot/formulas/types';
import type { AnnouncementItem } from './AnnouncementBanner';
import type { RabbitHoleLessonItem } from './RabbitHole';
import AthleteWorkspace, { SMART_GOAL_CATEGORIES } from './AthleteWorkspace';

type FetchCall = { url: string; method: string; body: Record<string, unknown> };

const fetchCalls: FetchCall[] = [];
let authenticated = true;
let resolveGoalPost: ((value: unknown) => void) | null = null;
let painObservationResponse: Response | null = null;
let liveAnnouncements: AnnouncementItem[] = [];
let announcementsFail = false;
let rabbitHolesByAnchor: Record<string, RabbitHoleLessonItem[]> = {};
let rabbitHolesFail = false;
let storedSessions: Array<Record<string, unknown>> = [];
let sessionListFails = false;
let sessionUpdateFails = false;
let persistSessionUpdates = false;
let holdDraftSaves = false;
// Draft saves held on the wire, oldest first. A test releases them in the order it wants to prove against.
let heldDraftSaves: Array<() => void> = [];
let storedGoals: Array<Record<string, unknown>> = [];
let goalUpdateFails = false;
let sessionCreateFails = false;
let storedAssignments: Array<Record<string, unknown>> = [];
/**
 * W-D2: what /api/pilot/drill-library answers for an athlete -- the reference
 * drills this gym has adopted, already filtered and projected by the server.
 * The client never filters; there is nothing here for it to filter WITH.
 */
let storedReferenceDrills: Array<Record<string, unknown>> = [];
/** W-D4A: the athlete detail for an opened drill, keyed by reference drill id. */
let storedReferenceDrillDetails: Record<string, Record<string, unknown>> = {};
/** W-D4A: make the detail read fail with a server error (not a 404). */
let detailReadFails = false;
let storedCheckIn: Record<string, unknown> | null;
let checkInReadFails: boolean;
/** A-FIN-01: hold the wellness READ open for the whole test, so "still loading" can be asserted. */
let checkInReadPending: boolean;
let assignmentsFail = false;
let assignmentsPending = false;

// pilot.sessions stores date as `date` and rpe as `numeric`, so node-postgres
// hands back a timestamp and a string, and the session validator rejects
// either shape on the way back in.
//
// This fixture is deliberately a PRE-MIGRATION row: an open session carrying
// rpe '8' and no rpe_method at all. That 8 is not an effort reading -- it is
// the pre-session readiness slider, which is what check-in wrote into this
// column before pilot_slice_postgres_session_rpe_semantics_migration.sql
// separated the two. The tests below are about what the app does with such a
// row now, which is: replay it untouched on a notes save, and never promote it
// to a session RPE at check-out.
function openSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'session_1754000000000',
    athlete_id: 'ath_test',
    date: '2026-08-01T00:00:00.000Z',
    rpe: '8',
    notes: 'Left hook felt slow all session, right shoulder tight.',
    completed_flag: false,
    created_at: '2026-08-01T17:05:00.000Z',
    updated_at: '2026-08-01T17:05:00.000Z',
    ...overrides,
  };
}

function announcement(overrides: Partial<AnnouncementItem> = {}): AnnouncementItem {
  return {
    announcement_id: 'ann_1',
    message: 'Hands up, chin down.',
    author_name: 'Coach J.',
    author_role: 'coach',
    created_at: '2026-07-30T12:00:00.000Z',
    placement: 'athlete_workspace',
    kind: 'motivation',
    active: true,
    starts_at: null,
    ends_at: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

function parseBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function postedTo(path: string): FetchCall[] {
  return fetchCalls.filter((call) => call.method === 'POST' && call.url.endsWith(path));
}

/** Every request that touched the generated-plan route, by any method. */
function floorPlanCalls(): FetchCall[] {
  return fetchCalls.filter((call) => call.url.includes('/api/pilot/floor-plans'));
}

/** The surface the masthead says is open -- the one line that follows activeTab. */
function openSurface(): string {
  return (screen.getByText(/^Athlete workspace · /).textContent ?? '').replace('Athlete workspace · ', '');
}

/**
 * The work on the Floor, in the order drawn. Read off each card's Log
 * completion link -- every open card has one -- because other panels on the
 * page draw level-4 headings of their own.
 */
function floorWorkTitles(): string[] {
  return screen
    .getAllByRole('link', { name: /^Log completion: / })
    .map((link) => (link.getAttribute('aria-label') ?? '').replace('Log completion: ', ''));
}

/** One coach-assigned row as GET /api/pilot/progression/assignments returns it. */
function assignment(overrides: Record<string, unknown> = {}) {
  return {
    assignment_id: 'as-1',
    drill_id: 'drl-1',
    gap_id: 'gap-1',
    drill_name: 'jab_cross',
    drill_display_name: 'Jab-cross on the bag',
    drill_description: 'Two-punch combination.',
    drill_difficulty: 'beginner',
    status: 'assigned',
    completion_percentage: 0,
    created_at: '2026-09-20T17:00:00.000Z',
    ...overrides,
  };
}

/** A stored check-in for today, in the shape GET /api/pilot/athlete/check-in
 * returns it. Every wellness value is null on purpose: absent is the normal
 * state, and a fixture full of numbers would let a component that renders
 * null as 0 or 3 pass anyway. */
function checkedInRecord(): Record<string, unknown> {
  return {
    check_in_id: 'ci_test',
    checked_in_on: '2026-08-28',
    energy: null,
    soreness: null,
    focus: null,
    sleep_hours: null,
    hydration: null,
    motivation: null,
    mental_clarity: null,
    stress: null,
    nutrition_compliance: null,
    note: '',
  };
}

beforeEach(() => {
  fetchCalls.length = 0;
  authenticated = true;
  resolveGoalPost = null;
  painObservationResponse = null;
  liveAnnouncements = [];
  announcementsFail = false;
  rabbitHolesByAnchor = {};
  rabbitHolesFail = false;
  storedSessions = [];
  sessionListFails = false;
  sessionUpdateFails = false;
  persistSessionUpdates = false;
  holdDraftSaves = false;
  heldDraftSaves = [];
  storedGoals = [];
  goalUpdateFails = false;
  sessionCreateFails = false;
  storedAssignments = [];
  storedReferenceDrills = [];
  storedReferenceDrillDetails = {};
  detailReadFails = false;
  assignmentsFail = false;
  assignmentsPending = false;
  // Checked in by default. The Floor is gated on today's check-in (owner
  // decision 2026-08-28), so a workspace that had NOT checked in would hide
  // the day's work from every test below that is about the floor rather than
  // about the gate. The gate's own cases set this to null explicitly.
  storedCheckIn = checkedInRecord();
  checkInReadFails = false;
  checkInReadPending = false;

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, method: init?.method ?? 'GET', body: parseBody(init) });

    if (url.includes('/api/pilot/shadow/formulas/observations') && painObservationResponse) {
      return painObservationResponse;
    }
    if (url.includes('/api/pilot/athlete/check-in')) {
      if (checkInReadFails) throw new Error('check-in offline');
      if ((init?.method ?? 'GET') === 'POST') {
        storedCheckIn = { ...checkedInRecord(), ...parseBody(init) };
        return jsonResponse({ item: storedCheckIn, already_checked_in: false });
      }
      if (checkInReadPending) {
        // Never answers: the wellness read is still in flight for the whole test.
        return new Promise<Response>(() => {});
      }
      return jsonResponse({
        today: storedCheckIn,
        recent: storedCheckIn ? [storedCheckIn] : [],
      });
    }
    if (url.includes('/api/pilot/rabbit-holes/get')) {
      if (rabbitHolesFail) {
        throw new Error('rabbit holes offline');
      }
      const { anchor_type: anchorType, anchor_key: anchorKey } = parseBody(init);
      return jsonResponse({
        ok: true,
        rabbit_holes: rabbitHolesByAnchor[`${String(anchorType)}:${String(anchorKey)}`] ?? [],
      });
    }
    if (url.includes('/api/pilot/announcements/get')) {
      if (announcementsFail) {
        throw new Error('announcements offline');
      }
      const { kind } = parseBody(init);
      return jsonResponse({ ok: true, announcements: liveAnnouncements.filter((item) => item.kind === kind) });
    }
    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse(authenticated ? { authenticated: true, athlete_id: 'ath_test' } : { authenticated: false });
    }
    if (url.includes('/api/pilot/sessions/list')) {
      if (sessionListFails) {
        throw new Error('sessions offline');
      }
      return jsonResponse({ items: storedSessions });
    }
    if (url.includes('/api/pilot/sessions/update')) {
      const body = parseBody(init);
      // Applied the way pilot.sessions applies it: the write that ARRIVES last
      // wins, with no ordering check, and numeric rpe comes back as a string.
      const apply = () => {
        if (!persistSessionUpdates) return;
        storedSessions = storedSessions.map((row) => (row.session_id === body.session_id
          ? { ...row, ...body, rpe: body.rpe === null ? null : String(body.rpe) }
          : row));
      };
      if (!sessionUpdateFails && holdDraftSaves && body.completed_flag === false) {
        // A draft save held on the wire until the test lets it arrive.
        return new Promise<Response>((resolve) => {
          heldDraftSaves.push(() => {
            apply();
            resolve(jsonResponse({ ok: true }));
          });
        });
      }
      if (!sessionUpdateFails) apply();
      return jsonResponse(sessionUpdateFails ? { error: 'Internal server error' } : { ok: true }, !sessionUpdateFails);
    }
    if (url.endsWith('/api/pilot/sessions') && init?.method === 'POST' && sessionCreateFails) {
      return jsonResponse({ error: 'Internal server error' }, false);
    }
    if (url.includes('/api/pilot/goals/list')) {
      return jsonResponse({ items: storedGoals });
    }
    // Must be matched before the bare /api/pilot/goals branch below, which is
    // held open on purpose for the double-click test.
    if (url.includes('/api/pilot/goals/update')) {
      return jsonResponse(goalUpdateFails ? { error: 'Internal server error' } : { ok: true }, !goalUpdateFails);
    }
    // Still answered, so a component that went back to reading or writing a
    // generated plan would get a plan-shaped reply -- and the cases below that
    // assert no call reaches this route would catch it doing so.
    if (url.includes('/api/pilot/floor-plans')) {
      return jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/progression/assignments')) {
      if (assignmentsFail) {
        throw new Error('assignments offline');
      }
      if (assignmentsPending) {
        // Never answers: the read is still in flight for the whole test.
        return new Promise<Response>(() => {});
      }
      return jsonResponse({ items: storedAssignments });
    }
    // W-D2: the Learn surface reads the reference library, not the operational
    // drill list. Matched BEFORE any bare /api/pilot/drills branch would be,
    // and answering under `drills` -- the key that route uses -- so a client
    // reading `items` here renders empty instead of passing.
    // W-D4A: an opened drill reads the athlete DETAIL, answered under `drill`.
    // Matched first, on the query string, so a client that asked the list for a
    // detail would get no drill and fail rather than pass.
    if (url.includes('/api/pilot/drill-library?drill_id=')) {
      const drillId = decodeURIComponent(url.split('drill_id=')[1] ?? '');
      if (detailReadFails) return { ok: false, status: 500, json: async () => ({ error: 'Internal server error' }) } as unknown as Response;
      const detail = storedReferenceDrillDetails[drillId];
      return detail
        ? jsonResponse({ drill: detail })
        : ({ ok: false, status: 404, json: async () => ({ error: 'DRILL_NOT_FOUND' }) } as unknown as Response);
    }
    if (url.includes('/api/pilot/drill-library')) {
      return jsonResponse({ drills: storedReferenceDrills });
    }
    if (url.includes('/api/pilot/shadow/observation-projection')) {
      return jsonResponse({ items: [] });
    }
    // BASE-05: the athlete's own attempt log reads the canonical ledger.
    if (url.includes('/api/pilot/training-attempts')) {
      return jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/goals')) {
      // Held open so a second click lands while the first request is in flight.
      return new Promise((resolve) => {
        resolveGoalPost = () => resolve(jsonResponse({ ok: true }));
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
});

async function renderWorkspace() {
  render(<AthleteWorkspace />);
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Which of the six groups owns each surface, mirroring TAB_GROUPS in
 * AthleteWorkspace.tsx. Kept as a literal rather than imported so that moving
 * a surface between groups has to be a deliberate edit in both places -- a
 * test that silently follows the component wherever it goes cannot catch a
 * surface being filed somewhere an athlete would not look for it.
 */
const GROUP_FOR_SURFACE: Record<string, string> = {
  Dashboard: 'Today',
  Floor: 'Today',
  Goals: 'Development',
  Attempts: 'Development',
  Drills: 'Learn',
  'Rabbit Holes': 'Learn',
  Schedule: 'Schedule',
  Messages: 'Messages',
  'SHADOW Intel': 'SHADOW',
};

/**
 * Reach a surface through the two-level nav: press its group, then the surface.
 * A group holding one surface draws no second row -- pressing the group has
 * already opened the only thing in it -- so there is nothing further to press.
 */
function openTab(label: string) {
  const group = GROUP_FOR_SURFACE[label];
  if (!group) {
    fireEvent.click(screen.getByRole('button', { name: label }));
    return;
  }

  fireEvent.click(screen.getByRole('button', { name: group }));

  const surface = group === label ? null : screen.queryByRole('button', { name: label });
  if (surface) {
    fireEvent.click(surface);
  }
}

/** A-FIN-01: the one pre-session input the Session Log offers -- optional, and empty until the athlete writes. */
const PRE_CHECK_IN_NOTE = 'Anything your coach should know before you start?';
/** A-FIN-01: what check-in stores when the athlete wrote nothing, solely because pilot.sessions requires a note. */
const NO_NOTE_PLACEHOLDER = 'No athlete note provided at check-in.';
/** The removed defaulted slider's label. Only ever asserted ABSENT, so a control that returns under it fails. */
const REMOVED_SLIDER_LABEL = 'How ready do you feel today? (1-10)';

/**
 * Check in from the Session Log, writing `note` into the pre-check-in box
 * first when one is given, and return the session body check-in POSTed.
 * Leaves the box untouched when `note` is undefined -- the athlete who writes
 * nothing, which is the case the placeholder exists for.
 */
async function checkInFromSessionLog(note?: string): Promise<Record<string, unknown>> {
  const box = await screen.findByLabelText(PRE_CHECK_IN_NOTE);
  if (note !== undefined) {
    fireEvent.change(box, { target: { value: note } });
  }
  const before = postedTo('/api/pilot/sessions').length;
  fireEvent.click(screen.getByRole('button', { name: 'Check In' }));
  await waitFor(() => expect(postedTo('/api/pilot/sessions')).toHaveLength(before + 1));
  return postedTo('/api/pilot/sessions')[before].body;
}

describe('athlete workspace honesty', () => {
  test('the summary row claims no message count while no feed measures one', async () => {
    // "Messages 0" was a hardcoded zero: the athlete's Messages tab is
    // write-only Ask-SHADOW, so no unread count exists to render, and a tile
    // saying 0 told a child nobody had written to them as if that had been
    // measured. The nav group is still allowed to say Messages -- a door is
    // not a measurement -- so the assertion targets stat tiles specifically.
    await renderWorkspace();

    expect(screen.getByText('Open Coach Work')).toBeTruthy();
    // Both label styles the summary row uses (stat tiles wear stat-label,
    // KPI tiles wear t-label), so a tile reintroduced in either dress fails;
    // the nav group's <button> matches neither.
    const messageTiles = screen
      .queryAllByText('Messages')
      .filter((element) => element.classList.contains('stat-label') || element.classList.contains('t-label'));
    expect(messageTiles).toHaveLength(0);
  });

  test('the Next Session tile does not name a class the backend never returned', async () => {
    await renderWorkspace();

    expect(screen.queryByText(/Youth Class 4:00 PM/)).toBeNull();
    // The tile refuses to invent a class. What it says instead is the floor's
    // own honest-empty grammar rather than a field status read out to a child.
    expect(screen.getByText('Nothing posted yet.')).toBeTruthy();
  });

  test('the Schedule tab offers the real scheduler instead of unbookable class rows', async () => {
    await renderWorkspace();
    openTab('Schedule');

    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
    expect(screen.queryByText(/Mon-Thu 4:00 PM Youth Class/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Unified Scheduler' })).toBeTruthy();
  });

  // BASE-05 Slice 1: the athlete's own record, filed under Development beside
  // Goals. Reached through the two-level nav like every other surface, and it
  // reads the canonical training-attempts ledger for the session's athlete.
  test('the Attempts surface sits under Development and reads the athlete\'s own ledger', async () => {
    await renderWorkspace();
    openTab('Attempts');

    await screen.findByText(/No attempts recorded yet/);
    expect(screen.getByRole('button', { name: 'Record attempt' })).toBeTruthy();
    const asked = fetchCalls.find((call) => call.url.includes('/api/pilot/training-attempts'));
    expect(asked?.url).toContain('athlete_id=ath_test');
  });

  test('the Schedule tab no longer apologises for itself over the working link', async () => {
    await renderWorkspace();
    openTab('Schedule');

    // The link was always real; the NOT BUILT wrapper around it is what left.
    expect(screen.queryByText(/this tab cannot see the gym's classes/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Unified Scheduler' })).toBeTruthy();
  });

  test('double-clicking Create Goal posts the goal once', async () => {
    await renderWorkspace();
    openTab('Goals');
    fireEvent.click(screen.getByRole('button', { name: '+ New SMART Goal' }));

    fireEvent.change(screen.getByPlaceholderText('Goal title'), { target: { value: 'Land 100 clean jabs' } });
    fireEvent.change(screen.getByPlaceholderText('Success metric'), { target: { value: '100 reps logged' } });
    // By label, not `input[type="date"]`: the Goals tab now carries two date
    // fields -- this form's required target date, and the optional one on the
    // own-words board above it, where most goals have no date at all. The old
    // selector took whichever came first in the DOM.
    const targetDate = screen.getByLabelText('Goal target date') as HTMLInputElement;
    fireEvent.change(targetDate, { target: { value: '2026-09-01' } });

    const createGoal = screen.getByRole('button', { name: 'Create Goal' });
    fireEvent.click(createGoal);
    fireEvent.click(createGoal);

    await act(async () => {
      resolveGoalPost?.(null);
      await Promise.resolve();
    });

    expect(postedTo('/api/pilot/goals')).toHaveLength(1);
  });

  test('with no backend session, Create Goal says the goal was not saved', async () => {
    authenticated = false;
    await renderWorkspace();
    openTab('Goals');
    fireEvent.click(screen.getByRole('button', { name: '+ New SMART Goal' }));

    fireEvent.change(screen.getByPlaceholderText('Goal title'), { target: { value: 'Land 100 clean jabs' } });
    fireEvent.change(screen.getByPlaceholderText('Success metric'), { target: { value: '100 reps logged' } });
    // By label, not `input[type="date"]`: the Goals tab now carries two date
    // fields -- this form's required target date, and the optional one on the
    // own-words board above it, where most goals have no date at all. The old
    // selector took whichever came first in the DOM.
    const targetDate = screen.getByLabelText('Goal target date') as HTMLInputElement;
    fireEvent.change(targetDate, { target: { value: '2026-09-01' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));

    // Nothing is written anywhere without a session, so the message must not
    // imply the goal survived.
    await waitFor(() => expect(screen.getByText(/That goal did not save/)).toBeTruthy());
    expect(screen.queryByText(/saved locally/i)).toBeNull();
    expect(fetchCalls.some((call) => call.url.endsWith('/api/pilot/goals'))).toBe(false);
  });
});

// Pain reports and session notes are the two things a minor types into this
// workspace that a coach has to receive. Both were being discarded, so these
// cover the payload the server accepts and the message the athlete is left
// with when it does not.
describe('athlete safety reporting', () => {
  /* A-FIN-07 changed what these helpers have to do. This used to be one
     function that opened the modal and pressed Save, because the modal opened
     already holding 'Dull' and 3 -- the defect. Answering is now a separate,
     explicit step, and every test below that files a report says out loud
     which type and which number the athlete chose. */
  async function openPainModal(location = 'Neck') {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('Body location'), { target: { value: location } });
    fireEvent.click(screen.getByRole('button', { name: 'Report Pain' }));
  }

  function answerPain({ type = 'Sharp', severity = 4 }: { type?: string; severity?: number } = {}) {
    fireEvent.change(screen.getByLabelText('Pain Type'), { target: { value: type } });
    fireEvent.click(screen.getByRole('button', { name: `Severity ${severity}` }));
  }

  const painObservations = () => postedTo('/api/pilot/shadow/formulas/observations');

  async function openPainReport(answers?: { type?: string; severity?: number }) {
    await openPainModal();
    answerPain(answers);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  }

  /* A-FIN-07. THE PAIN FORM ANSWERS NOTHING ON THE ATHLETE'S BEHALF.
   *
   * It opened holding 'Dull' and 3, and printed "3/10" over a range input
   * already sitting at 3. A child tapping "Report Pain" on a sore shoulder was
   * shown a completed description of their own body before they had said a
   * word, and Save would file exactly that. It is the same defect A-FIN-01
   * took out of the readiness slider, on the one control whose entire purpose
   * is telling an adult something is wrong.
   *
   * These guards are written against the RENDERED modal rather than the state
   * hook, because the defect was visible before it was storable: the wrong
   * thing was on screen whether or not the athlete pressed anything.
   */
  describe('the pain form starts unanswered', () => {
    test('nothing is chosen, and nothing numeric is shown, when the modal opens', async () => {
      await openPainModal();

      expect((screen.getByLabelText('Pain Type') as HTMLSelectElement).value).toBe('');
      expect(screen.getByRole('option', { name: 'Select a pain type...' })).toBeTruthy();

      // No severity is pressed. aria-pressed is the control's own claim about
      // whether it holds an answer, so it is what gets asserted.
      const severities = screen.getAllByRole('button', { name: /^Severity \d+$/ });
      expect(severities).toHaveLength(10);
      expect(severities.filter((b) => b.getAttribute('aria-pressed') === 'true')).toEqual([]);

      // The specific lie: a number over a control nobody moved.
      expect(screen.queryByText('3/10')).toBeNull();
      expect(screen.queryByText(/\d+\/10/)).toBeNull();

      // A range input cannot express "unanswered" -- it always has a position.
      // Its absence from this modal is the structural half of the fix.
      expect(document.querySelectorAll('input[type="range"]')).toHaveLength(0);

      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/choose a pain type and severity before saving/i)).toBeTruthy();
    });

    test('a type on its own is not a report, and reaches no one', async () => {
      painObservationResponse = jsonResponse({ ok: true, painReport: { coachNotified: true } });
      await openPainModal();
      fireEvent.change(screen.getByLabelText('Pain Type'), { target: { value: 'Sharp' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await Promise.resolve();

      expect(painObservations()).toEqual([]);
      expect(screen.queryByTestId('pain-reported-indicator')).toBeNull();
      expect(screen.queryByText(/last report:/i)).toBeNull();
    });

    test('a severity on its own is not a report, and reaches no one', async () => {
      painObservationResponse = jsonResponse({ ok: true, painReport: { coachNotified: true } });
      await openPainModal();
      fireEvent.click(screen.getByRole('button', { name: 'Severity 4' }));

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await Promise.resolve();

      expect(painObservations()).toEqual([]);
      expect(screen.queryByTestId('pain-reported-indicator')).toBeNull();
      expect(screen.queryByText(/last report:/i)).toBeNull();
    });

    test('what is sent is exactly what the athlete chose, and nothing else', async () => {
      painObservationResponse = jsonResponse({ ok: true, painReport: { coachNotified: true } });
      await openPainReport({ type: 'Sharp', severity: 4 });

      await screen.findByText(/flagged for a coach to look at/);
      const [observation] = painObservations();
      /* The fixture is chosen so the assertion doubles as a negative one:
         4 is not the 3 the severity control used to hold, and Sharp is not
         the Dull the type select used to open on. Pinning the exact pair is
         therefore enough -- a form that supplied its own answers again could
         not satisfy this. */
      expect(observation.body).toEqual(expect.objectContaining({
        kind: 'pain_report',
        unit: 'severity_1_10',
        value: 4,
        dimensions: expect.objectContaining({
          location: 'Neck',
          painType: 'Sharp',
          injuryFlag: true,
        }),
      }));
    });

    test('the next report does not inherit the last one', async () => {
      painObservationResponse = jsonResponse({ ok: true, painReport: { coachNotified: true } });
      await openPainReport({ type: 'Burning', severity: 9 });
      await screen.findByText(/flagged for a coach to look at/);

      // Same athlete, second report. Carrying the first one's answers forward
      // is a quieter version of the same defect: the numbers were genuinely
      // theirs once, which makes the wrong ones harder to notice.
      fireEvent.click(screen.getByRole('button', { name: 'Report Pain' }));

      expect((screen.getByLabelText('Pain Type') as HTMLSelectElement).value).toBe('');
      expect(screen.getAllByRole('button', { name: /^Severity \d+$/ })
        .filter((b) => b.getAttribute('aria-pressed') === 'true')).toEqual([]);
      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    });

    /* FOUND BY MUTATION, and the reason this test exists separately from the
       one above it. Deleting the reset on "Report Pain" left that one GREEN,
       because it reports successfully first and the success path clears the
       answers on its own. The path that actually needs the reset is the one
       where nothing was saved: an athlete picks Sharp and 8, thinks better of
       it, presses Cancel -- and the next person to open this form on a gym
       tablet, or the same athlete about a different body part an hour later,
       finds Sharp and 8 already filled in. */
    test('answers abandoned with Cancel do not come back on the next report', async () => {
      await openPainModal();
      answerPain({ type: 'Sharp', severity: 8 });

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(painObservations()).toEqual([]);

      fireEvent.click(screen.getByRole('button', { name: 'Report Pain' }));

      expect((screen.getByLabelText('Pain Type') as HTMLSelectElement).value).toBe('');
      expect(screen.getAllByRole('button', { name: /^Severity \d+$/ })
        .filter((b) => b.getAttribute('aria-pressed') === 'true')).toEqual([]);
      expect(screen.queryByText('8/10')).toBeNull();
    });
  });

  /* A-FIN-07, second half. A failed pain save used to be invisible.
   *
   * The catch set the message but never closed the modal, and the message
   * rendered in the card BEHIND that modal's `fixed inset-0 ... z-50` overlay.
   * So the athlete pressed Save, the report reached nobody, and the screen did
   * not change. Silence is the worst possible answer here: it is
   * indistinguishable from success to the person who most needs to know.
   */
  describe('a pain report that fails says so where the athlete is looking', () => {
    test('the failure is inside the open modal, and assertive', async () => {
      painObservationResponse = jsonResponse({}, false);
      await openPainReport({ type: 'Sharp', severity: 4 });

      const alert = await screen.findByTestId('pain-modal-alert');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toMatch(/was not saved and no coach was told/i);

      // Still open -- so the alert above is on top of the overlay, not under it.
      expect(screen.getByRole('heading', { name: /soreness details/i })).toBeTruthy();

      // And the answers survive, so the retry is one tap rather than the form again.
      expect((screen.getByLabelText('Pain Type') as HTMLSelectElement).value).toBe('Sharp');
      expect(screen.getByRole('button', { name: 'Severity 4' }).getAttribute('aria-pressed')).toBe('true');

      expect(screen.queryByTestId('pain-reported-indicator')).toBeNull();
      expect(screen.queryByText(/last report:/i)).toBeNull();
      expect(screen.queryByText(/flagged for a coach/i)).toBeNull();
    });

    test('a report the server accepted closes the modal and reports in the card', async () => {
      painObservationResponse = jsonResponse({ ok: true, painReport: { coachNotified: true } });
      await openPainReport({ type: 'Sharp', severity: 4 });

      await screen.findByText(/flagged for a coach to look at/);
      expect(screen.queryByRole('heading', { name: /soreness details/i })).toBeNull();
      // The indicator states something that happened, so it may only appear
      // after the server said it did.
      expect(await screen.findByTestId('pain-reported-indicator')).toBeTruthy();
    });
  });

  test('a pain report is sent with a kind and unit the observations API accepts', async () => {
    painObservationResponse = jsonResponse({ ok: true, painReport: { coachNotified: true, severity: 'high' } });
    await openPainReport();

    await screen.findByText(/flagged for a coach to look at/);
    const [observation] = postedTo('/api/pilot/shadow/formulas/observations');
    expect(OBSERVATION_KINDS).toContain(observation.body.kind);
    expect(FORMULA_UNITS).toContain(observation.body.unit);
    expect(observation.body).toEqual(expect.objectContaining({ kind: 'pain_report', unit: 'severity_1_10' }));
  });

  test('a rejected pain report is never described as saved', async () => {
    painObservationResponse = jsonResponse({}, false);
    await openPainReport();

    await screen.findByText(/was not saved and no coach was told/);
    expect(screen.queryByText(/saved locally/i)).toBeNull();
  });

  test('a rejected pain report lights NO indicator and leaves NO last-report line', async () => {
    painObservationResponse = jsonResponse({}, false);
    await openPainReport();

    await screen.findByText(/was not saved and no coach was told/);
    /* The blocker this pins: the optimistic painLog/injuryFlag writes used to
       precede the fetch and survive its failure, so the card said "Pain
       reported this session. A coach has been told." directly above the
       failure message. Both lines cannot be true, and the reassuring one is
       the one a child believes. */
    expect(screen.queryByTestId('pain-reported-indicator')).toBeNull();
    expect(screen.queryByText(/a coach has been told/i)).toBeNull();
    expect(screen.queryByText(/last report:/i)).toBeNull();
  });

  /* No control on this safety card may record nothing.

     Two tickboxes stood here whose ticked value reached nobody once the
     fabricated check-in `session_rpe` observation -- the only thing that
     carried them -- was removed. The "reviewed today's safety/medical notice"
     box had no consumer at all. The "Injury or Pain Flag" box is the subtler
     one: the flag it set is written for real by the pain report below, so as
     an INDICATOR it tells the truth, but as a CONTROL a hand-tick went
     nowhere. So the affordance is gone and the signal is kept, and these pin
     both halves of that: no tickbox, and the indicator still appearing when a
     pain report is actually filed. */
  test('the Injury or Pain Flag tickbox is gone, because ticking it recorded nothing', async () => {
    await renderWorkspace();

    // The absence that matters is of a CONTROL. A child who ticks a box has
    // every reason to believe a coach will see it.
    expect(screen.queryByRole('checkbox', { name: /injury or pain flag/i })).toBeNull();
    expect(screen.queryByLabelText(/injury or pain flag/i)).toBeNull();
  });

  test('the safety/medical acknowledgement tickbox is gone entirely, because nothing stored it', async () => {
    await renderWorkspace();

    // An attestation nobody stores is not an attestation, and reads as
    // compliance to whoever ticks it. This one had no consumer at all, so
    // unlike the injury flag there is no signal underneath worth keeping.
    expect(screen.queryByRole('checkbox', { name: /safety\/medical notice/i })).toBeNull();
    expect(screen.queryByText(/reviewed today.s safety\/medical notice/i)).toBeNull();
  });

  test('the pain report is left standing, and still carries its injury flag', async () => {
    painObservationResponse = jsonResponse({ ok: true, painReport: { coachNotified: true, severity: 'high' } });
    await openPainReport();

    await screen.findByText(/flagged for a coach to look at/);
    const [observation] = postedTo('/api/pilot/shadow/formulas/observations');
    // The removed tickbox never fed this. `injuryFlag: true` here is a literal
    // on the pain-report payload, which is why that path is unaffected -- and
    // asserting it keeps the removal from quietly taking the real signal too.
    expect(observation.body.dimensions).toEqual(
      expect.objectContaining({ injuryFlag: true, location: 'Neck' }),
    );
  });

  test('a filed pain report leaves a read-only indicator, not something to tick', async () => {
    painObservationResponse = jsonResponse({ ok: true, painReport: { coachNotified: true, severity: 'high' } });
    await openPainReport();

    // Written by the pain report itself, so it states something that happened.
    const indicator = await screen.findByTestId('pain-reported-indicator');
    expect(indicator.textContent).toMatch(/pain reported this session/i);

    // And it is a statement, not an affordance: nothing here invites a tick,
    // which is exactly what the removed tickbox got wrong.
    expect(indicator.tagName).not.toBe('INPUT');
    expect(indicator.querySelector('input, button, select, textarea, [role="checkbox"]')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /pain reported this session/i })).toBeNull();
  });

  test('check-out puts the session notes on the session record', async () => {
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    // A stored check-in sends the athlete to their floor; the session log they
    // check out from is back on the dashboard.
    await waitFor(() => expect(openSurface()).toBe('Floor'));
    openTab('Dashboard');
    const notes = await screen.findByPlaceholderText(/Session notes for your coach/);
    expect(postedTo('/api/pilot/sessions')).toHaveLength(1);

    fireEvent.change(notes, { target: { value: 'my wrist hurts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check Out' }));

    await waitFor(() => expect(postedTo('/api/pilot/sessions/update')).toHaveLength(1));
    const [checkIn] = postedTo('/api/pilot/sessions');
    const [checkOut] = postedTo('/api/pilot/sessions/update');
    expect(checkOut.body).toEqual(expect.objectContaining({
      session_id: checkIn.body.session_id,
      notes: 'my wrist hurts',
      completed_flag: true,
    }));
  });

  // A check-in the app never stored has nothing to check out of, and a
  // check-out button over it collects notes only to discard them at the moment
  // the athlete tries to hand them over.
  test('a check-in that was never stored offers no check-out at all', async () => {
    authenticated = false;
    await renderWorkspace();

    expect(await screen.findByText(/not signed in as an athlete/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check Out' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check In' })).toBeNull();
    expect(screen.queryByPlaceholderText(/Session notes for your coach/)).toBeNull();
  });
});

// The session lived in React state alone, so a reload, a navigation, or the
// shared gym tablet recycling its tab made the Check Out button vanish, left
// the session row open forever, and threw away the notes written for a coach.
// The open session is the server's now, and these cover what that has to buy.
describe('an open session across a reload', () => {
  test('the open session comes back, with the notes already written for the coach', async () => {
    storedSessions = [openSessionRow()];
    await renderWorkspace();

    expect(await screen.findByRole('button', { name: 'Check Out' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check In' })).toBeNull();

    const notes = screen.getByPlaceholderText(/Session notes for your coach/) as HTMLTextAreaElement;
    expect(notes.value).toBe('Left hook felt slow all session, right shoulder tight.');
  });

  test('check-out sends the rehydrated record in the shapes the session validator accepts', async () => {
    storedSessions = [openSessionRow()];
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check Out' }));

    await waitFor(() => expect(postedTo('/api/pilot/sessions/update')).toHaveLength(1));
    const [checkOut] = postedTo('/api/pilot/sessions/update');
    expect(checkOut.body).toEqual(expect.objectContaining({
      session_id: 'session_1754000000000',
      completed_flag: true,
      date: '2026-08-01',
      created_at: '2026-08-01T17:05:00.000Z',
      notes: 'Left hook felt slow all session, right shoulder tight.',
    }));
  });

  // CHANGED DELIBERATELY. This assertion used to read `rpe: 8` -- check-out
  // handed back whatever was in the column, and what was in the column was the
  // pre-session readiness slider check-in had put there. Completing the session
  // therefore stamped a "how ready did I feel beforehand" number onto the field
  // that means "how hard was that session", which is the defect
  // pilot_slice_postgres_session_rpe_semantics_migration.sql exists to end.
  //
  // Session RPE is now collected at check-out or not at all. Nothing in this
  // app collects it yet, so the honest write is null with an UNKNOWN method --
  // and the stored 8 must not be promoted into it on the way past.
  test('check-out does not turn the stored readiness reading into a session RPE', async () => {
    storedSessions = [openSessionRow()];
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check Out' }));

    await waitFor(() => expect(postedTo('/api/pilot/sessions/update')).toHaveLength(1));
    const [checkOut] = postedTo('/api/pilot/sessions/update');
    expect(checkOut.body.rpe).toBeNull();
    expect(checkOut.body.rpe).not.toBe(8);
    expect(checkOut.body.rpe_method).toBe('UNKNOWN');
  });

  // The check-in placeholder is stored because pilot.sessions requires a
  // non-empty note. Handing it back into the athlete's own box would present a
  // sentence the app wrote as one they wrote.
  //
  // WIDENED IN A-FIN-01, not replaced. It covered 'Auto check-in readiness
  // GREEN' alone; check-in no longer writes that form, but rows carrying all
  // three bands still exist and are deliberately not rewritten, so every band
  // stays suppressed -- and the new placeholder is suppressed the same way.
  test.each([
    'Auto check-in readiness GREEN',
    'Auto check-in readiness YELLOW',
    'Auto check-in readiness RED',
    NO_NOTE_PLACEHOLDER,
  ])('the system check-in note "%s" is not returned as the athlete own notes', async (stored) => {
    storedSessions = [openSessionRow({ notes: stored })];
    await renderWorkspace();

    await screen.findByRole('button', { name: 'Check Out' });
    expect((screen.getByPlaceholderText(/Session notes for your coach/) as HTMLTextAreaElement).value).toBe('');
    // Nor anywhere else on the open session: the system's sentence is not
    // on screen at all.
    expect(screen.queryByText(stored)).toBeNull();
    expect(screen.getByText('Anything you write here saves as you go.')).toBeTruthy();
  });

  // The suppression must not over-reach: a note that merely mentions the
  // words is the athlete's own and comes back like any other.
  test('a real note that only resembles a system note is still the athlete own', async () => {
    storedSessions = [openSessionRow({ notes: 'Auto check-in readiness GREEN -- actually my knee hurts' })];
    await renderWorkspace();

    await screen.findByRole('button', { name: 'Check Out' });
    expect((screen.getByPlaceholderText(/Session notes for your coach/) as HTMLTextAreaElement).value)
      .toBe('Auto check-in readiness GREEN -- actually my knee hurts');
  });

  test('notes reach the session record before any check-out happens', async () => {
    storedSessions = [openSessionRow({ notes: 'Auto check-in readiness GREEN' })];
    await renderWorkspace();

    const notes = await screen.findByPlaceholderText(/Session notes for your coach/);
    fireEvent.change(notes, { target: { value: 'Head is ringing a bit after the last round.' } });

    await waitFor(() => expect(postedTo('/api/pilot/sessions/update')).toHaveLength(1), { timeout: 5000 });
    const [draftSave] = postedTo('/api/pilot/sessions/update');
    expect(draftSave.body).toEqual(expect.objectContaining({
      notes: 'Head is ringing a bit after the last round.',
      // Still open: this is a draft save, not an early check-out.
      completed_flag: false,
    }));
    expect(await screen.findByText(/What you wrote stays put/)).toBeTruthy();
  });

  test('a failed check-out leaves the session open and the notes on screen', async () => {
    storedSessions = [openSessionRow()];
    sessionUpdateFails = true;
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check Out' }));

    expect(await screen.findByText(/still checked in/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check Out' })).toBeTruthy();
    expect((screen.getByPlaceholderText(/Session notes for your coach/) as HTMLTextAreaElement).value)
      .toBe('Left hook felt slow all session, right shoulder tight.');
  });

  test('with no open session the screen says so and offers a check-in, not a check-out', async () => {
    await renderWorkspace();

    expect(await screen.findByText(/You are not checked in right now/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check Out' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check In' })).toBeTruthy();
  });

  // "No open session" and "could not ask" have different answers, and telling
  // an athlete they are checked out when nobody knows is what leaves a session
  // row open forever.
  test('a session read that failed is reported as a failure, not as an empty history', async () => {
    sessionListFails = true;
    await renderWorkspace();

    expect(await screen.findByText(/Your sessions could not be read/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check Out' })).toBeNull();
    expect(screen.queryByText(/You are not checked in right now/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });
});

// Authored notices and motivational copy are data, so the workspace has to ask
// for its own surface and has to survive the answer -- including no answer at
// all.
describe('authored announcements on the athlete workspace', () => {
  test('the workspace asks for its own placement, for both kinds', async () => {
    await renderWorkspace();

    const asked = postedTo('/api/pilot/announcements/get').map((call) => call.body);
    expect(asked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ placement: 'athlete_workspace', kind: 'notice' }),
        expect.objectContaining({ placement: 'athlete_workspace', kind: 'motivation' }),
      ]),
    );
  });

  /* CHANGED DELIBERATELY (Phase 4, community surfaces).
     The 'motivation' kind used to render as a paper card headed "From the Gym".
     It renders on the chalkboard now -- same table, same placement, same kind,
     different object (see Chalkboard.tsx). So the heading is gone on purpose
     and the assertions below moved onto the board, which is a stronger check:
     the previous ones would have passed on a heading with nothing under it. */
  test('live motivational copy is drawn where the athlete will see it', async () => {
    liveAnnouncements = [announcement()];
    const { container } = render(<AthleteWorkspace />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(await screen.findByText('Hands up, chin down.')).toBeTruthy();
    expect(container.querySelector('.chalkboard')?.getAttribute('data-state')).toBe('written');
    // The paper card it replaced is gone, not sitting beside it.
    expect(screen.queryByText('From the Gym')).toBeNull();
  });

  test('an item placed elsewhere is not drawn here', async () => {
    liveAnnouncements = [announcement({ placement: 'coach_workspace', message: 'Coaches only.' })];
    const { container } = render(<AthleteWorkspace />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText('Coaches only.')).toBeNull();
    expect(container.querySelector('.chalkboard')?.getAttribute('data-state')).toBe('blank');
  });

  test('nothing live leaves no heading and no empty box behind', async () => {
    await renderWorkspace();

    expect(screen.queryByText('From the Gym')).toBeNull();
    expect(screen.queryByText('Gym Notices')).toBeNull();
    // The board is still hanging there, unwritten. A chalkboard with nothing on
    // it is an object, not an empty box -- unlike the notice banner above,
    // which correctly renders nothing at all when nothing is live.
    expect(screen.getByText('Nothing on the board.')).toBeTruthy();
  });

  test('a failed announcements read leaves the rest of the workspace working', async () => {
    announcementsFail = true;
    await renderWorkspace();

    expect(screen.queryByText('From the Gym')).toBeNull();
    // A board that could not be read is a blank board, and says nothing about
    // its own plumbing on top of the page's real work.
    expect(screen.getByText('Nothing on the board.')).toBeTruthy();
    // Anchored on the Session Log's pre-check-in note since A-FIN-01. It was
    // the "Pre-Session Self-Report" card, which went with its defaulted slider.
    expect(await screen.findByLabelText(PRE_CHECK_IN_NOTE)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Check In' })).toBeTruthy();
  });
});

// The tab held one lesson written into the component, addressed to one role and
// unretirable without a deploy. It now reads what coaches published, which
// means the two claims it can get wrong are "the gym has written nothing" (a
// statement about the coaches, not the network) and the authority the teaching
// speaks with.
describe('the rabbit holes tab', () => {
  const LESSON: RabbitHoleLessonItem = {
    rabbit_hole_id: 'rh-1',
    title: 'Biomechanics of Kinetic Force Transfer',
    concept:
      'Power does not generate in the shoulders. Force begins with rear-foot ground rotation through hip rotation into target through clean wrist extension.',
    homework:
      'Complete 30 slow shadowboxing crosses, holding full extension for 3 seconds to confirm your rear foot heel is rotated fully outward.',
    author_display_name: 'Coach Jason',
    citation: null,
  };

  async function openRabbitHoles() {
    await renderWorkspace();
    // Opening a surface is now two presses -- the group, then the surface --
    // and the second one can only find its button after the first has
    // rendered. Nested inside an outer act() the group press would not have
    // flushed yet, so the presses happen here and the act() that follows only
    // settles the effects they kick off.
    openTab('Rabbit Holes');
    await act(async () => {
      await Promise.resolve();
    });
  }

  test('the tab asks the authored source for the development terms it covers', async () => {
    await openRabbitHoles();

    const asked = postedTo('/api/pilot/rabbit-holes/get').map(
      (call) => `${String(call.body.anchor_type)}:${String(call.body.anchor_key)}`,
    );
    expect(asked).toContain('gap_type:technique');
    expect(asked).toContain('gap_type:tactical');
    expect(asked).toContain('severity:critical');
  });

  test('a published lesson renders under its topic with concept, homework and author', async () => {
    rabbitHolesByAnchor = { 'gap_type:technique': [LESSON] };
    await openRabbitHoles();

    expect(await screen.findByText('Biomechanics of Kinetic Force Transfer')).toBeTruthy();
    expect(screen.getByText(/Power does not generate in the shoulders/)).toBeTruthy();
    expect(screen.getByText(/30 slow shadowboxing crosses/)).toBeTruthy();
    expect(screen.getByText(/Written by Coach Jason/)).toBeTruthy();
    // The topic is named in the words the rest of the app uses, not as the slug
    // the lesson is stored against.
    expect(screen.getByText('Progression gap type: Technique')).toBeTruthy();
  });

  test('the tab says whose coaching this is and borrows no evidence tier', async () => {
    rabbitHolesByAnchor = { 'gap_type:technique': [LESSON] };
    await openRabbitHoles();
    await screen.findByText('Biomechanics of Kinetic Force Transfer');

    expect(screen.getByText(/is not research and it is not SHADOW evidence/)).toBeTruthy();
    for (const tier of ['PROVEN', 'EMERGING', 'EXPERIMENTAL', 'RESEARCH_NEEDED']) {
      expect(screen.queryByText(tier)).toBeNull();
    }
  });

  test('a topic with no lesson leaves no heading and no empty card behind', async () => {
    rabbitHolesByAnchor = { 'gap_type:technique': [LESSON] };
    await openRabbitHoles();
    await screen.findByText('Biomechanics of Kinetic Force Transfer');

    expect(screen.queryByText('Progression gap type: Strength')).toBeNull();
    expect(screen.queryByText('Gap severity: Critical')).toBeNull();
  });

  test('an empty library reports the coaches, and the lesson is no longer hardcoded', async () => {
    await openRabbitHoles();

    expect(await screen.findByText(/have not published a rabbit hole yet/)).toBeTruthy();
    expect(screen.queryByText('Biomechanics of Kinetic Force Transfer')).toBeNull();
  });

  test('a failed read is never presented as an empty library', async () => {
    rabbitHolesFail = true;
    await openRabbitHoles();

    expect(await screen.findByText(/could not be loaded right now/)).toBeTruthy();
    expect(screen.queryByText(/have not published a rabbit hole yet/)).toBeNull();
  });
});

// Goal category and progress were read off every row this screen displayed and
// stored in no column, so the component supplied both: `item.category ||
// 'Boxing'` and `item.progress_percent || 0`. Every goal in the gym therefore
// rendered as an untouched boxing goal, above a progress bar drawn from the
// zero. The columns landed on 2026-08-03; these tests are the guard against the
// substitutions coming back, in either direction.
function storedGoal(overrides: Record<string, unknown> = {}) {
  return {
    goal_id: 'goal_1',
    athlete_id: 'ath_test',
    title: 'Land 100 clean jabs',
    target_date: '2026-09-01',
    metric: '100 reps logged',
    status: 'active',
    category: null,
    progress_percent: null,
    created_at: '2026-08-01T17:05:00.000Z',
    updated_at: '2026-08-01T17:05:00.000Z',
    ...overrides,
  };
}

async function openGoals() {
  await renderWorkspace();
  openTab('Goals');
  await act(async () => {
    await Promise.resolve();
  });
}

describe('goal category and progress say only what the row says', () => {
  test('a goal with no stored category is not presented as a Boxing goal', async () => {
    storedGoals = [storedGoal()];
    await openGoals();

    expect(await screen.findByText('No category')).toBeTruthy();
    expect(screen.queryByText('Boxing')).toBeNull();
  });

  // Asserted through the value element rather than by text, because the
  // reporting control's own options are the strings '0%' through '100%' and
  // 'Not reported yet' -- a bare getByText would match the control that sets
  // the value as readily as the readout that shows it.
  test('a goal with no stored progress reads as unreported and draws no bar', async () => {
    storedGoals = [storedGoal()];
    await openGoals();

    expect((await screen.findByTestId('goal-progress-value-goal_1')).textContent).toContain('Not reported yet');
    expect(screen.queryByTestId('goal-progress-bar-goal_1')).toBeNull();
  });

  // The other half of the same rule. A real report of 0 is a statement the
  // athlete made, and it has to look different from never having been asked.
  test('a reported 0% is shown as 0% with a bar, not as unreported', async () => {
    storedGoals = [storedGoal({ progress_percent: 0 })];
    await openGoals();

    expect((await screen.findByTestId('goal-progress-value-goal_1')).textContent).toContain('0%');
    expect((await screen.findByTestId('goal-progress-value-goal_1')).textContent).not.toContain('Not reported yet');
    expect(screen.getByTestId('goal-progress-bar-goal_1')).toBeTruthy();
  });

  test('a stored category and percentage are shown as stored', async () => {
    storedGoals = [storedGoal({ category: 'Academics', progress_percent: 40 })];
    await openGoals();

    expect(await screen.findByText('Academics')).toBeTruthy();
    expect((await screen.findByTestId('goal-progress-value-goal_1')).textContent).toContain('40%');
  });
});

describe('the category the athlete picks is the category that is sent', () => {
  test('creating a goal posts the chosen category', async () => {
    await openGoals();
    fireEvent.click(screen.getByRole('button', { name: '+ New SMART Goal' }));

    fireEvent.change(screen.getByPlaceholderText('Goal title'), { target: { value: 'Read a chapter a night' } });
    fireEvent.change(screen.getByPlaceholderText('Success metric'), { target: { value: 'chapters logged' } });
    // By label, not `input[type="date"]` -- the Goals tab carries two date
    // fields and the bare selector takes whichever comes first in the DOM.
    fireEvent.change(screen.getByLabelText('Goal target date'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('Goal category'), { target: { value: 'Academics' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));
    await act(async () => {
      resolveGoalPost?.(null);
      await Promise.resolve();
    });

    const [created] = postedTo('/api/pilot/goals');
    expect(created.body.category).toBe('Academics');
    // Not 0. A goal created a second ago has no progress report, and 0 would be
    // a report saying no progress has been made.
    expect(created.body.progress_percent).toBeUndefined();
  });

  test('the form offers exactly the categories the API accepts', () => {
    expect([...SMART_GOAL_CATEGORIES]).toEqual([...GOAL_CATEGORIES]);
  });

  // Withheld until 2026-08-28, then admitted by owner decision. This case used
  // to assert the option was absent and the guidance present; it now asserts
  // the option is present AND the guidance still appears when it is chosen.
  // The guidance surviving the decision is the point: the 2026-08-03 owner
  // principle is that the stop carries the lesson, and admitting the category
  // removed the stop, not the lesson.
  test.each(['Weight Loss', 'Weight Gain'])('%s is offered, and choosing it still points at the coach', async (category) => {
    await openGoals();
    fireEvent.click(screen.getByRole('button', { name: '+ New SMART Goal' }));

    const select = screen.getByLabelText('Goal category') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toContain(category);

    // Not shown for an ordinary goal -- unconditional, it would be noise on a
    // jab goal.
    expect(screen.queryByText(/plan you build with your coach/)).toBeNull();

    fireEvent.change(select, { target: { value: category } });
    expect(screen.getByText(/plan you build with your coach/)).toBeTruthy();
  });
});

describe('reporting progress writes it', () => {
  test('choosing a percentage posts the whole goal with the new value', async () => {
    storedGoals = [storedGoal({ category: 'Recovery' })];
    await openGoals();

    fireEvent.change(await screen.findByLabelText('Report progress for Land 100 clean jabs'), {
      target: { value: '60' },
    });
    await act(async () => {
      await Promise.resolve();
    });

    const [update] = postedTo('/api/pilot/goals/update');
    expect(update.body.progress_percent).toBe(60);
    // The route writes the record it is handed, so everything else has to make
    // the round trip untouched or the report silently clears it.
    expect(update.body).toMatchObject({
      goal_id: 'goal_1',
      title: 'Land 100 clean jabs',
      metric: '100 reps logged',
      category: 'Recovery',
      status: 'active',
      created_at: '2026-08-01T17:05:00.000Z',
    });
  });

  test('clearing the report sends null rather than 0', async () => {
    storedGoals = [storedGoal({ progress_percent: 60 })];
    await openGoals();

    fireEvent.change(await screen.findByLabelText('Report progress for Land 100 clean jabs'), {
      target: { value: '' },
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(postedTo('/api/pilot/goals/update')[0].body.progress_percent).toBeNull();
  });

  test('a failed write puts the previous value back rather than leaving the new one on screen', async () => {
    goalUpdateFails = true;
    storedGoals = [storedGoal({ progress_percent: 20 })];
    await openGoals();

    fireEvent.change(await screen.findByLabelText('Report progress for Land 100 clean jabs'), {
      target: { value: '90' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('goal-progress-value-goal_1').textContent).toContain('20%');
    });
    expect(screen.getByTestId('goal-progress-value-goal_1').textContent).not.toContain('90%');
  });
});

describe('the workspace nav groups its surfaces instead of listing them flat', () => {
  test('six groups are offered, and a surface inside one is not loose in the top row', async () => {
    await renderWorkspace();

    for (const group of ['Today', 'Development', 'Learn', 'Schedule', 'Messages', 'SHADOW']) {
      expect(screen.getByRole('button', { name: group })).toBeTruthy();
    }

    // Goals belongs to Development. Until that group is open there is no Goals
    // button at all -- that is the difference between grouping the nav and
    // merely captioning it.
    expect(screen.queryByRole('button', { name: 'Goals' })).toBeNull();
  });

  test('a surface is reachable through the group that owns it', async () => {
    await renderWorkspace();

    openTab('Goals');

    expect(screen.getByRole('button', { name: '+ New SMART Goal' })).toBeTruthy();
  });

  test('Today reports an un-checked-in athlete as not checked in', async () => {
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));

    expect(screen.getByText('Not checked in yet')).toBeTruthy();
  });

  test('once the check-in is recorded Today stops saying it is missing', async () => {
    storedSessions = [openSessionRow()];
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));

    await waitFor(() => {
      expect(screen.queryByText('Not checked in yet')).toBeNull();
    });
  });

  test('every group stays reachable without checking in first', async () => {
    // The gateway is an opening position, never a lock. An athlete who has not
    // checked in can still reach their own record, their schedule, and every
    // other group -- gating a minor's access to their own data behind a daily
    // action would be compulsion, which the engagement direction forbids.
    await renderWorkspace();

    openTab('Goals');
    expect(screen.getByRole('button', { name: '+ New SMART Goal' })).toBeTruthy();

    openTab('Rabbit Holes');
    expect(screen.getByRole('button', { name: 'Learn' })).toBeTruthy();
  });
});

describe('Today states the day back rather than offering a row of buttons', () => {
  test('an athlete who has not checked in is told so, and offered the one action', async () => {
    await renderWorkspace();

    expect(screen.getByText('You have not checked in today.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start check-in' })).toBeTruthy();
  });

  test('Today offers no generated floor plan, because nothing generates one', async () => {
    // A-FIN-04. The "Your floor plan" card promised work "built for you when
    // you check in" -- the same three items for everyone, stored as if they
    // were somebody's plan. The Floor is the coach's work now, and Today
    // reaches it through the coach card below.
    await renderWorkspace();

    expect(screen.queryByText('Your floor plan')).toBeNull();
    expect(screen.queryByText('Built for you when you check in.')).toBeNull();
  });

  test('no recorded goals reads as none recorded, not as zero', async () => {
    storedGoals = [];
    await renderWorkspace();

    expect(await screen.findByText('No active goals recorded.')).toBeTruthy();
  });

  test('Start check-in performs the check-in instead of only navigating to it', async () => {
    // The Bio Check-In tab's fields are local state and persist nothing -- no
    // caller of /api/pilot/athlete/check-in exists in this app -- so a Today
    // action that merely navigated there would leave the athlete believing
    // they had checked in when no record was written. It calls the real
    // handler, the same one the Session Log's button calls.
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Start check-in' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(postedTo('/api/pilot/sessions').length).toBeGreaterThan(0);
  });

  test('a checked-in athlete is told when, and is not asked to check in again', async () => {
    storedSessions = [openSessionRow()];
    await renderWorkspace();

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Start check-in' })).toBeNull();
    });
    expect(screen.queryByText('You have not checked in today.')).toBeNull();
  });
});

describe('shipped features are not described to the athlete as unbuilt', () => {
  test('the film lane and progression are offered as working, not as coming', async () => {
    // Both pages read real routes -- /api/pilot/video/list and
    // /api/pilot/progression/gaps -- and were being advertised as "Not Built
    // Yet", one of them as "Nothing behind them works yet".
    await renderWorkspace();

    expect(screen.queryByText(/Video Analysis - Not Built Yet/)).toBeNull();
    expect(screen.queryByText(/Automatic Progress Tracking - Not Built Yet/)).toBeNull();
    expect(screen.queryByText(/Nothing behind them works yet/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Your Film' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Your Progression' })).toBeTruthy();
  });

  test('the sparring log is reachable from the workspace, not only by typing the URL', async () => {
    // /athlete/dashboard/sparring had a real, tested, API-backed form and no
    // link to it anywhere in the app -- only buildingMap.ts's site search
    // knew it existed. This pins the fix, not just that a link renders: the
    // href has to be the real route.
    await renderWorkspace();

    const link = screen.getByRole('link', { name: 'Open Sparring Log' });
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/athlete/dashboard/sparring');
  });

  test('the part that genuinely is not built is still said plainly', async () => {
    // Automatic technique scoring is PARKED by owner decision. Correcting the
    // stale copy must not quietly promise it.
    await renderWorkspace();

    expect(screen.getByText(/Nothing scores your technique automatically -- that part is not built/)).toBeTruthy();
  });
});

describe('the athlete question box does not imply a coach reads it', () => {
  test('it is named for what answers it, and offers no coach to pick', async () => {
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));

    expect(screen.getByRole('heading', { name: 'Ask SHADOW' })).toBeTruthy();
    // The picker offered two hardcoded names and changed nothing about where
    // the message went.
    expect(screen.queryByLabelText('Coach')).toBeNull();
    expect(screen.queryByText(/Coach Jason \(Head Coach\)/)).toBeNull();
    expect(screen.queryByText(/Coach Danielle/)).toBeNull();
  });

  test('the SafeSport warning still states that no parent is copied', async () => {
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));

    expect(screen.getByText(/your parent is not automatically copied and no coach is notified/)).toBeTruthy();
  });
});

// The drills a coach assigned lived at /athlete/progression-intelligence,
// reachable from this workspace only through a collapsed <details> at the foot
// of the page. Today carries the count, and its door opens the Floor, which
// lists that work (A-FIN-04).
describe('Today shows the work a coach assigned', () => {
  test('open assignments are counted for the athlete the session names, and the card opens the floor', async () => {
    storedAssignments = [
      assignment({ assignment_id: 'as-1', status: 'assigned' }),
      assignment({ assignment_id: 'as-2', status: 'in_progress', drill_display_name: 'Slip drill' }),
      // Finished work is record, not today.
      assignment({ assignment_id: 'as-3', status: 'completed', drill_display_name: 'Old work' }),
    ];
    await renderWorkspace();

    expect(await screen.findByText('2 still to do.')).toBeTruthy();
    const asked = fetchCalls.find((call) => call.url.includes('/api/pilot/progression/assignments'));
    expect(asked?.url).toContain('athlete_id=ath_test');

    fireEvent.click(screen.getByRole('button', { name: 'Open the floor' }));
    expect(openSurface()).toBe('Floor');
    expect(screen.getByRole('heading', { level: 4, name: 'Slip drill' })).toBeTruthy();
  });

  test('no assignments reads as none recorded, not as zero', async () => {
    await renderWorkspace();

    expect(await screen.findByText('No assigned work recorded.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the floor' })).toBeTruthy();
  });

  test('a failed read is reported as unavailable, never as no work assigned', async () => {
    assignmentsFail = true;
    await renderWorkspace();

    expect(await screen.findByText('Not available right now.')).toBeTruthy();
    expect(screen.queryByText('No assigned work recorded.')).toBeNull();
  });
});

// A-FIN-04: THE FLOOR IS THE WORK A COACH ASSIGNED. It used to be a plan this
// component generated at check-in -- 'Dynamic Warmup + Mobility', 'Technical
// Boxing Block', 'Cooldown + Session Journal', identical for every athlete --
// POSTed to /api/pilot/floor-plans and shown as the day's work. These pin the
// replacement: the coach's open rows, in the API's order, with the coach's
// dose or none; honest empty and failure states; links to the Progression
// page's own controls rather than copies of them; and nothing generated.
describe('the Floor is the work a coach assigned', () => {
  test('only open work is shown, in the order the API returned it', async () => {
    storedAssignments = [
      assignment({ assignment_id: 'as-2', status: 'in_progress', drill_display_name: 'Slip drill' }),
      assignment({ assignment_id: 'as-9', status: 'completed', drill_display_name: 'Finished work' }),
      assignment({ assignment_id: 'as-1', status: 'assigned', drill_display_name: 'Jab-cross on the bag' }),
      assignment({ assignment_id: 'as-7', status: 'cancelled', drill_display_name: 'Cancelled work' }),
      assignment({ assignment_id: 'as-8', status: 'incomplete', drill_display_name: 'Lapsed work' }),
    ];
    await renderWorkspace();
    openTab('Floor');

    await screen.findByRole('heading', { level: 4, name: 'Slip drill' });
    const titles = floorWorkTitles();
    // Not re-ranked: in_progress came first from the API, so it stays first.
    expect(titles).toEqual(['Slip drill', 'Jab-cross on the bag']);
    expect(screen.getByText('in progress')).toBeTruthy();
    expect(screen.getByText('assigned')).toBeTruthy();
  });

  test('the dose and due date are the coach\'s, and an unset one is left out rather than filled', async () => {
    storedAssignments = [
      assignment({
        assignment_id: 'as-1',
        drill_display_name: 'Jab-cross on the bag',
        rep_count: 30,
        duration_minutes: 12,
        frequency_per_week: 3,
        due_date: '2026-09-25',
      }),
      assignment({ assignment_id: 'as-2', drill_display_name: 'Slip drill' }),
    ];
    await renderWorkspace();
    openTab('Floor');

    const dosed = (await screen.findByRole('heading', { level: 4, name: 'Jab-cross on the bag' })).closest('div.mat-leather--raised') as HTMLElement;
    expect(within(dosed).getByText('30')).toBeTruthy();
    expect(within(dosed).getByText('12 min')).toBeTruthy();
    expect(within(dosed).getByText('3x/week')).toBeTruthy();
    expect(within(dosed).getByText('Due')).toBeTruthy();

    const bare = screen.getByRole('heading', { level: 4, name: 'Slip drill' }).closest('div.mat-leather--raised') as HTMLElement;
    for (const label of ['Reps', 'Duration', 'Frequency', 'Due']) {
      expect(within(bare).queryByText(label)).toBeNull();
    }
  });

  test('each card links to the Progression page\'s own opener and log form, carrying no copy of either', async () => {
    storedAssignments = [
      assignment({ assignment_id: 'as-1', drill_display_name: 'Jab-cross on the bag' }),
      // No drill behind it: nothing to open, but the work can still be logged.
      assignment({ assignment_id: 'as 2', drill_id: null, drill_display_name: 'Coach note work' }),
    ];
    await renderWorkspace();
    openTab('Floor');

    const open = await screen.findByRole('link', { name: 'Open drill: Jab-cross on the bag' });
    expect(open.getAttribute('href')).toBe('/athlete/progression-intelligence?assignment=as-1&intent=instruction');
    expect(screen.getByRole('link', { name: 'Log completion: Jab-cross on the bag' }).getAttribute('href'))
      .toBe('/athlete/progression-intelligence?assignment=as-1&intent=log');

    expect(screen.queryByRole('link', { name: 'Open drill: Coach note work' })).toBeNull();
    // The id is encoded, so it cannot smuggle a second parameter into the link.
    expect(screen.getByRole('link', { name: 'Log completion: Coach note work' }).getAttribute('href'))
      .toBe('/athlete/progression-intelligence?assignment=as%202&intent=log');

    // The Floor holds no log form and no completion control of its own.
    expect(screen.queryByRole('button', { name: 'Save log' })).toBeNull();
    expect(screen.queryByLabelText(/Reps completed/)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  test('no open work says so, and offers no check-in that would pretend to build some', async () => {
    storedAssignments = [assignment({ status: 'completed' })];
    await renderWorkspace();
    openTab('Floor');

    expect(await screen.findByText('No open work from your coach.')).toBeTruthy();
    expect(screen.queryByText(/Nothing on your floor yet/)).toBeNull();
    expect(screen.queryByText(/work gets built/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check In' })).toBeNull();
    // The history lives one link away.
    expect(screen.getByRole('link', { name: 'Open your progression' }).getAttribute('href'))
      .toBe('/athlete/progression-intelligence');
  });

  test('a failed read is reported, never drawn as an empty floor, and can be retried', async () => {
    assignmentsFail = true;
    await renderWorkspace();
    openTab('Floor');

    expect(await screen.findByText("Could not load your coach's work")).toBeTruthy();
    expect(screen.queryByText('No open work from your coach.')).toBeNull();

    assignmentsFail = false;
    storedAssignments = [assignment({ drill_display_name: 'Jab-cross on the bag' })];
    fireEvent.click(screen.getByRole('button', { name: "Retry loading your coach's work" }));
    expect(await screen.findByRole('heading', { level: 4, name: 'Jab-cross on the bag' })).toBeTruthy();
  });

  test('an account with no athlete record is told so, not left loading forever', async () => {
    // The read is never made without an athlete id, so "Loading your coach's
    // work..." would describe a request that is never going to happen.
    authenticated = false;
    await renderWorkspace();
    openTab('Floor');

    expect(await screen.findByText(/not linked to an athlete record, so there is no coach's work to show/)).toBeTruthy();
    expect(screen.queryByText(/Loading your coach's work/)).toBeNull();
    expect(screen.queryByText('No open work from your coach.')).toBeNull();
    expect(fetchCalls.some((call) => call.url.includes('/api/pilot/progression/assignments'))).toBe(false);
  });

  test('check-in generates nothing: no plan is read or written, and no synthetic work appears', async () => {
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    await waitFor(() => expect(openSurface()).toBe('Floor'));

    expect(postedTo('/api/pilot/sessions')).toHaveLength(1);
    expect(floorPlanCalls()).toHaveLength(0);
    for (const generated of ['Dynamic Warmup + Mobility', 'Technical Boxing Block', 'Cooldown + Session Journal']) {
      expect(screen.queryByText(generated)).toBeNull();
    }
    expect(screen.getByText('No open work from your coach.')).toBeTruthy();
  });
});

// The summary tile used to say "Tasks Due" over a bare number. Two claims no
// source supported: nothing reads a due date (the Floor shows every open row,
// deliberately, with no "due" window), and a read still in flight or one that
// failed rendered as 0 -- "your coach set you nothing", said about a request
// that had not answered. Only a successful read may show a number.
describe('the summary tile counts open coach work, and only a read that answered shows a number', () => {
  function summaryTile(): HTMLElement {
    return screen.getByText('Open Coach Work').parentElement as HTMLElement;
  }

  test('a successful read with nothing open shows a real 0', async () => {
    storedAssignments = [assignment({ status: 'completed' })];
    await renderWorkspace();

    await waitFor(() => expect(within(summaryTile()).getByText('0')).toBeTruthy());
  });

  test('a successful read shows the open count -- open rows only', async () => {
    storedAssignments = [
      assignment({ assignment_id: 'as-1', status: 'assigned' }),
      assignment({ assignment_id: 'as-2', status: 'in_progress' }),
      assignment({ assignment_id: 'as-3', status: 'completed' }),
      assignment({ assignment_id: 'as-4', status: 'cancelled' }),
    ];
    await renderWorkspace();

    await waitFor(() => expect(within(summaryTile()).getByText('2')).toBeTruthy());
  });

  test('a read still in flight says so, and is not 0', async () => {
    assignmentsPending = true;
    await renderWorkspace();

    expect(within(summaryTile()).getByText('Checking...')).toBeTruthy();
    expect(within(summaryTile()).queryByText('0')).toBeNull();
  });

  test('a failed read says unavailable, and is not 0', async () => {
    assignmentsFail = true;
    await renderWorkspace();

    await waitFor(() => expect(within(summaryTile()).getByText('Unavailable')).toBeTruthy());
    expect(within(summaryTile()).queryByText('0')).toBeNull();
  });

  test('an account with no athlete record is unavailable, not 0', async () => {
    authenticated = false;
    await renderWorkspace();

    await waitFor(() => expect(within(summaryTile()).getByText('Unavailable')).toBeTruthy());
    expect(within(summaryTile()).queryByText('0')).toBeNull();
  });

  test('nothing on the summary claims work is due', async () => {
    storedAssignments = [assignment({ due_date: '2026-09-25' })];
    await renderWorkspace();

    await waitFor(() => expect(within(summaryTile()).getByText('1')).toBeTruthy());
    expect(screen.queryByText('Tasks Due')).toBeNull();
    expect(screen.queryByText(/tasks due/i)).toBeNull();
  });
});

// Where a check-in takes the athlete. It used to jump to the Floor before the
// session was even sent -- so a refused check-in left the athlete on a floor,
// and one made before the day's wellness check landed them on a locked one.
describe('a session check-in goes where the day actually is', () => {
  test('stored, with wellness recorded: straight to the floor', async () => {
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));

    await waitFor(() => expect(openSurface()).toBe('Floor'));
    expect(screen.getByText("You are checked in. Your coach's work is on your floor.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Go to check in' })).toBeNull();
  });

  test('stored, with no wellness check yet: to Wellness, which is what opens the floor', async () => {
    storedCheckIn = null;
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));

    await waitFor(() => expect(openSurface()).toBe('Wellness'));
    expect(screen.getByText('You are checked in. Do your wellness check next -- it opens your floor.')).toBeTruthy();
  });

  test('refused: the athlete stays where they pressed it, and is told nothing was saved', async () => {
    sessionCreateFails = true;
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));

    expect(await screen.findByText(/Nothing was saved, so there is no session to check out of/)).toBeTruthy();
    expect(openSurface()).toBe('Dashboard');
  });
});

// Three surfaces carried nothing behind them: Bio Check-In persisted no field
// (nothing calls /api/pilot/athlete/check-in), Tracks had every value reading
// "Nobody has written this down yet", and Assessments said NOT BUILT YET over
// a disabled button. A tab is a promise that there is something behind it, so
// they are no longer offered; the panels stay in the file for when they earn
// their entry back.
describe('tabs with nothing behind them are not offered', () => {
  test('Tracks and Assessments are still gone from the nav', async () => {
    // This case used to also assert `queryByRole('button', { name: 'Bio
    // Check-In' })` was null, under a title that named all three.
    //
    // That assertion was a PROXY and it stopped meaning anything the moment
    // the surface came back: the tab returned on 2026-08-28 labelled
    // "Wellness", so a check for the literal string 'Bio Check-In' kept
    // passing while asserting nothing about the property in its title. It is
    // removed rather than renamed, because the surface it guarded now HAS
    // something behind it -- see the check-in cases below, which assert that
    // directly instead.
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Development' }));
    expect(screen.queryByRole('button', { name: 'Tracks' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Assessments' })).toBeNull();
  });

  test('Development opens straight onto Goals, its one real surface', async () => {
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Development' }));

    expect(screen.getByRole('button', { name: '+ New SMART Goal' })).toBeTruthy();
  });

  test('the surfaces with something behind them still render', async () => {
    await renderWorkspace();

    openTab('Floor');
    expect(await screen.findByText('No open work from your coach.')).toBeTruthy();

    openTab('Drills');
    expect(await screen.findByText(/have not added any reference drills/)).toBeTruthy();

    openTab('Schedule');
    expect(screen.getByRole('link', { name: 'Open Unified Scheduler' })).toBeTruthy();
  });

  /* The masthead read "My Training Dashboard" on all eleven surfaces, so the
     one line claiming to say where the athlete was agreed with the nav only
     on the surface it was written for. */
  test('the masthead names the surface that is actually open', async () => {
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Learn' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Learn' })).toBeTruthy();
    expect(screen.getByText('Athlete workspace · Drills')).toBeTruthy();
  });

  test('the drill library no longer offers a completion it cannot store', async () => {
    // "Mark Complete" set a React flag with no row behind it anywhere --
    // pilot.assignment_completions is keyed on a coach's assignment, and no
    // table records (athlete, library drill). Completions that ARE stored are
    // logged on the progression page against assigned drills.
    await renderWorkspace();
    openTab('Drills');

    expect(screen.queryByRole('button', { name: 'Mark Complete' })).toBeNull();
  });

  /**
   * W-D2 -- the Learn surface is Reference, and it reads the reference library.
   *
   * Before this it read /api/pilot/drills, the OPERATIONAL list a coach assigns
   * from, which meant the athlete's "Learn" tab showed the same rows as
   * assigned training and could not reach the instructional content behind them
   * at all.
   */
  describe('Learn -> Drills is the adopted reference library', () => {
    const adopted = {
      drill_id: 'drl-ref-1',
      name: 'Catch and Return',
      purpose: 'Catching the straight punch.',
      setup: 'Partners at technical distance.',
      execution: 'Partner leads; catch and return.',
      contact_level: 'light_technical',
      requires_coach_authorization: false,
      cues: ['Hand home first'],
    };

    // The athlete DETAIL (getAthleteDrillDetail): the browse fields plus the
    // practical instruction and the two child sets. Stop rules are one of each
    // scope, so both groupings are exercised.
    const adoptedDetail = {
      ...adopted,
      execution: 'Partner throws the jab.\n\nCatch it on the rear glove.\n\nReturn your own jab.',
      what_good_looks_like: 'Glove meets the punch, not the face\nReturn comes straight back',
      what_bad_looks_like: 'Reaching for the punch',
      common_errors: 'Catching late',
      corrections: 'Coach calls "catch" on the contact',
      equipment_needed: 'gloves',
      scale_levels: [
        { scale_level: 'A', is_starting_point: false, demand_description: 'Partner throws at half speed.', constraint_applied: '', contact_level: 'light_technical', coach_watch_point: 'Is the athlete repeating it unprompted?' },
        { scale_level: 'B', is_starting_point: true, demand_description: 'The drill as designed.', constraint_applied: '', contact_level: 'light_technical', coach_watch_point: 'Can the athlete respond to one cue?' },
        { scale_level: 'C', is_starting_point: false, demand_description: 'Partner varies the rhythm.', constraint_applied: '', contact_level: 'light_technical', coach_watch_point: 'Does the lesson survive?' },
      ],
      stop_rules: [
        { ordinal: 1, condition_text: 'Stop when fatigue breaks decision quality.', scope: 'universal', rule_kind: 'fatigue' },
        { ordinal: 2, condition_text: 'Stop when the glove stops meeting the punch.', scope: 'drill_specific', rule_kind: 'technique_degradation' },
      ],
    };

    async function openAdoptedDrill() {
      storedReferenceDrills = [adopted];
      storedReferenceDrillDetails = { [adopted.drill_id]: adoptedDetail };
      await renderWorkspace();
      openTab('Drills');
      fireEvent.click(await screen.findByRole('button', { name: 'Open drill: Catch and Return' }));
      return screen.findByRole('article', { name: 'Catch and Return' });
    }

    test('it reads the reference library and not the operational drill list', async () => {
      storedReferenceDrills = [adopted];
      await renderWorkspace();
      openTab('Drills');

      expect(await screen.findByText('Catch and Return')).toBeTruthy();

      const paths = fetchCalls.map((call) => call.url);
      expect(paths.some((url) => url.includes('/api/pilot/drill-library'))).toBe(true);
      // The operational list is what this surface used to read. If a future
      // edit points it back, this fails -- the two libraries mean different
      // things and an athlete's Learn tab must not be the assignment source.
      expect(paths.some((url) => /\/api\/pilot\/drills(\?|$)/.test(url))).toBe(false);
    });

    // LEVEL 1 (OD-2026-09-19-001): a concise card, not the whole drill.
    test('the card is a concise summary: what it is for and its contact level, and a way in', async () => {
      storedReferenceDrills = [adopted];
      await renderWorkspace();
      openTab('Drills');

      await screen.findByText('Catch and Return');
      expect(screen.getByText('Catching the straight punch.')).toBeTruthy();
      // Humanized, not the raw enum.
      expect(screen.getByText('Light technical contact')).toBeTruthy();
      expect(screen.queryByText('light_technical')).toBeNull();
      // The full instructions are one click in, not dumped on the card.
      expect(screen.queryByText('Partners at technical distance.')).toBeNull();
      expect(screen.getByRole('button', { name: 'Open drill: Catch and Return' })).toBeTruthy();
    });

    // LEVEL 2: the organized detail, safety first.
    test('opening a drill shows its safety, ordered steps, practical instruction, scaling and cues', async () => {
      const detail = await openAdoptedDrill();

      expect(fetchCalls.some((call) => call.url.includes('/api/pilot/drill-library?drill_id=drl-ref-1'))).toBe(true);

      const safety = within(detail).getByRole('region', { name: 'Safety' });
      expect(within(safety).getByText(/Light technical contact/)).toBeTruthy();
      expect(within(safety).getByText("This drill's stop rules")).toBeTruthy();
      expect(within(safety).getByText('Stop when the glove stops meeting the punch.')).toBeTruthy();
      expect(within(safety).getByText('Stop rules for every drill')).toBeTruthy();
      expect(within(safety).getByText('Stop when fatigue breaks decision quality.')).toBeTruthy();

      const items = within(detail).getAllByRole('listitem').map((item) => item.textContent);
      const first = items.indexOf('Partner throws the jab.');
      expect(first).toBeGreaterThanOrEqual(0);
      expect(items.slice(first, first + 3)).toEqual([
        'Partner throws the jab.',
        'Catch it on the rear glove.',
        'Return your own jab.',
      ]);

      expect(within(detail).getByText('Partners at technical distance.')).toBeTruthy();
      expect(within(detail).getByText('Glove meets the punch, not the face')).toBeTruthy();
      expect(within(detail).getByText('Reaching for the punch')).toBeTruthy();
      expect(within(detail).getByText('Catching late')).toBeTruthy();
      expect(within(detail).getByText('Coach calls "catch" on the contact')).toBeTruthy();
      expect(within(detail).getByText(/Standard \(B\) · where to start/)).toBeTruthy();
      expect(within(detail).getByText('Partner varies the rhythm.')).toBeTruthy();
      expect(within(detail).getByText('Hand home first')).toBeTruthy();
      // Coach-voiced watch points are for coaches.
      expect(within(detail).queryByText('Can the athlete respond to one cue?')).toBeNull();
    });

    test('it presents itself as Learning and says plainly that it is not assigned work', async () => {
      storedReferenceDrills = [adopted];
      await renderWorkspace();
      openTab('Drills');

      await screen.findByText('Catch and Return');
      expect(screen.getByText('Reference · Learning')).toBeTruthy();
      expect(screen.getByText(/not training your coach has given you/)).toBeTruthy();
      expect(screen.getByText(/does not assign it to you, does not log it/)).toBeTruthy();
    });

    test('no completion, logging or progression action appears, and opening a drill writes nothing', async () => {
      // The structural half of "Learning is not Assigned Training": nothing on
      // this surface writes, whether the list is showing or a drill is open.
      // Snapshotted around the open, so a write to ANY endpoint is caught, not
      // only the two that would be most obvious.
      storedReferenceDrills = [adopted];
      storedReferenceDrillDetails = { [adopted.drill_id]: adoptedDetail };
      await renderWorkspace();
      openTab('Drills');
      await screen.findByText('Catch and Return');
      const writesBefore = fetchCalls.filter((call) => call.method !== 'GET').length;

      fireEvent.click(screen.getByRole('button', { name: 'Open drill: Catch and Return' }));
      await screen.findByRole('article', { name: 'Catch and Return' });
      fireEvent.click(screen.getByRole('button', { name: 'Back to drills' }));

      for (const name of [/mark complete/i, /log/i, /complete/i, /assign/i, /start/i]) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
      expect(fetchCalls.filter((call) => call.method !== 'GET')).toHaveLength(writesBefore);
    });

    test('Back to drills returns to the list, un-hiding the card grid', async () => {
      await openAdoptedDrill();
      // jsdom loads no CSS, so visibility is asserted on the class that hides it.
      const grid = screen.getByRole('button', { name: 'Open drill: Catch and Return' }).closest('div.grid');
      expect(grid?.classList.contains('hidden')).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: 'Back to drills' }));

      expect(screen.queryByRole('article', { name: 'Catch and Return' })).toBeNull();
      expect(grid?.classList.contains('hidden')).toBe(false);
    });

    test('a drill with only general stop rules claims no drill-specific ones, and a warm-up rule reads as readiness', async () => {
      // The corpus case: 114 of 119 drills have no drill-specific stop rule,
      // and 63 carry a warm-up readiness rule, which is not a reason to stop.
      storedReferenceDrills = [adopted];
      storedReferenceDrillDetails = {
        [adopted.drill_id]: {
          ...adoptedDetail,
          stop_rules: [
            { ordinal: 1, condition_text: 'Stop when chasing replaces positioning.', scope: 'universal', rule_kind: 'intent_drift' },
            { ordinal: 2, condition_text: 'Re-warm before contact after ~20 minutes idle.', scope: 'universal', rule_kind: 'warmup_decay' },
          ],
        },
      };
      await renderWorkspace();
      openTab('Drills');
      fireEvent.click(await screen.findByRole('button', { name: 'Open drill: Catch and Return' }));
      const safety = within(await screen.findByRole('article', { name: 'Catch and Return' })).getByRole('region', { name: 'Safety' });

      expect(within(safety).queryByText("This drill's stop rules")).toBeNull();
      expect(within(safety).getByText('Stop rules for every drill')).toBeTruthy();
      expect(within(safety).getByText('Stop when chasing replaces positioning.')).toBeTruthy();
      expect(within(safety).getByText('Before contact or maximal effort')).toBeTruthy();
      expect(within(safety).getByText('Re-warm before contact after ~20 minutes idle.')).toBeTruthy();
    });

    test('an equipment-only setup reads as equipment, never as setup instructions', async () => {
      // The corpus case: standard_setup holds the same word as equipment_needed.
      storedReferenceDrills = [adopted];
      storedReferenceDrillDetails = {
        [adopted.drill_id]: { ...adoptedDetail, setup: 'focus mitt', equipment_needed: 'focus mitt' },
      };
      await renderWorkspace();
      openTab('Drills');
      fireEvent.click(await screen.findByRole('button', { name: 'Open drill: Catch and Return' }));
      const detail = await screen.findByRole('article', { name: 'Catch and Return' });

      expect(within(detail).queryByRole('heading', { name: 'Setup' })).toBeNull();
      expect(within(detail).getByRole('heading', { name: 'Equipment' })).toBeTruthy();
      expect(within(detail).getByText('focus mitt')).toBeTruthy();
    });

    test('a drill withdrawn since the list loaded says so, instead of calling it a load failure', async () => {
      storedReferenceDrills = [adopted];
      storedReferenceDrillDetails = {};
      await renderWorkspace();
      openTab('Drills');
      fireEvent.click(await screen.findByRole('button', { name: 'Open drill: Catch and Return' }));

      expect(await screen.findByText("This drill is no longer in your gym's library.")).toBeTruthy();
      expect(screen.queryByText(/failure to load the drill/)).toBeNull();
    });

    test('a drill that fails to load says so, rather than showing an empty drill', async () => {
      storedReferenceDrills = [adopted];
      storedReferenceDrillDetails = {};
      detailReadFails = true;
      await renderWorkspace();
      openTab('Drills');
      fireEvent.click(await screen.findByRole('button', { name: 'Open drill: Catch and Return' }));

      expect(await screen.findByText('This drill did not load.')).toBeTruthy();
      expect(screen.getByText(/failure to load the drill/)).toBeTruthy();
      expect(screen.queryByRole('article', { name: 'Catch and Return' })).toBeNull();
    });

    test('a coach-authorization requirement is shown, because it is a safety fact', async () => {
      storedReferenceDrills = [{ ...adopted, requires_coach_authorization: true }];
      await renderWorkspace();
      openTab('Drills');

      expect(await screen.findByText('Coach authorization required')).toBeTruthy();
    });

    /**
     * THE SCREEN MAY NOT PROMISE SAFETY CONTENT IT DOES NOT SHOW.
     *
     * A BICONDITIONAL, not a ban: the rule is "say it only if you show it".
     * Before W-D4 the cards rendered no stop rules, so the copy was held to
     * silence and this test pinned both sides false. An opened drill now
     * renders its stop rules (OD-2026-09-19-001), so the copy names them --
     * and this checks the claim against the rendering on the opened drill,
     * where the stop rules are.
     */
    test('it claims to show stop rules exactly when an opened drill renders them', async () => {
      await openAdoptedDrill();

      // THE PANEL MUST BE EXPANDED FIRST: HelpPanel renders its description and
      // usage only while expanded, so a collapsed panel would claim nothing.
      fireEvent.click(screen.getByRole('button', { name: /HELP: Reference Library/i }));
      expect(screen.getByText(/Reference material for the drills your gym has adopted/)).toBeTruthy();

      const claimsStopRules = screen.queryAllByText(/stop rule|when to stop/i).length > 0;
      const rendersStopRules = screen.queryAllByText(/Stop if|Stop when/i).length > 0;

      expect(claimsStopRules).toBe(rendersStopRules);
      expect(rendersStopRules).toBe(true);
    });
  });
});

// normalizeStoredSession is not exported, and it does not need to be: the notes
// draft save replays the rehydrated rpe and rpe_method back to
// /api/pilot/sessions/update untouched, so what it wrote is exactly what
// normalization produced. That replay is the observation point for every case
// below.
//
// The rule being pinned is one line of normalizeStoredSession: absence is
// tested BEFORE Number(), because Number(null) is 0, 0 is a real RPE, and
// coercing first turns "not rated yet" into "rated it zero".
describe('a rehydrated session keeps the RPE it was actually stored with', () => {
  async function draftSaveBodyFor(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    storedSessions = [row];
    await renderWorkspace();

    const notes = await screen.findByPlaceholderText(/Session notes for your coach/);
    fireEvent.change(notes, { target: { value: 'Ribs sore on the left side.' } });

    await waitFor(() => expect(postedTo('/api/pilot/sessions/update')).toHaveLength(1), { timeout: 5000 });
    return postedTo('/api/pilot/sessions/update')[0].body;
  }

  test('a stored 0 is replayed as 0, not as null', async () => {
    // numeric 0 arrives from node-postgres as the string '0'. It is a reading
    // the athlete gave, and dropping it would erase a real self-report.
    const body = await draftSaveBodyFor(openSessionRow({ rpe: '0' }));
    expect(body.rpe).toBe(0);
    expect(body.rpe).not.toBeNull();
  });

  test('a stored null is replayed as null, not as 0', async () => {
    const body = await draftSaveBodyFor(openSessionRow({ rpe: null }));
    expect(body.rpe).toBeNull();
    expect(body.rpe).not.toBe(0);
  });

  test('a missing rpe key is replayed as null, not as 0', async () => {
    const withoutRpe = openSessionRow();
    delete (withoutRpe as Record<string, unknown>).rpe;
    const body = await draftSaveBodyFor(withoutRpe);
    expect(body.rpe).toBeNull();
  });

  test('a stored numeric string is replayed as the number it names', async () => {
    const body = await draftSaveBodyFor(openSessionRow({ rpe: '8' }));
    expect(body.rpe).toBe(8);
  });

  // A row predating the method column genuinely has unknown provenance, and
  // that is what it must claim -- not the one honest method the app has.
  test('an absent rpe_method is replayed as UNKNOWN', async () => {
    const body = await draftSaveBodyFor(openSessionRow());
    expect(body.rpe_method).toBe('UNKNOWN');
  });

  test('an unrecognised rpe_method is replayed as UNKNOWN rather than trusted', async () => {
    const body = await draftSaveBodyFor(openSessionRow({ rpe_method: 'coach_estimate' }));
    expect(body.rpe_method).toBe('UNKNOWN');
  });

  test('a genuine post-session self-report keeps its method', async () => {
    const body = await draftSaveBodyFor(openSessionRow({
      rpe: '4',
      rpe_method: 'athlete_post_session_self_report',
    }));
    expect(body.rpe).toBe(4);
    expect(body.rpe_method).toBe('athlete_post_session_self_report');
  });

  // A notes save is not a rating, and must not close the session either.
  test('a notes save does not complete the session', async () => {
    const body = await draftSaveBodyFor(openSessionRow({ rpe: null }));
    expect(body.completed_flag).toBe(false);
  });
});

// A-FIN-05: POST-SESSION EFFORT IS THE ATHLETE'S ANSWER, GIVEN AT CHECK-OUT, OR
// NOTHING. Check-out wrote rpe null / UNKNOWN on every session because no
// control asked. The question now sits on the open session's Session Log, as
// described choices that start unanswered. These pin the whole contract:
// untouched is null / UNKNOWN; 0, an ordinary value and 10 are sent exactly,
// attributed to the athlete's post-session self-report; nothing else on the
// screen -- the pre-check-in note (the readiness slider, until A-FIN-01
// removed it), the notes, a previous session -- can become the number; a
// refused check-out keeps the answer; and the stored value comes back on the
// card the athlete already reads.
describe('post-session effort is the athlete\'s answer at check-out, or nothing', () => {
  const EFFORT_Q = 'How hard was the session you just finished?';

  // Numbers only: the session contract defines 0-10 and its provenance, not
  // any published instrument's words for the points between.
  function effortName(value: number): string {
    return `${EFFORT_Q} ${value}`;
  }

  function effortButton(value: number): HTMLElement {
    return screen.getByRole('button', { name: effortName(value) });
  }

  function checkOutBodies(): Array<Record<string, unknown>> {
    return postedTo('/api/pilot/sessions/update')
      .map((call) => call.body)
      .filter((body) => body.completed_flag === true);
  }

  async function checkOut(): Promise<Record<string, unknown>> {
    const before = checkOutBodies().length;
    fireEvent.click(screen.getByRole('button', { name: 'Check Out' }));
    await waitFor(() => expect(checkOutBodies()).toHaveLength(before + 1));
    return checkOutBodies()[before];
  }

  async function openSession(overrides: Record<string, unknown> = {}) {
    storedSessions = [openSessionRow({ rpe: null, ...overrides })];
    await renderWorkspace();
    await screen.findByRole('button', { name: 'Check Out' });
  }

  test('the question is asked only on an open session, and starts unanswered', async () => {
    await renderWorkspace();
    await screen.findByText(/You are not checked in right now/);
    expect(screen.queryByRole('group', { name: EFFORT_Q })).toBeNull();
    cleanup();

    await openSession();
    const group = screen.getByRole('group', { name: EFFORT_Q });
    const choices = within(group).getAllByRole('button', { pressed: false });
    // Eleven choices, 0 to 10, and none of them chosen.
    expect(within(group).queryAllByRole('button', { pressed: true })).toEqual([]);
    expect(choices.map((choice) => choice.getAttribute('aria-label'))).toEqual(
      Array.from({ length: 11 }, (_, value) => effortName(value)),
    );
    expect(within(group).getByText(/Not answered — you can skip this/)).toBeTruthy();
    // No slider: a range input always has a position, which is an answer nobody gave.
    expect(within(group).queryByRole('slider')).toBeNull();
    // The two ends are explained; nothing in between is given words.
    expect(within(group).getByText(/0 means not hard at all\. 10 means as hard as you could go\./)).toBeTruthy();
    for (const word of ['Rest', 'Moderate', 'Somewhat hard', 'Very hard', 'Maximal', 'Easy']) {
      expect(within(group).queryByText(word)).toBeNull();
    }
    expect(group.textContent ?? '').not.toMatch(/CR-10|Foster/);
  });

  test('an untouched check-out records no effort: null with an UNKNOWN method', async () => {
    await openSession();

    const body = await checkOut();
    expect(body.rpe).toBeNull();
    expect(body.rpe_method).toBe('UNKNOWN');
  });

  test.each([0, 7, 10])('an explicit %i is sent as exactly that, attributed to the athlete', async (value) => {
    await openSession();

    fireEvent.click(effortButton(value));
    expect(effortButton(value).getAttribute('aria-pressed')).toBe('true');
    const body = await checkOut();

    // toBe, not toBeFalsy/toBeTruthy: 0 must arrive as 0, never as null.
    expect(body.rpe).toBe(value);
    expect(body.rpe_method).toBe('athlete_post_session_self_report');
  });

  test('a stored pre-session reading is not promoted, answered or not', async () => {
    // The fixture's default rpe '8' is the readiness slider a pre-migration
    // check-in stored. Answered, the answer wins; unanswered, it stays unrecorded.
    storedSessions = [openSessionRow()];
    await renderWorkspace();
    await screen.findByRole('button', { name: 'Check Out' });

    fireEvent.click(effortButton(3));
    expect((await checkOut()).rpe).toBe(3);
  });

  // REWRITTEN IN A-FIN-01. This was 'the readiness slider cannot reach the
  // check-out RPE', and the slider is gone. The property it pinned -- nothing
  // the athlete puts in BEFORE the session can become the session's effort --
  // now has one pre-session input to hold it against: the pre-check-in note.
  // A bare number is the hardest case, so that is what goes in it, through a
  // real check-in rather than a rehydrated row. Untouched, check-out still
  // records nothing; answered, the answer wins over whatever the note said.
  test('nothing entered before check-in can reach the check-out RPE', async () => {
    await renderWorkspace();
    expect(screen.queryByRole('slider')).toBeNull();

    const checkIn = await checkInFromSessionLog('9');
    expect(checkIn.rpe).toBeNull();
    expect(checkIn.rpe_method).toBe('UNKNOWN');
    openTab('Dashboard');
    await screen.findByRole('button', { name: 'Check Out' });
    const untouched = await checkOut();
    expect(untouched.notes).toBe('9');
    expect(untouched.rpe).toBeNull();
    expect(untouched.rpe_method).toBe('UNKNOWN');
    cleanup();
    fetchCalls.length = 0;

    await renderWorkspace();
    await checkInFromSessionLog('2');
    openTab('Dashboard');
    await screen.findByRole('button', { name: 'Check Out' });
    fireEvent.click(effortButton(7));
    const answered = await checkOut();
    expect(answered.rpe).toBe(7);
    expect(answered.rpe_method).toBe('athlete_post_session_self_report');
  });

  test('the session notes cannot become an RPE', async () => {
    await openSession();

    fireEvent.change(screen.getByPlaceholderText(/Session notes for your coach/), { target: { value: '8' } });
    const body = await checkOut();

    expect(body.notes).toBe('8');
    expect(body.rpe).toBeNull();
    expect(body.rpe_method).toBe('UNKNOWN');
  });

  test('the notes draft save never carries the answer -- only check-out does', async () => {
    await openSession();

    fireEvent.click(effortButton(7));
    fireEvent.change(screen.getByPlaceholderText(/Session notes for your coach/), { target: { value: 'Jab felt sharp.' } });

    await waitFor(() => expect(postedTo('/api/pilot/sessions/update')).toHaveLength(1), { timeout: 5000 });
    const [draft] = postedTo('/api/pilot/sessions/update');
    expect(draft.body.completed_flag).toBe(false);
    expect(draft.body.rpe).toBeNull();
    expect(draft.body.rpe_method).toBe('UNKNOWN');
  });

  test('a refused check-out keeps the answer and the session, and claims nothing', async () => {
    sessionUpdateFails = true;
    await openSession();

    fireEvent.click(effortButton(7));
    fireEvent.click(screen.getByRole('button', { name: 'Check Out' }));

    expect(await screen.findByText(/still checked in/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check Out' })).toBeTruthy();
    expect(effortButton(7).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText(/Your effort, 7 of 10, is on it too/)).toBeNull();

    // And the retry carries the same answer.
    sessionUpdateFails = false;
    const body = await checkOut();
    expect(body.rpe).toBe(7);
    expect(await screen.findByText(/Your effort, 7 of 10, is on it too/)).toBeTruthy();
  });

  // The notes draft save and check-out both send the whole session row, and the
  // server applies whichever ARRIVES last (the fixture does the same when
  // persistSessionUpdates is on). A draft held on the wire past the check-out
  // click is the ordering that used to reopen the session and erase the answer.
  test('a notes save already in flight cannot land after check-out and undo it', async () => {
    persistSessionUpdates = true;
    holdDraftSaves = true;
    await openSession();

    fireEvent.change(screen.getByPlaceholderText(/Session notes for your coach/), { target: { value: 'Jab felt sharp.' } });
    // The draft save has left and is being held by the "server".
    await waitFor(() => expect(heldDraftSaves).toHaveLength(1), { timeout: 5000 });

    fireEvent.click(effortButton(7));
    fireEvent.click(screen.getByRole('button', { name: 'Check Out' }));
    await act(async () => {
      await Promise.resolve();
    });
    // Check-out waits for the draft on the wire instead of racing it.
    expect(checkOutBodies()).toHaveLength(0);

    await act(async () => {
      heldDraftSaves.shift()?.();
    });
    await waitFor(() => expect(checkOutBodies()).toHaveLength(1));

    // What the server holds at the end is the check-out, not the draft.
    await waitFor(() => expect(storedSessions[0]).toEqual(expect.objectContaining({
      completed_flag: true,
      rpe: '7',
      rpe_method: 'athlete_post_session_self_report',
      notes: 'Jab felt sharp.',
    })));
    expect(await screen.findByText(/Your effort, 7 of 10, is on it too/)).toBeTruthy();
  });

  // Two drafts overlapping is the case remembering only the latest one missed:
  // check-out would wait for the second while the first could still arrive
  // last. Every held write is released NEWEST FIRST -- the worst order -- and
  // the row must still end as the check-out.
  test('overlapping notes saves are queued, and none can land after check-out', async () => {
    persistSessionUpdates = true;
    holdDraftSaves = true;
    await openSession();

    const box = screen.getByPlaceholderText(/Session notes for your coach/);
    fireEvent.change(box, { target: { value: 'Jab felt sharp.' } });
    await waitFor(() => expect(heldDraftSaves).toHaveLength(1), { timeout: 5000 });

    // Keep typing, and let the second draft's delay run out while the first is on the wire.
    fireEvent.change(box, { target: { value: 'Jab felt sharp. Hook was late.' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });
    // Queued behind the first, not racing it.
    expect(postedTo('/api/pilot/sessions/update')).toHaveLength(1);

    fireEvent.click(effortButton(7));
    fireEvent.click(screen.getByRole('button', { name: 'Check Out' }));

    // Release everything held, newest first, until check-out has gone.
    await waitFor(async () => {
      await act(async () => {
        heldDraftSaves.pop()?.();
      });
      expect(checkOutBodies()).toHaveLength(1);
    }, { timeout: 5000 });
    await act(async () => {
      while (heldDraftSaves.length > 0) heldDraftSaves.pop()?.();
    });

    await waitFor(() => expect(storedSessions[0]).toEqual(expect.objectContaining({
      completed_flag: true,
      rpe: '7',
      rpe_method: 'athlete_post_session_self_report',
      notes: 'Jab felt sharp. Hook was late.',
    })));
    // And nothing reached the server after the check-out did.
    const updates = postedTo('/api/pilot/sessions/update');
    expect(updates[updates.length - 1].body.completed_flag).toBe(true);
  });

  // Write ORDER is not enough on its own: check-out's empty-box fallback used
  // the note captured when Check Out was pressed, which predates the wait.
  // A draft that lands during the wait is newer than that capture, and the
  // fallback must not put the older note back over it.
  test('a note saved while check-out waits is kept, not replaced by the older one', async () => {
    persistSessionUpdates = true;
    holdDraftSaves = true;
    await openSession({ notes: 'old' });

    const box = screen.getByPlaceholderText(/Session notes for your coach/) as HTMLTextAreaElement;
    expect(box.value).toBe('old');
    fireEvent.change(box, { target: { value: 'new' } });
    await waitFor(() => expect(heldDraftSaves).toHaveLength(1), { timeout: 5000 });

    // Empty box at the moment of Check Out: the fallback decides the note.
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check Out' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(checkOutBodies()).toHaveLength(0);

    await act(async () => {
      heldDraftSaves.shift()?.();
    });
    await waitFor(() => expect(checkOutBodies()).toHaveLength(1));

    expect(checkOutBodies()[0].notes).toBe('new');
    await waitFor(() => expect(storedSessions[0]).toEqual(expect.objectContaining({
      completed_flag: true,
      notes: 'new',
    })));
  });

  test('the notes box takes no typing while check-out is in progress, and a refused check-out gives it back', async () => {
    holdDraftSaves = true;
    await openSession();

    const box = screen.getByPlaceholderText(/Session notes for your coach/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Jab felt sharp.' } });
    await waitFor(() => expect(heldDraftSaves).toHaveLength(1), { timeout: 5000 });

    sessionUpdateFails = true;
    fireEvent.click(screen.getByRole('button', { name: 'Check Out' }));
    await act(async () => {
      await Promise.resolve();
    });
    // Waiting on the draft: anything typed now could not reach the session.
    expect(box.disabled).toBe(true);

    await act(async () => {
      heldDraftSaves.shift()?.();
    });
    expect(await screen.findByText(/still checked in/i)).toBeTruthy();
    // Refused: editing is back, and what was written is still there.
    expect(box.disabled).toBe(false);
    expect(box.value).toBe('Jab felt sharp.');
  });

  test('no notes save starts once check-out has begun', async () => {
    await openSession();

    fireEvent.change(screen.getByPlaceholderText(/Session notes for your coach/), { target: { value: 'Last round was rough.' } });
    // Pressed inside the draft save's delay, so its timer has not fired yet.
    fireEvent.click(effortButton(5));
    const body = await checkOut();
    expect(body.notes).toBe('Last round was rough.');

    // Past the draft delay: the only session update ever sent is the check-out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });
    expect(postedTo('/api/pilot/sessions/update')).toHaveLength(1);
  });

  test('clearing the answer puts it back to not answered, and check-out then records none', async () => {
    await openSession();

    fireEvent.click(effortButton(4));
    fireEvent.click(screen.getByRole('button', { name: 'Clear my answer' }));

    expect(screen.getByText(/Not answered — you can skip this/)).toBeTruthy();
    const body = await checkOut();
    expect(body.rpe).toBeNull();
    expect(body.rpe_method).toBe('UNKNOWN');
  });

  test('check-out sends no duration and feeds no observation', async () => {
    await openSession();

    fireEvent.click(effortButton(7));
    const body = await checkOut();

    expect(Object.keys(body).sort()).toEqual([
      'athlete_id', 'completed_flag', 'created_at', 'date', 'notes', 'rpe', 'rpe_method', 'session_id', 'updated_at',
    ]);
    expect(postedTo('/api/pilot/shadow/formulas/observations')).toHaveLength(0);
  });

  test.each([
    [0, /effort 0 of 10/],
    [7, /effort 7 of 10/],
    [null, /effort not recorded/],
  ])('what was stored comes back on the card as stored (%p)', async (value, stamp) => {
    persistSessionUpdates = true;
    await openSession();

    if (value !== null) fireEvent.click(effortButton(value));
    await checkOut();

    // Read back through the existing session list and training card -- no
    // second history. The list answers numeric RPE as a string, as node-postgres does.
    expect(await screen.findByTitle(stamp)).toBeTruthy();
    if (value === 0) expect(screen.queryByTitle(/effort not recorded/)).toBeNull();
  });

  test('check-in writes no RPE, and the next session starts unanswered after a rated one', async () => {
    persistSessionUpdates = true;
    await openSession();

    fireEvent.click(effortButton(9));
    expect((await checkOut()).rpe).toBe(9);

    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    await waitFor(() => expect(postedTo('/api/pilot/sessions')).toHaveLength(1));
    expect(postedTo('/api/pilot/sessions')[0].body.rpe).toBeNull();
    expect(postedTo('/api/pilot/sessions')[0].body.rpe_method).toBe('UNKNOWN');

    openTab('Dashboard');
    const group = await screen.findByRole('group', { name: EFFORT_Q });
    expect(within(group).queryAllByRole('button', { pressed: true })).toEqual([]);
    expect(within(group).getByText(/Not answered — you can skip this/)).toBeTruthy();
  });
});

// Check-in happens BEFORE the session. There is no exertion to rate yet, so
// there is nothing honest to put in the RPE column -- which is precisely why
// the column being NOT NULL produced the defect: something had to go in it, and
// what went in it was the pre-session readiness slider.
describe('check-in records no session RPE at all', () => {
  test('the created session carries a null rpe and an UNKNOWN method', async () => {
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    await waitFor(() => expect(postedTo('/api/pilot/sessions')).toHaveLength(1));

    const [checkIn] = postedTo('/api/pilot/sessions');
    expect(checkIn.body.rpe).toBeNull();
    expect(checkIn.body.rpe_method).toBe('UNKNOWN');
  });

  test('no readiness value is submitted as a session RPE', async () => {
    // The readiness slider is gone (A-FIN-01), and so is the band it wrote on
    // the check-in note. What this still pins is that nothing reaches
    // pilot.sessions.rpe at check-in: a number here would be that regression
    // whatever its value, so the assertion is on the type -- and it holds
    // with a bare number written in the pre-check-in note, too.
    await renderWorkspace();

    const blank = await checkInFromSessionLog();
    expect(typeof blank.rpe).not.toBe('number');
    expect(blank.notes).toBe(NO_NOTE_PLACEHOLDER);
    cleanup();
    fetchCalls.length = 0;

    await renderWorkspace();
    const numeric = await checkInFromSessionLog('8');
    expect(typeof numeric.rpe).not.toBe('number');
    expect(numeric.rpe_method).toBe('UNKNOWN');
    // The note stays a note: stored as the words typed, not read as a rating.
    expect(numeric.notes).toBe('8');
  });
});

// READINESS IS A RECORD, NOT A PRESCRIPTION. A pre-session self-report whose
// method nothing has validated -- readinessProvenance.ts is explicit that NO
// readiness method passes the established reliability/validity bar -- may be
// written down, and may not decide what training is generated, shown, or sent.
// Check-in used to hand the slider's band to buildWorkoutFloorTasks, which
// bought GREEN athletes a 'High-output intervals' conditioning finisher and
// everyone else reduced work. That generator is gone (A-FIN-04), and the
// slider itself is gone (A-FIN-01).
//
// REWRITTEN IN A-FIN-01, and renamed from 'the readiness slider cannot change
// the work'. The inputs these hold against are now the two that exist before a
// session: the athlete's wellness answers (the durable pre-training
// self-report) and the optional pre-check-in note. Neither may produce or
// change work. The old first case also pinned the band landing on the session
// note; that half is retired on purpose -- no band is written any more, and
// the note is the athlete's words or the fixed placeholder (pinned below).
describe('nothing said before the session can change the work', () => {
  /** Today's wellness check with every 1-5 answer at one end of its scale. */
  function wellnessAt(value: 1 | 5): Record<string, unknown> {
    return {
      ...checkedInRecord(),
      energy: value,
      soreness: value,
      focus: value,
      motivation: value,
      mental_clarity: value,
      stress: value,
      hydration: value,
      nutrition_compliance: value,
      sleep_hours: value === 5 ? 9 : 4,
    };
  }

  async function checkInWith(wellness: Record<string, unknown>, note?: string) {
    storedCheckIn = wellness;
    await renderWorkspace();
    const session = await checkInFromSessionLog(note);
    await waitFor(() => expect(openSurface()).toBe('Floor'));
    return { session };
  }

  test('check-ins after opposite wellness answers, with and without a note, write only the session and no band', async () => {
    const low = await checkInWith(wellnessAt(1));
    const lowPlanCalls = floorPlanCalls().length;
    cleanup();
    fetchCalls.length = 0;
    const high = await checkInWith(wellnessAt(5), 'Feeling sharp today.');

    expect(lowPlanCalls).toBe(0);
    expect(floorPlanCalls()).toHaveLength(0);

    // The note is the athlete's words or the placeholder -- never a band, and
    // never anything read off the wellness answers.
    expect(low.session.notes).toBe(NO_NOTE_PLACEHOLDER);
    expect(high.session.notes).toBe('Feeling sharp today.');
    for (const body of [low.session, high.session]) {
      expect(JSON.stringify(body)).not.toMatch(/\b(GREEN|YELLOW|RED)\b|Auto check-in readiness/);
      expect(body.rpe).toBeNull();
    }
  });

  // A mutation audit (2026-08-25) found a task appended only to the DISPLAYED
  // list escalating the floor a child reads while every payload assertion
  // stayed green. So the display itself is pinned: check-in lands the athlete
  // on the Floor, and what renders there is the coach's list, unchanged by
  // how they answered their wellness check or what they wrote before starting.
  test('the floor the athlete sees is identical whatever the wellness answers say', async () => {
    const renderedTitles = async (wellness: Record<string, unknown>, note?: string) => {
      storedAssignments = [
        assignment({ assignment_id: 'as-1', drill_display_name: 'Jab-cross on the bag' }),
        assignment({ assignment_id: 'as-2', status: 'in_progress', drill_display_name: 'Slip drill' }),
      ];
      await checkInWith(wellness, note);
      await screen.findByRole('heading', { level: 4, name: 'Slip drill' });
      const titles = floorWorkTitles();
      cleanup();
      fetchCalls.length = 0;
      return titles;
    };

    const low = await renderedTitles(wellnessAt(1), 'Wiped out, barely slept.');
    const unanswered = await renderedTitles(checkedInRecord());
    const high = await renderedTitles(wellnessAt(5), 'Ready to go hard.');

    expect(unanswered).toEqual(low);
    expect(high).toEqual(low);
    // Anchored to the real floor, so the equality cannot pass on an empty page.
    expect(low).toEqual(['Jab-cross on the bag', 'Slip drill']);
  });

  test('no intensity escalation is reachable from wellness answers or the note', async () => {
    // The top of every scale plus a note asking for more is the strongest
    // "ready" signal this screen can receive. It used to be the slider at 10
    // that bought a 'Conditioning Finisher' prescribing 'High-output
    // intervals: 6 rounds x 90s on / 60s active recovery'. Nothing may buy an
    // intensity prescription now.
    await checkInWith(wellnessAt(5), 'Push me hard, I feel great.');

    const everySentBody = JSON.stringify(fetchCalls.map((call) => call.body));
    expect(everySentBody).not.toContain('High-output');
    expect(everySentBody).not.toContain('Conditioning Finisher');
    expect(screen.queryByText(/High-output/)).toBeNull();
  });
});

// The Session Load feed (SHADOW's rpe x duration input) used to run at
// check-in on the two pre-session numbers: the readiness slider as
// `session_rpe` and the PLANNED duration as `duration`. It runs at check-out
// now, where both inputs would be real -- except nothing collects either one
// yet, so the honest behaviour is to submit nothing at all.
//
// This is the test that stops the gap being closed with a prefill. A default
// duration or a prefilled RPE would make an untouched control indistinguishable
// from an answer, which is exactly how a planned 60 minutes became an observed
// one.
describe('no session observation is fabricated for SHADOW', () => {
  test('check-out submits no observation while nothing collects one', async () => {
    storedSessions = [openSessionRow()];
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check Out' }));
    await waitFor(() => expect(postedTo('/api/pilot/sessions/update')).toHaveLength(1));

    expect(postedTo('/api/pilot/shadow/formulas/observations')).toHaveLength(0);
  });

  test('check-in submits no session observation either', async () => {
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    await waitFor(() => expect(postedTo('/api/pilot/sessions')).toHaveLength(1));

    // Specifically: no session_rpe observation carrying the readiness slider.
    const kinds = postedTo('/api/pilot/shadow/formulas/observations')
      .map((call) => call.body.kind);
    expect(kinds).not.toContain('session_rpe');
    expect(kinds).not.toContain('duration');
  });

  test('the check-in card no longer asks for a duration nothing records', async () => {
    // The "Session Duration (minutes)" box outlived the feed it fed: when the
    // Session Load observation moved to check-out and was then withheld for
    // want of real inputs, the input stayed on the card, collecting a number
    // no code read. The anchor assertion keeps this from passing vacuously on
    // the wrong screen. It was the readiness slider on the same card; since
    // A-FIN-01 removed both, the anchor is the pre-session input that
    // replaced them -- present -- with the dead one still gone.
    await renderWorkspace();

    expect(await screen.findByLabelText(PRE_CHECK_IN_NOTE)).toBeTruthy();
    expect(screen.queryByLabelText('Session Duration (minutes)')).toBeNull();
    expect(screen.queryByLabelText(REMOVED_SLIDER_LABEL)).toBeNull();
  });
});

// The training card is fed by its own mapper over the same /api/pilot/sessions/list
// response, and that mapper is a second place the null could have been coerced.
// It read `rpe: Number(s.rpe) || 0`, which fabricated a reading twice over:
// Number(null) is 0, and `|| 0` then swallowed a genuine 0 as well. The card
// itself is covered in trainingCard.test.tsx; what is covered here is that a
// null survives the trip from the API response onto the card.
describe('the training card is fed the RPE that was stored, not a substitute', () => {
  function completedRow(overrides: Record<string, unknown> = {}) {
    return openSessionRow({
      session_id: 'session_done',
      completed_flag: true,
      ...overrides,
    });
  }

  test('a completed session with no RPE reaches the card as not recorded', async () => {
    storedSessions = [completedRow({ rpe: null })];
    await renderWorkspace();
    openTab('Dashboard');

    const stamp = await screen.findByTitle(/effort not recorded/);
    expect(stamp).toBeTruthy();
    expect(stamp.getAttribute('title')).not.toMatch(/effort 0/);
  });

  test('a completed session rated 0 reaches the card as 0, not as absent', async () => {
    storedSessions = [completedRow({ rpe: '0' })];
    await renderWorkspace();
    openTab('Dashboard');

    const stamp = await screen.findByTitle(/effort 0 of 10/);
    expect(stamp).toBeTruthy();
    expect(screen.queryByTitle(/effort not recorded/)).toBeNull();
  });

  test('an ordinary reading is unaffected', async () => {
    storedSessions = [completedRow({ rpe: '7' })];
    await renderWorkspace();
    openTab('Dashboard');

    expect(await screen.findByTitle(/effort 7 of 10/)).toBeTruthy();
  });
});

// THE SELF-REPORT'S PRESENTATION MAY NOT OUT-CLAIM ITS AUTHORITY. #597 removed
// the check-in slider's power over the generated work, but the copy around it
// kept the old voice: a card headed "Current Readiness" over a "Readiness to
// Train" slider, help text ordering a morning readiness check and warning
// against "ignoring LOW readiness scores before intense training", and a
// summary tile translating the band into an instruction (READY FOR TRAINING /
// MODIFY TRAINING / COACH REVIEW REQUIRED). All of that told a child their
// 1-10 governs training when it decides nothing.
//
// REWRITTEN IN A-FIN-01, and renamed from 'the check-in slider presents as a
// self-report, not a clearance'. The slider is gone -- it started at 8, so the
// "number they chose" these cases read back was, untouched, a number nobody
// chose. The pre-session self-report is the wellness check, and the summary
// tile now says whether it is on record. What these still pin is the same
// property against the new surface: nothing on the screen claims a readiness
// answer the athlete did not give, the tile says it is not a clearance, no
// state of it buys a training instruction, and the old authority vocabulary
// stays gone.
//
// Each old case, accounted for:
//   'the number the athlete chose is shown back to them' -- RETIRED: there is
//     no number any more. Replaced by the first case below, which pins that no
//     readiness control or number is drawn at all.
//   'the screen states that the report neither clears the athlete nor changes
//     the work' -- REWRITTEN: the owner's 2026-08-24 sentence sat at the
//     slider and was about it, so it left with it; the summary tile keeps
//     "Not a clearance".
//   'no slider value buys a training instruction' -- REWRITTEN over the four
//     wellness states.
//   'the dashboard help no longer instructs readiness-gated training' -- KEPT,
//     with the removed card's heading added, and made real: it now expands the
//     panel before asserting (it used to pass on a closed one) and pins the
//     description's "Say how you feel" as gone with the slider it described.
describe('the pre-session self-report presents as a self-report, not a clearance', () => {
  function wellnessTile(): HTMLElement {
    return screen.getByText("Today's Wellness").parentElement as HTMLElement;
  }

  /** The Session Log card on the Dashboard -- everything under its heading. */
  function sessionLogPanel(): HTMLElement {
    return screen.getByText('Session Log').parentElement as HTMLElement;
  }

  test('no readiness control or number is drawn before the athlete has answered anything', async () => {
    await renderWorkspace();

    const note = (await screen.findByLabelText(PRE_CHECK_IN_NOTE)) as HTMLTextAreaElement;
    // The one pre-session input starts empty -- no value the athlete did not write.
    expect(note.value).toBe('');
    expect(screen.getByText(/Optional\. You can leave it empty\./)).toBeTruthy();

    // The defaulted slider, by its label and by its role: a range always has
    // a position, which is an answer nobody gave.
    expect(screen.queryByLabelText(REMOVED_SLIDER_LABEL)).toBeNull();
    expect(screen.queryAllByRole('slider')).toEqual([]);
    expect(screen.queryByText('Pre-Session Self-Report')).toBeNull();
    // And nothing reads one back: not the tile's old "8/10 · GREEN", not any
    // other n/10, not a bare band word.
    expect(screen.queryByText('Your Self-Report')).toBeNull();
    expect(screen.queryByText('8/10 · GREEN')).toBeNull();
    expect(screen.queryByText(/\b\d+\/10\b/)).toBeNull();
    expect(screen.queryByText(/\b(GREEN|YELLOW|RED)\b/)).toBeNull();
  });

  /**
   * THE RULE, NOT THE REMOVED CONTROL'S FINGERPRINTS. The case above pins the
   * slider that was taken out: its label, its role, its card heading, its
   * n/10 read-back, its band words. A mutation audit (2026-09-22) showed that
   * is not the same property as the one the slice exists for. A DIFFERENT
   * defaulted control -- a `<select id="pre-readiness" defaultValue="8">`
   * labelled "How ready are you to train?" -- was added to this panel and
   * every case in this file stayed green, because it matched none of those
   * fingerprints while doing exactly what the slider did: showing the athlete
   * an answer of 8 that they had not given.
   *
   * So this reads the panel instead of the old control. Whatever the Session
   * Log offers before check-in, and whatever it is called, each control must
   * start with nothing in it. The defect is a pre-filled answer, not any
   * particular way of asking for one.
   */
  test('every control offered before check-in starts unanswered, whatever it is called', async () => {
    await renderWorkspace();
    await screen.findByLabelText(PRE_CHECK_IN_NOTE);

    const panel = sessionLogPanel();
    const controls = Array.from(panel.querySelectorAll('input, select, textarea'));
    // Anchored on the optional note being one of them, so an empty panel --
    // or the wrong panel -- cannot pass this by having nothing to check.
    expect(controls.length).toBeGreaterThan(0);
    expect(controls).toContain(screen.getByLabelText(PRE_CHECK_IN_NOTE));

    for (const control of controls) {
      if (control instanceof HTMLSelectElement) {
        // A select always has a selection, so only an empty/unchosen option
        // may be the one selected.
        expect(control.options[control.selectedIndex]?.value ?? '').toBe('');
        continue;
      }
      if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
        expect(control.checked).toBe(false);
        expect(control.hasAttribute('checked')).toBe(false);
        continue;
      }
      // Text boxes and ranges alike: a range reports its position here, so a
      // slider fails on its value before it fails on its role below.
      expect((control as HTMLInputElement | HTMLTextAreaElement).value).toBe('');
      expect(control.getAttribute('value') ?? '').toBe('');
    }

    // And nothing whose type carries a number by definition: a range or a
    // spinner holds a figure the athlete never set.
    expect(within(panel).queryAllByRole('slider')).toEqual([]);
    expect(within(panel).queryAllByRole('spinbutton')).toEqual([]);
  });

  /**
   * The other half of the same rule: a control that starts empty still must
   * not put anything of its own on the session. Every control the panel
   * offers is answered first, so that a new one cannot ride along unnoticed,
   * and then the whole check-in body is pinned -- the athlete's words are the
   * only thing of theirs in it.
   */
  test('nothing but the note the athlete typed reaches the check-in that is sent', async () => {
    await renderWorkspace();
    await screen.findByLabelText(PRE_CHECK_IN_NOTE);

    for (const control of Array.from(sessionLogPanel().querySelectorAll('input, select, textarea'))) {
      if (control instanceof HTMLSelectElement) {
        const last = control.options[control.options.length - 1];
        fireEvent.change(control, { target: { value: last ? last.value : '' } });
      } else if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
        fireEvent.click(control);
      } else {
        fireEvent.change(control, { target: { value: 'Left hand is stiff.' } });
      }
    }

    fireEvent.click(screen.getByRole('button', { name: 'Check In' }));
    await waitFor(() => expect(postedTo('/api/pilot/sessions')).toHaveLength(1));
    const body = postedTo('/api/pilot/sessions')[0].body;

    // The shape of a check-in, pinned whole: no tenth field carrying a
    // readiness, a band, or anything else read off a control.
    expect(Object.keys(body).sort()).toEqual([
      'athlete_id',
      'completed_flag',
      'created_at',
      'date',
      'notes',
      'rpe',
      'rpe_method',
      'session_id',
      'updated_at',
    ]);
    expect(body.notes).toBe('Left hand is stiff.');
    expect(body.rpe).toBeNull();
    expect(body.rpe_method).toBe('UNKNOWN');
  });

  test('the summary says the wellness check is not a clearance', async () => {
    await renderWorkspace();

    await waitFor(() => expect(within(wellnessTile()).getByText('Recorded today')).toBeTruthy());
    expect(within(wellnessTile()).getByText(/Not a clearance\./)).toBeTruthy();
    // The old tile's line was about the slider's number, and went with it.
    expect(screen.queryByText(/Not a clearance -- your workout does not change with it/)).toBeNull();
  });

  test.each([
    ['recorded', () => undefined, 'Recorded today'],
    ['not recorded', () => { storedCheckIn = null; }, 'Not recorded today'],
    ['unavailable', () => { checkInReadFails = true; }, 'Unavailable'],
    ['still loading', () => { checkInReadPending = true; }, 'Checking...'],
  ])('no wellness state buys a training instruction (%s)', async (_state, arrange, shown) => {
    arrange();
    await renderWorkspace();

    await waitFor(() => expect(within(wellnessTile()).getByText(shown)).toBeTruthy());
    // The three instructions the band used to buy, in any state.
    for (const instruction of ['READY FOR TRAINING', 'MODIFY TRAINING', 'COACH REVIEW REQUIRED']) {
      expect(screen.queryByText(instruction)).toBeNull();
    }
  });

  test('the dashboard help no longer instructs readiness-gated training', async () => {
    await renderWorkspace();
    // Until A-FIN-01 this test never opened the panel. HelpPanel draws its
    // description and lists only when expanded, so every absence below held
    // on a closed panel and would have held with the old lines restored.
    // Expanding mounts its Ask SHADOW button, whose own sign-in read resolves
    // a tick later; let it land inside act.
    const toggle = screen.getByRole('button', { name: /HELP: My Dashboard/ });
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    const help = toggle.parentElement as HTMLElement;

    // Anchored on lines that stay, so the absences cannot pass on a closed panel.
    expect(within(help).getByText('Check in to open your session')).toBeTruthy();
    expect(within(help).getByText(
      'Your daily command center. Check in, see assigned work, report pain, and monitor your progress toward goals.',
    )).toBeTruthy();

    expect(within(help).queryByText(/Check your readiness status first thing/)).toBeNull();
    expect(within(help).queryByText(/Ignoring LOW readiness/)).toBeNull();
    // The stale pointer at the Bio Check-In surface, which is intentionally
    // unreachable because it persists nothing. An instruction to go complete
    // it was a promise the app cannot keep.
    expect(within(help).queryByText(/Complete biological check-in/)).toBeNull();
    // A-FIN-01: "Say how you feel" described the removed check-in slider. The
    // Dashboard asks nothing about how the athlete feels any more -- that is
    // the Wellness check -- so its help may not claim it does. Scoped to the
    // panel: the Today header says it too, and truthfully, since Today holds
    // Wellness.
    expect(within(help).queryByText(/Say how you feel/)).toBeNull();
    expect(within(help).queryAllByText(/readiness/i)).toEqual([]);

    // The old authority vocabulary is gone with it.
    expect(screen.queryByText('Current Readiness')).toBeNull();
    expect(screen.queryByLabelText('Readiness to Train (1-10)')).toBeNull();
    expect(screen.queryByText('Pre-Session Self-Report')).toBeNull();
  });
});

// A-FIN-01: HONEST PRE-SESSION INPUT. The Session Log's only pre-session input
// was a readiness slider initialised with useState(8), so an athlete who
// touched nothing had "8/10 · GREEN" on their summary and "Auto check-in
// readiness GREEN" written on their session as if they had said it. These pin
// the replacement contract:
//   - the session note is the athlete's words exactly (trimmed), or ONE fixed
//     system placeholder that exists only because pilot.sessions requires a
//     non-empty note -- never a band, a wellness answer or an effort;
//   - the placeholder is never shown back as something the athlete wrote, on
//     the open session or in their history, and the historical readiness
//     markers are still recognised the same way (those rows are not rewritten);
//   - check-in still writes rpe null / UNKNOWN, and writes nothing but the
//     session -- no wellness record, no readiness row;
//   - the Floor gate is still today's wellness check and nothing else.
describe('A-FIN-01: the session note is the athlete\'s words, or a placeholder that says so', () => {
  test('a note written before check-in is stored exactly as the athlete wrote it, trimmed', async () => {
    await renderWorkspace();

    const body = await checkInFromSessionLog('   Left wrist still sore from Tuesday.  \n');
    expect(body.notes).toBe('Left wrist still sore from Tuesday.');
    expect(body.rpe).toBeNull();
    expect(body.rpe_method).toBe('UNKNOWN');

    // The same words are the open session's notes, already saved -- nothing
    // written before pressing Check In is lost at it.
    openTab('Dashboard');
    const box = (await screen.findByPlaceholderText(/Session notes for your coach/)) as HTMLTextAreaElement;
    expect(box.value.trim()).toBe('Left wrist still sore from Tuesday.');
    expect(screen.getByText(/What you wrote stays put/)).toBeTruthy();
  });

  test('check-in without a note stores the fixed placeholder and invents no readiness', async () => {
    await renderWorkspace();

    const body = await checkInFromSessionLog();
    // Non-empty, as the session contract requires -- and the one sentence
    // that satisfies it, built from nothing the athlete did or did not say.
    expect(body.notes).toBe(NO_NOTE_PLACEHOLDER);
    expect(JSON.stringify(body)).not.toMatch(/readiness|\b(GREEN|YELLOW|RED)\b/);
    expect(body.rpe).toBeNull();
    expect(body.rpe_method).toBe('UNKNOWN');

    // On the open session it is not the athlete's text: their box is empty,
    // and the sentence is not on screen.
    openTab('Dashboard');
    const box = (await screen.findByPlaceholderText(/Session notes for your coach/)) as HTMLTextAreaElement;
    expect(box.value).toBe('');
    expect(screen.queryByText(NO_NOTE_PLACEHOLDER)).toBeNull();
    expect(screen.getByText('Anything you write here saves as you go.')).toBeTruthy();
  });

  test('a note of only spaces is no note: the placeholder, not an empty string', async () => {
    await renderWorkspace();

    const body = await checkInFromSessionLog('   \n  ');
    expect(body.notes).toBe(NO_NOTE_PLACEHOLDER);
  });

  test('an untouched session keeps the placeholder through check-out, and it never becomes an RPE', async () => {
    await renderWorkspace();

    await checkInFromSessionLog();
    openTab('Dashboard');
    fireEvent.click(await screen.findByRole('button', { name: 'Check Out' }));
    await waitFor(() => expect(postedTo('/api/pilot/sessions/update')).toHaveLength(1));

    const [checkOut] = postedTo('/api/pilot/sessions/update');
    // Still non-empty, and still the system's sentence rather than one the
    // athlete is credited with.
    expect(checkOut.body.notes).toBe(NO_NOTE_PLACEHOLDER);
    expect(checkOut.body.rpe).toBeNull();
    expect(checkOut.body.rpe_method).toBe('UNKNOWN');
    expect(await screen.findByText('Logged. That one is on your card.')).toBeTruthy();
  });

  test('Your Last Sessions shows the placeholder and every historic marker as no note, and real notes as written', async () => {
    const completed = (id: string, notes: string, createdAt: string) => openSessionRow({
      session_id: id,
      notes,
      completed_flag: true,
      created_at: createdAt,
      updated_at: createdAt,
    });
    storedSessions = [
      completed('session_e', NO_NOTE_PLACEHOLDER, '2026-08-05T17:00:00.000Z'),
      completed('session_d', 'Auto check-in readiness GREEN', '2026-08-04T17:00:00.000Z'),
      completed('session_c', 'Auto check-in readiness YELLOW', '2026-08-03T17:00:00.000Z'),
      completed('session_b', 'Auto check-in readiness RED', '2026-08-02T17:00:00.000Z'),
      completed('session_a', 'Hands were down in round three.', '2026-08-01T17:00:00.000Z'),
    ];
    await renderWorkspace();

    const history = (await screen.findByText('Your Last Sessions')).parentElement as HTMLElement;
    const rows = within(history).getAllByRole('listitem').map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.endsWith('No notes on this one.'))).toHaveLength(4);
    expect(rows.some((row) => row.endsWith('Hands were down in round three.'))).toBe(true);
    // The system's sentences are never printed as the athlete's.
    expect(rows.some((row) => row.includes(NO_NOTE_PLACEHOLDER))).toBe(false);
    expect(rows.some((row) => row.includes('Auto check-in readiness'))).toBe(false);
  });

  test('a session check-in writes the session and nothing else: no wellness record, no readiness row', async () => {
    await renderWorkspace();

    await checkInFromSessionLog('Ready when you are.');
    expect(postedTo('/api/pilot/athlete/check-in')).toHaveLength(0);
    expect(fetchCalls.filter((call) => /readiness/i.test(call.url))).toEqual([]);
  });

  test('the Floor gate is still the wellness check alone: a session note does not open it', async () => {
    // Owner-approved gate (2026-08-28): the day's work opens on today's
    // wellness check. Writing a note and checking in to a session is not
    // that, so the athlete is sent to Wellness and the Floor stays gated.
    storedCheckIn = null;
    await renderWorkspace();

    await checkInFromSessionLog('Shoulder feels fine today.');
    await waitFor(() => expect(openSurface()).toBe('Wellness'));
    openTab('Floor');
    expect(await screen.findByRole('button', { name: 'Go to check in' })).toBeTruthy();
  });
});

// A-FIN-01: the summary's wellness tile. It replaced "Your Self-Report · 8/10 ·
// GREEN", and it is a read of the wellness record's PRESENCE today -- never of
// what is in it. Only a read that answered may say "not recorded"; a read in
// flight or one that failed says so instead, the same rule the Open Coach Work
// tile beside it keeps.
describe('the summary says whether today\'s wellness is on record, never a score', () => {
  function wellnessTile(): HTMLElement {
    return screen.getByText("Today's Wellness").parentElement as HTMLElement;
  }

  test('a check-in on record reads as recorded, and none of its answers are read back', async () => {
    storedCheckIn = {
      ...checkedInRecord(),
      energy: 4,
      soreness: 2,
      focus: 5,
      motivation: 3,
      sleep_hours: 7,
    };
    await renderWorkspace();

    await waitFor(() => expect(within(wellnessTile()).getByText('Recorded today')).toBeTruthy());
    // No score, no average, no percentage: the tile carries no number at all.
    expect(wellnessTile().textContent ?? '').not.toMatch(/\d|%/);
  });

  test('no check-in today reads as not recorded -- said by a read that answered', async () => {
    storedCheckIn = null;
    await renderWorkspace();

    await waitFor(() => expect(within(wellnessTile()).getByText('Not recorded today')).toBeTruthy());
  });

  test('a read still in flight says Checking..., and is not a false absence', async () => {
    checkInReadPending = true;
    await renderWorkspace();

    expect(within(wellnessTile()).getByText('Checking...')).toBeTruthy();
    expect(within(wellnessTile()).queryByText('Not recorded today')).toBeNull();
    expect(within(wellnessTile()).queryByText('Recorded today')).toBeNull();
  });

  test('a failed read says Unavailable, and is not "not recorded"', async () => {
    checkInReadFails = true;
    await renderWorkspace();

    await waitFor(() => expect(within(wellnessTile()).getByText('Unavailable')).toBeTruthy());
    expect(within(wellnessTile()).queryByText('Not recorded today')).toBeNull();
  });

  test('an account with no athlete record is Unavailable, not "not recorded"', async () => {
    authenticated = false;
    await renderWorkspace();

    await waitFor(() => expect(within(wellnessTile()).getByText('Unavailable')).toBeTruthy());
    expect(within(wellnessTile()).queryByText('Not recorded today')).toBeNull();
  });

  test('saving today\'s wellness check turns the tile to recorded -- the durable self-report is the one it reads', async () => {
    storedCheckIn = null;
    await renderWorkspace();
    await waitFor(() => expect(within(wellnessTile()).getByText('Not recorded today')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check in' }));

    await waitFor(() => expect(within(wellnessTile()).getByText('Recorded today')).toBeTruthy());
    expect(postedTo('/api/pilot/athlete/check-in')).toHaveLength(1);
  });

  test('nothing on the dashboard derives a readiness value or percentage from wellness', async () => {
    storedCheckIn = { ...checkedInRecord(), energy: 5, soreness: 1, focus: 5, motivation: 5 };
    await renderWorkspace();

    await waitFor(() => expect(within(wellnessTile()).getByText('Recorded today')).toBeTruthy());
    expect(screen.queryAllByText(/readiness/i)).toEqual([]);
    expect(screen.queryByText(/\d+%/)).toBeNull();
    expect(screen.queryByText(/average/i)).toBeNull();
  });

  /* THE TILE WEARS NO STATUS RUNG, IN ANY STATE. Until A-FIN-01 the tile it
     replaced was painted by `readinessColor` in RoleSummaryPanels.tsx -- the
     slider's band as --cleared / --monitor / --restricted -- and
     src/design/readinessRungPolicy.test.ts guarded that mapping by source
     because RoleSummaryPanels had no rendered test. The mapping is gone with
     the band, so this takes over that site as a render check: none of the
     four wellness states is a safety state, so none may borrow a rung, and
     least of all --locked, which is reserved for a clinician's no
     (MEDICALLY_NOT_ALLOWED). Read from the tile and everything inside it, so
     a rung moved onto the value line fails as surely as one on the tile. */
  test.each([
    ['recorded', () => undefined, 'Recorded today'],
    ['not recorded', () => { storedCheckIn = null; }, 'Not recorded today'],
    ['unavailable', () => { checkInReadFails = true; }, 'Unavailable'],
    ['still loading', () => { checkInReadPending = true; }, 'Checking...'],
  ])('the tile borrows no status rung, least of all the locked medical one (%s)', async (_state, arrange, shown) => {
    arrange();
    await renderWorkspace();

    await waitFor(() => expect(within(wellnessTile()).getByText(shown)).toBeTruthy());
    const classes = [wellnessTile(), ...Array.from(wellnessTile().querySelectorAll('*'))]
      .map((element) => element.getAttribute('class') ?? '')
      .join(' ');
    expect(classes).not.toMatch(/--(locked|restricted|monitor|cleared)\b/);
    expect(classes).not.toMatch(/\blocked\b/);
  });
});

// A-FIN-01: the Schedule help promised a readiness restriction -- "Readiness
// RED may limit contact work", "Booking contact work with RED readiness" --
// off the removed slider's band, which nothing (the scheduler included) ever
// applied. Nothing readiness-based replaces it.
describe('the Schedule help claims no readiness restriction', () => {
  test('the help lists no readiness rule, and keeps what is still true', async () => {
    await renderWorkspace();
    openTab('Schedule');
    // Expanding the panel mounts its Ask SHADOW button, whose own sign-in
    // read resolves a tick later; let it land inside act.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /HELP: Schedule Session/ }));
      await Promise.resolve();
    });

    // Anchored on a line that stays, so the absence cannot pass on a closed panel.
    expect(screen.getByText('Booking while on academic hold')).toBeTruthy();
    expect(screen.queryByText(/Readiness RED may limit contact work/)).toBeNull();
    expect(screen.queryByText(/Booking contact work with RED readiness/)).toBeNull();
    expect(screen.queryAllByText(/readiness/i)).toEqual([]);
  });
});

// The wellness check-in: the surface that came back because something now
// stores what it collects.
//
// These cases are deliberately about the two things that would make it a
// promise it does not keep -- a skipped question recorded as an opinion, and
// a gate that locks a child out of their own work.
describe('the wellness check-in', () => {
  test('is the first thing Today opens on', async () => {
    // Owner decision 2026-08-28: "wellness and bios should be the first screen
    // that opens, to encourage use". The tab list decides this, not
    // openingTabFor's comment -- which claimed the opposite for months while
    // the list said otherwise.
    storedCheckIn = null;
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));

    expect(await screen.findByRole('button', { name: 'Check in' })).toBeTruthy();
  });

  test('a skipped question is ABSENT from the request, never defaulted into it', async () => {
    // THE RULE THE OLD PANEL COULD NOT KEEP. Its sliders were range inputs, so
    // they always had a position -- 8, 7, 2 and 8 -- whether or not the child
    // touched them. Any save would have recorded four opinions nobody held.
    //
    // Asserted on the REQUEST BODY rather than on the controls: the contract's
    // rule is about what gets stored, and a UI that merely looked unanswered
    // while sending a middle value would satisfy any assertion about pixels.
    storedCheckIn = null;
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check in' }));

    await waitFor(() => expect(postedTo('/api/pilot/athlete/check-in').length).toBe(1));
    const body = postedTo('/api/pilot/athlete/check-in')[0].body as Record<string, unknown>;

    // A bare check-in is a real check-in: "I'm here" on its own is valid.
    expect(body).toEqual({});
    for (const key of ['energy', 'soreness', 'focus', 'motivation', 'sleep_hours']) {
      expect(Object.hasOwn(body, key)).toBe(false);
    }
  });

  test('an answered question is sent as the number the athlete actually chose', async () => {
    storedCheckIn = null;
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    // Chosen by its DESCRIPTION, not by a bare number -- which is the owner's
    // requirement ("they need a description on what each number represents")
    // asserted as behaviour rather than as the presence of some text.
    fireEvent.click(await screen.findByRole('button', { name: /How much energy do you have\? 4: Good/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));

    await waitFor(() => expect(postedTo('/api/pilot/athlete/check-in').length).toBe(1));
    expect(postedTo('/api/pilot/athlete/check-in')[0].body).toEqual({ energy: 4 });
  });

  test('the day’s work is locked until the athlete checks in, and nothing else is', async () => {
    // Owner decision: they have to check in to see that day's workout and
    // tasks, and it must not block any other tool or capability.
    storedCheckIn = null;
    await renderWorkspace();

    openTab('Floor');
    expect(await screen.findByRole('button', { name: 'Go to check in' })).toBeTruthy();

    // ...and the rest of the workspace is untouched. Drills and Goals are the
    // cheap half of this; Messages matters most, because a child who needs to
    // tell someone something must never have to fill in a form first.
    openTab('Drills');
    expect(await screen.findByText(/have not added any reference drills/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Development' }));
    expect(screen.getByRole('button', { name: '+ New SMART Goal' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
    expect(screen.queryByRole('button', { name: 'Go to check in' })).toBeNull();
  });

  test('a check-in that could not be READ opens the floor instead of locking it', async () => {
    // FAILS OPEN, deliberately. A child who checked in this morning must never
    // be told to do it again because a fetch failed -- and a floor locked by an
    // error is worse than an ungated one. The gate is an encouragement, not a
    // security boundary: it protects no data, and the server decides what it
    // serves regardless of what this renders.
    checkInReadFails = true;
    await renderWorkspace();

    openTab('Floor');

    expect(screen.queryByRole('button', { name: 'Go to check in' })).toBeNull();
  });

  test('once checked in, the floor is open and the form is not offered again', async () => {
    await renderWorkspace();

    openTab('Floor');
    expect(screen.queryByRole('button', { name: 'Go to check in' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(await screen.findByText(/Already checked in today/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull();
  });

  test('an account with no athlete record is told so, not left loading forever', async () => {
    // A DEFECT FOUND BY RE-READING THE DIFF, not by a failing test.
    //
    // loadCheckIn returned early when there was no athlete id -- which is what
    // every sibling loader in this component does -- but this one's loading
    // flag is RENDERED. The Wellness tab would have sat on "Loading your
    // check-in..." for the whole session, describing a request that was never
    // going to be made.
    //
    // The floor must also open in this state: nothing here knows whether this
    // person checked in, and a floor locked on an unknown is exactly what the
    // gate's fail-open rule exists to prevent.
    authenticated = false;
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(await screen.findByText(/not linked to an athlete record/)).toBeTruthy();
    expect(screen.queryByText(/Loading your check-in/)).toBeNull();

    openTab('Floor');
    expect(screen.queryByRole('button', { name: 'Go to check in' })).toBeNull();
  });

  test('a stored null reads as not reported, never as a zero or a middle', async () => {
    // The fixture stores a check-in with every wellness value null, which is
    // the normal state. A component that rendered null as 0 or 3 would show a
    // child an opinion they never gave.
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));

    const line = await screen.findByText(/checked in without answering the questions/);
    // Scoped to the check-in panel. An earlier draft asserted no '0' anywhere
    // on the page and failed on a stat tile showing a REAL measured zero --
    // which is the distinction this whole case is about, so asserting it
    // page-wide was testing the opposite of the property.
    const panel = line.closest('div');
    expect(panel).not.toBeNull();
    expect(within(panel!).queryByText('0')).toBeNull();
    expect(within(panel!).queryByText('3')).toBeNull();
  });
});
