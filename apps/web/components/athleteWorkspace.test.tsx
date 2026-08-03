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

function openTab(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('athlete workspace honesty', () => {
  test('the Next Session tile does not name a class the backend never returned', async () => {
    await renderWorkspace();

    expect(screen.queryByText(/Youth Class 4:00 PM/)).toBeNull();
    expect(screen.getByText('Unavailable - not yet tracked')).toBeTruthy();
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
    const targetDate = document.querySelector('input[type="date"]') as HTMLInputElement;
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
    const targetDate = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(targetDate, { target: { value: '2026-09-01' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));

    // Nothing is written anywhere without a session, so the message must not
    // imply the goal survived.
    await waitFor(() => expect(screen.getByText(/Goal was not saved/)).toBeTruthy());
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
    fireEvent.click(screen.getByRole('button', { name: 'Neck' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  }

  test('a pain report is sent with a kind and unit the observations API accepts', async () => {
    painObservationResponse = jsonResponse({ ok: true, painReport: { coachNotified: true, severity: 'high' } });
    await openPainReport();

    await screen.findByText(/raised for coach review/);
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
    expect(await screen.findByText(/Saved to your session record/)).toBeTruthy();
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

  test('live motivational copy is drawn where the athlete will see it', async () => {
    liveAnnouncements = [announcement()];
    await renderWorkspace();

    expect(await screen.findByText('Hands up, chin down.')).toBeTruthy();
    expect(screen.getByText('From the Gym')).toBeTruthy();
  });

  test('an item placed elsewhere is not drawn here', async () => {
    liveAnnouncements = [announcement({ placement: 'coach_workspace', message: 'Coaches only.' })];
    await renderWorkspace();

    expect(screen.queryByText('Coaches only.')).toBeNull();
    expect(screen.queryByText('From the Gym')).toBeNull();
  });

  test('nothing live leaves no heading and no empty box behind', async () => {
    await renderWorkspace();

    expect(screen.queryByText('From the Gym')).toBeNull();
    expect(screen.queryByText('Gym Notices')).toBeNull();
  });

  test('a failed announcements read leaves the rest of the workspace working', async () => {
    announcementsFail = true;
    await renderWorkspace();

    expect(screen.queryByText('From the Gym')).toBeNull();
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
    await act(async () => {
      openTab('Rabbit Holes');
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
    fireEvent.change(document.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: '2026-09-01' } });
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
