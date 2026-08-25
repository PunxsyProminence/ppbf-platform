/**
 * @jest-environment jsdom
 */

// The athlete workspace is the one surface a minor sees as "their" data, so the
// two failure modes covered here are the ones that mislead hardest: a tile or a
// tab that states something the backend never said, and a control that looks
// like it did something it did not.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
let storedGoals: Array<Record<string, unknown>> = [];
let goalUpdateFails = false;
let storedFloorPlans: Array<Record<string, unknown>> = [];
let floorPlanPatchFails = false;
let storedAssignments: Array<Record<string, unknown>> = [];
let assignmentsFail = false;

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

function patchedTo(path: string): FetchCall[] {
  return fetchCalls.filter((call) => call.method === 'PATCH' && call.url.endsWith(path));
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
  storedGoals = [];
  goalUpdateFails = false;
  storedFloorPlans = [];
  floorPlanPatchFails = false;
  storedAssignments = [];
  assignmentsFail = false;

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, method: init?.method ?? 'GET', body: parseBody(init) });

    if (url.includes('/api/pilot/shadow/formulas/observations') && painObservationResponse) {
      return painObservationResponse;
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
      return jsonResponse(sessionUpdateFails ? { error: 'Internal server error' } : { ok: true }, !sessionUpdateFails);
    }
    if (url.includes('/api/pilot/goals/list')) {
      return jsonResponse({ items: storedGoals });
    }
    // Must be matched before the bare /api/pilot/goals branch below, which is
    // held open on purpose for the double-click test.
    if (url.includes('/api/pilot/goals/update')) {
      return jsonResponse(goalUpdateFails ? { error: 'Internal server error' } : { ok: true }, !goalUpdateFails);
    }
    if (url.includes('/api/pilot/floor-plans')) {
      if (init?.method === 'PATCH') {
        return jsonResponse(floorPlanPatchFails ? { error: 'Internal server error' } : { ok: true }, !floorPlanPatchFails);
      }
      if (init?.method === 'POST') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ items: storedFloorPlans });
    }
    if (url.includes('/api/pilot/progression/assignments')) {
      if (assignmentsFail) {
        throw new Error('assignments offline');
      }
      return jsonResponse({ items: storedAssignments });
    }
    if (url.includes('/api/pilot/shadow/observation-projection')) {
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

describe('athlete workspace honesty', () => {
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
  async function openPainReport() {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('Body location'), { target: { value: 'Neck' } });
    fireEvent.click(screen.getByRole('button', { name: 'Report Pain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  }

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
    // Check-in sends the athlete to their floor plan; the session log they
    // check out from is back on the dashboard.
    openTab('Dashboard');
    const notes = await screen.findByPlaceholderText(/Session notes for your coach/);
    await waitFor(() => expect(postedTo('/api/pilot/sessions')).toHaveLength(1));

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
  test('the automatic check-in note is not returned as the athlete own notes', async () => {
    storedSessions = [openSessionRow({ notes: 'Auto check-in readiness GREEN' })];
    await renderWorkspace();

    await screen.findByRole('button', { name: 'Check Out' });
    expect((screen.getByPlaceholderText(/Session notes for your coach/) as HTMLTextAreaElement).value).toBe('');
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
    expect(screen.getByText('Pre-Session Self-Report')).toBeTruthy();
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

  test.each(['Weight Loss', 'Weight Gain'])('%s is not offered, and the form says where it goes instead', async (category) => {
    await openGoals();
    fireEvent.click(screen.getByRole('button', { name: '+ New SMART Goal' }));

    const options = Array.from(
      (screen.getByLabelText('Goal category') as HTMLSelectElement).options,
    ).map((option) => option.value);
    expect(options).not.toContain(category);
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

  test('the floor plan says where it comes from instead of showing a count of nothing', async () => {
    // The plan is generated at check-in from the athlete's own readiness, so
    // before check-in there is genuinely nothing yet. "0 tasks" would be a
    // claim about an empty plan; there is no plan.
    await renderWorkspace();

    expect(screen.getByText('Built for you when you check in.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open the floor' })).toBeNull();
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

// The floor checkbox moved React state alone: an athlete ticked their work
// off, reloaded, and the floor came back untouched. Completion lives on the
// stored plan now (PATCH /api/pilot/floor-plans), and these pin the three
// claims that has to hold up: the tick is written, the tick comes back, and a
// refused write is never left on screen looking saved.
function storedFloorPlan(tasks: Array<Record<string, unknown>>) {
  return {
    athleteName: 'Test Athlete',
    readiness: 'GREEN',
    generatedAt: '2026-08-20T17:00:00.000Z',
    tasks,
  };
}

function floorTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf_1',
    title: 'Technical Boxing Block',
    category: 'Training',
    description: 'Footwork progression.',
    dueDate: '5:30 PM',
    priority: 'High',
    ...overrides,
  };
}

describe('the floor survives a reload', () => {
  test('ticking a task off writes it to the stored plan', async () => {
    storedFloorPlans = [storedFloorPlan([floorTask()])];
    await renderWorkspace();
    openTab('Floor');

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Mark done: Technical Boxing Block' }));

    await waitFor(() => expect(patchedTo('/api/pilot/floor-plans')).toHaveLength(1));
    // task_id and the flag, nothing else -- above all no athlete_id, which the
    // route must take from the session, never from this body.
    expect(patchedTo('/api/pilot/floor-plans')[0].body).toEqual({ task_id: 'wf_1', completed: true });
    expect(await screen.findByText('Marked done: Technical Boxing Block.')).toBeTruthy();
  });

  test('a task ticked off before a reload comes back ticked', async () => {
    storedFloorPlans = [storedFloorPlan([
      floorTask({ completed: true }),
      floorTask({ id: 'wf_2', title: 'Cooldown + Session Journal' }),
    ])];
    await renderWorkspace();
    openTab('Floor');

    const done = await screen.findByRole('checkbox', { name: 'Mark done: Technical Boxing Block' }) as HTMLInputElement;
    expect(done.checked).toBe(true);
    // A task with no stored flag is not done -- absent must not read as true.
    const open = screen.getByRole('checkbox', { name: 'Mark done: Cooldown + Session Journal' }) as HTMLInputElement;
    expect(open.checked).toBe(false);
  });

  test('a refused write puts the box back and says nothing was saved', async () => {
    storedFloorPlans = [storedFloorPlan([floorTask()])];
    floorPlanPatchFails = true;
    await renderWorkspace();
    openTab('Floor');

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Mark done: Technical Boxing Block' }));

    expect(await screen.findByText(/the box went back to where it was/)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Mark done: Technical Boxing Block' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText(/Marked done/)).toBeNull();
  });
});

// The drills a coach assigned lived at /athlete/progression-intelligence,
// reachable from this workspace only through a collapsed <details> at the foot
// of the page. Today now carries the count and the door.
describe('Today shows the work a coach assigned', () => {
  test('open assignments are counted for the athlete the session names, and the card links out', async () => {
    storedAssignments = [
      { assignment_id: 'as-1', status: 'assigned' },
      { assignment_id: 'as-2', status: 'in_progress' },
      // Finished work is record, not today.
      { assignment_id: 'as-3', status: 'completed' },
    ];
    await renderWorkspace();

    expect(await screen.findByText('2 still to do.')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open your progression' });
    expect(link.getAttribute('href')).toBe('/athlete/progression-intelligence');

    const asked = fetchCalls.find((call) => call.url.includes('/api/pilot/progression/assignments'));
    expect(asked?.url).toContain('athlete_id=ath_test');
  });

  test('no assignments reads as none recorded, not as zero', async () => {
    await renderWorkspace();

    expect(await screen.findByText('No assigned work recorded.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open your progression' })).toBeTruthy();
  });

  test('a failed read is reported as unavailable, never as no work assigned', async () => {
    assignmentsFail = true;
    await renderWorkspace();

    expect(await screen.findByText('Not available right now.')).toBeTruthy();
    expect(screen.queryByText('No assigned work recorded.')).toBeNull();
  });
});

// Three surfaces carried nothing behind them: Bio Check-In persisted no field
// (nothing calls /api/pilot/athlete/check-in), Tracks had every value reading
// "Nobody has written this down yet", and Assessments said NOT BUILT YET over
// a disabled button. A tab is a promise that there is something behind it, so
// they are no longer offered; the panels stay in the file for when they earn
// their entry back.
describe('tabs with nothing behind them are not offered', () => {
  test('Bio Check-In, Tracks and Assessments are gone from the nav', async () => {
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.queryByRole('button', { name: 'Bio Check-In' })).toBeNull();

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
    // The honest-empty grammar appears both in the panel and as the sync
    // message loadFloorTasks sets, so this asserts presence, not uniqueness.
    expect((await screen.findAllByText(/Nothing on your floor yet/)).length).toBeGreaterThan(0);

    openTab('Drills');
    expect(await screen.findByText(/have not added any drills yet/)).toBeTruthy();

    openTab('Schedule');
    expect(screen.getByRole('link', { name: 'Open Unified Scheduler' })).toBeTruthy();
  });

  /* The empty floor names the action that fills it. Until the approved board
     (AF-09) gave this state the room it has now, it named check-in in a single
     grey line and offered no way to do it -- the athlete had to work out for
     themselves that the control lives on another tab. */
  test('an empty floor offers the check-in that fills it', async () => {
    await renderWorkspace();

    openTab('Floor');
    await screen.findAllByText(/Nothing on your floor yet/);

    expect(screen.getByRole('button', { name: 'Check In' })).toBeTruthy();
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
    // The readiness slider still exists and still bands the check-in note. What
    // it must never do again is reach pilot.sessions.rpe. A number here would
    // be that regression whatever its value, so the assertion is on the type.
    await renderWorkspace();

    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    await waitFor(() => expect(postedTo('/api/pilot/sessions')).toHaveLength(1));

    const [checkIn] = postedTo('/api/pilot/sessions');
    expect(typeof checkIn.body.rpe).not.toBe('number');
  });
});

// READINESS IS A RECORD, NOT A PRESCRIPTION. The check-in slider is a 1-10
// self-report whose method nothing has validated -- readinessProvenance.ts is
// explicit that NO readiness method passes the established
// reliability/validity bar -- so its band may be written down, and may not
// decide what training is generated, shown, or sent. Check-in used to hand
// the band to buildWorkoutFloorTasks, which bought GREEN athletes a
// 'High-output intervals' conditioning finisher and everyone else reduced
// work, then stamped the band (and a client-supplied athleteName) on the
// stored plan a coach surface displayed as individualized work. These pin
// both halves of the fix: the work is identical whatever the slider says,
// and the band still lands on the session note, where a record belongs.
describe('the readiness slider cannot change the prescribed work', () => {
  async function checkInWithSlider(value: number) {
    await renderWorkspace();
    fireEvent.change(screen.getByLabelText('How ready do you feel today? (1-10)'), {
      target: { value: String(value) },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
    await waitFor(() => expect(postedTo('/api/pilot/floor-plans')).toHaveLength(1));
    await waitFor(() => expect(postedTo('/api/pilot/sessions')).toHaveLength(1));
    return {
      plan: postedTo('/api/pilot/floor-plans')[0].body,
      session: postedTo('/api/pilot/sessions')[0].body,
    };
  }

  // Task ids and due times carry the check-in clock, so two check-ins made at
  // different moments legitimately differ there. The comparison is on the
  // prescriptive content: what work, in which words, at what priority.
  function workContentOf(planBody: Record<string, unknown>) {
    const plan = planBody.plan as { tasks: Array<Record<string, unknown>> };
    return plan.tasks.map(({ title, category, description, priority, linkedGoalId }) => (
      { title, category, description, priority, linkedGoalId }
    ));
  }

  test('check-ins at 3 and at 9 submit identical work, differing only in the recorded band', async () => {
    const low = await checkInWithSlider(3);
    cleanup();
    fetchCalls.length = 0;
    const high = await checkInWithSlider(9);

    expect(workContentOf(low.plan)).toEqual(workContentOf(high.plan));

    // The record still moves -- on the session's auto check-in note, and
    // nowhere else. The slider staying a live self-report is the point: it is
    // kept as a record precisely so that removing its authority over the work
    // does not quietly remove the athlete's voice too.
    expect(low.session.notes).toBe('Auto check-in readiness RED');
    expect(high.session.notes).toBe('Auto check-in readiness GREEN');
  });

  test('no intensity escalation is reachable from the slider', async () => {
    // 10 is the value that used to buy the GREEN branch: a 'Conditioning
    // Finisher' prescribing 'High-output intervals: 6 rounds x 90s on / 60s
    // active recovery'. No slider value may buy an intensity prescription now.
    await checkInWithSlider(10);

    const everySentBody = JSON.stringify(fetchCalls.map((call) => call.body));
    expect(everySentBody).not.toContain('High-output');
    expect(everySentBody).not.toContain('Conditioning Finisher');
    expect(screen.queryByText(/High-output/)).toBeNull();
  });

  test('the stored plan carries no client-supplied identity and no readiness classification', async () => {
    const { plan } = await checkInWithSlider(8);
    const stored = plan.plan as Record<string, unknown>;

    // The route resolves who the athlete is from the session principal. The
    // client literal that used to travel here ('Current Athlete') was rendered
    // by the coach workspace as if it were an athlete's identity.
    expect(stored.athleteName).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain('Current Athlete');

    // And the band stays off the stored plan: stamping an unvalidated
    // self-report's band on a plan presents the plan as derived from a
    // measurement (readinessProvenance.ts -- no such measurement exists).
    expect(stored.readiness).toBeUndefined();
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
    // no code read. The slider assertion keeps this from passing vacuously on
    // the wrong screen: same card, one control present, the dead one gone.
    await renderWorkspace();

    expect(screen.getByLabelText('How ready do you feel today? (1-10)')).toBeTruthy();
    expect(screen.queryByLabelText('Session Duration (minutes)')).toBeNull();
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

// THE SLIDER'S PRESENTATION MAY NOT OUT-CLAIM ITS AUTHORITY. #597 removed the
// check-in slider's power over the generated work, but the copy around it kept
// the old voice: a card headed "Current Readiness" over a "Readiness to Train"
// slider, help text ordering a morning readiness check and warning against
// "ignoring LOW readiness scores before intense training", and a summary tile
// translating the band into an instruction (READY FOR TRAINING / MODIFY
// TRAINING / COACH REVIEW REQUIRED). All of that told a child their 1-10
// governs training when it decides nothing. These pin the honest presentation:
// the number they chose is read back, the screen says outright that it neither
// clears them nor changes the work, and no band buys an instruction. The band
// word itself survives only as the descriptor of what they reported -- the
// stored note format is pinned separately above and is deliberately untouched.
describe('the check-in slider presents as a self-report, not a clearance', () => {
  const SLIDER_LABEL = 'How ready do you feel today? (1-10)';

  test('the number the athlete chose is shown back to them', async () => {
    await renderWorkspace();

    fireEvent.change(screen.getByLabelText(SLIDER_LABEL), {
      target: { value: '4' },
    });

    // At the control, and again on the summary tile -- their number, not a
    // platform verdict derived from it.
    expect(screen.getByText('4/10')).toBeTruthy();
    expect(screen.getByText('4/10 · RED')).toBeTruthy();
  });

  test('the screen states that the report neither clears the athlete nor changes the work', async () => {
    await renderWorkspace();

    // At the slider itself, not buried in a help panel. The sentence is the
    // owner's own (2026-08-24), pinned verbatim.
    expect(
      screen.getByText(/It does not medically clear you and does not determine your workout/)
    ).toBeTruthy();
    // And on the summary tile.
    expect(
      screen.getByText(/Not a clearance -- your workout does not change with it/)
    ).toBeTruthy();
  });

  test('no slider value buys a training instruction', async () => {
    await renderWorkspace();

    // Default 8 is the GREEN band: the tile used to say READY FOR TRAINING.
    expect(screen.getByText('8/10 · GREEN')).toBeTruthy();
    expect(screen.queryByText('READY FOR TRAINING')).toBeNull();

    // 5 is the YELLOW band: it used to say MODIFY TRAINING.
    fireEvent.change(screen.getByLabelText(SLIDER_LABEL), { target: { value: '5' } });
    expect(screen.getByText('5/10 · YELLOW')).toBeTruthy();
    expect(screen.queryByText('MODIFY TRAINING')).toBeNull();

    // 2 is the RED band: it used to say COACH REVIEW REQUIRED.
    fireEvent.change(screen.getByLabelText(SLIDER_LABEL), { target: { value: '2' } });
    expect(screen.getByText('2/10 · RED')).toBeTruthy();
    expect(screen.queryByText('COACH REVIEW REQUIRED')).toBeNull();
  });

  test('the dashboard help no longer instructs readiness-gated training', async () => {
    await renderWorkspace();

    expect(screen.queryByText(/Check your readiness status first thing/)).toBeNull();
    expect(screen.queryByText(/Ignoring LOW readiness/)).toBeNull();
    // The stale pointer at the Bio Check-In surface, which is intentionally
    // unreachable because it persists nothing. An instruction to go complete
    // it was a promise the app cannot keep.
    expect(screen.queryByText(/Complete biological check-in/)).toBeNull();

    // The old authority vocabulary is gone with it.
    expect(screen.queryByText('Current Readiness')).toBeNull();
    expect(screen.queryByLabelText('Readiness to Train (1-10)')).toBeNull();
  });
});
