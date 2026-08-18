/**
 * @jest-environment jsdom
 */

// The athlete workspace is the one surface a minor sees as "their" data, so the
// two failure modes covered here are the ones that mislead hardest: a tile or a
// tab that states something the backend never said, and a control that looks
// like it did something it did not.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

// pilot.sessions stores date as `date` and rpe as `numeric`, so node-postgres
// hands back a timestamp and a string. Both are sent straight back by
// check-out, where the session validator rejects either shape.
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
      return jsonResponse({ items: [] });
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
  'Bio Check-In': 'Today',
  Dashboard: 'Today',
  Floor: 'Today',
  Goals: 'Development',
  Tracks: 'Development',
  Assessments: 'Development',
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
    expect(screen.getByText('Unavailable - not yet tracked')).toBeTruthy();
  });

  // Regression: readinessToTrain used to seed as useState(8), and 8 reads as
  // GREEN ("READY FOR TRAINING") on the summary tile. That made a brand-new
  // athlete who has never touched the readiness slider -- most saliently, a
  // first-day athlete nobody has assessed yet -- indistinguishable from a real
  // 8/10 self-report. Absent must render as absent (see getReadinessLevel in
  // AthleteWorkspace.tsx), never as a fabricated pass reading.
  test('a never-assessed athlete is shown as not yet assessed, never as READY FOR TRAINING', async () => {
    await renderWorkspace();

    expect(screen.getByText('NOT YET ASSESSED')).toBeTruthy();
    expect(screen.queryByText('READY FOR TRAINING')).toBeNull();
    expect(screen.queryByText('MODIFY TRAINING')).toBeNull();
    expect(screen.queryByText('COACH REVIEW REQUIRED')).toBeNull();

    // The My Dashboard readiness slider (readiness-train) is on screen by
    // default here. Its own copy must not claim a real 8/10 reading exists
    // just because the DOM handle needs somewhere to sit.
    expect(screen.getByText('Not reported yet')).toBeTruthy();
  });

  test('the Schedule tab offers the real scheduler instead of unbookable class rows', async () => {
    await renderWorkspace();
    openTab('Schedule');

    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
    expect(screen.queryByText(/Mon-Thu 4:00 PM Youth Class/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Unified Scheduler' })).toBeTruthy();
  });

  test('the Assessments tab does not present a start control that cannot start anything', async () => {
    await renderWorkspace();
    openTab('Assessments');

    const start = screen.getByRole('button', { name: 'Start Assessment' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
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
      rpe: 8,
      date: '2026-08-01',
      created_at: '2026-08-01T17:05:00.000Z',
      notes: 'Left hook felt slow all session, right shoulder tight.',
    }));
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
    expect(screen.getByText('Current Readiness')).toBeTruthy();
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
    expect(screen.getByRole('link', { name: 'Open Film Lane' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Your Progression' })).toBeTruthy();
  });

  test('the sparring log is reachable from the workspace, not only by typing the URL', async () => {
    // /athlete/dashboard/sparring had a real, tested, API-backed form and no
    // link to it anywhere in the app -- only buildingMap.ts's site search
    // knew it existed. This pins the fix, not just that a link renders: the
    // href has to be the real route.
    await renderWorkspace();

    const link = screen.getByRole('link', { name: 'Open Combat Telemetry Log' });
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
