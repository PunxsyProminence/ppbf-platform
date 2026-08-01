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

import { FORMULA_UNITS, OBSERVATION_KINDS } from '@/src/server/pilot/formulas/types';
import type { AnnouncementItem } from './AnnouncementBanner';
import type { RabbitHoleLessonItem } from './RabbitHole';
import AthleteWorkspace from './AthleteWorkspace';

type FetchCall = { url: string; method: string; body: Record<string, unknown> };

const fetchCalls: FetchCall[] = [];
let authenticated = true;
let resolveGoalPost: ((value: unknown) => void) | null = null;
let painObservationResponse: Response | null = null;
let liveAnnouncements: AnnouncementItem[] = [];
let announcementsFail = false;
let rabbitHolesByAnchor: Record<string, RabbitHoleLessonItem[]> = {};
let rabbitHolesFail = false;

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
    if (url.includes('/api/pilot/goals/list')) {
      return jsonResponse({ items: [] });
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

    fireEvent.click(screen.getByRole('button', { name: '✅ Check In' }));
    // Check-in sends the athlete to their floor plan; the session log they
    // check out from is back on the dashboard.
    openTab('Dashboard');
    const notes = await screen.findByPlaceholderText(/Session notes for your coach/);
    await waitFor(() => expect(postedTo('/api/pilot/sessions')).toHaveLength(1));

    fireEvent.change(notes, { target: { value: 'my wrist hurts' } });
    fireEvent.click(screen.getByRole('button', { name: '⏹️ Check Out' }));

    await waitFor(() => expect(postedTo('/api/pilot/sessions/update')).toHaveLength(1));
    const [checkIn] = postedTo('/api/pilot/sessions');
    const [checkOut] = postedTo('/api/pilot/sessions/update');
    expect(checkOut.body).toEqual(expect.objectContaining({
      session_id: checkIn.body.session_id,
      notes: 'my wrist hurts',
      completed_flag: true,
    }));
  });

  test('check-out says the notes went nowhere when no session was stored', async () => {
    authenticated = false;
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: '✅ Check In' }));
    // Check-in sends the athlete to their floor plan; the session log they
    // check out from is back on the dashboard.
    openTab('Dashboard');
    const notes = await screen.findByPlaceholderText(/Session notes for your coach/);
    fireEvent.change(notes, { target: { value: 'my wrist hurts' } });
    fireEvent.click(screen.getByRole('button', { name: '⏹️ Check Out' }));

    await screen.findByText(/Your notes went nowhere/);
    expect(postedTo('/api/pilot/sessions/update')).toHaveLength(0);
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
    expect(screen.getByRole('button', { name: '✅ Check In' })).toBeTruthy();
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
