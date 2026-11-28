/**
 * @jest-environment jsdom
 */

/**
 * My Corner mounted in the athlete workspace, fed by the workspace's own reads.
 * athleteCorner.test.tsx pins the corner alone; this pins the wiring:
 *  - the corner's Start training is the one Start training (lane AS-8,
 *    ATH-24, Overwatch Q3 A on #2020); the Session Log keeps its note box;
 *  - the workspace opens on How I feel today with the corner on it (Q1 A), and
 *    Report pain from there opens the Dashboard at the location picker;
 *  - "checked in" follows the session read, and a read in flight or a failed
 *    read is said as that;
 *  - Report pain takes the athlete to the existing Pain/Soreness Report's
 *    location picker, and that report is still the one that files the pain.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: function MockLink({ href, children, ...rest }: { href: string; children: React.ReactNode }) {
    return React.createElement('a', { href, ...rest }, children);
  },
}));

import AthleteWorkspace from './AthleteWorkspace';

type FetchCall = { url: string; method: string; body: Record<string, unknown> };

const fetchCalls: FetchCall[] = [];
let storedSessions: Array<Record<string, unknown>> = [];
let sessionListMode: 'answer' | 'fail' | 'pending' = 'answer';
let checkInPostFails = false;
let activeHold: Record<string, unknown> | null = null;

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

function parseBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

beforeEach(() => {
  fetchCalls.length = 0;
  storedSessions = [];
  sessionListMode = 'answer';
  checkInPostFails = false;
  activeHold = null;
  Element.prototype.scrollIntoView = jest.fn();
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    fetchCalls.push({ url, method, body: parseBody(init) });
    if (url.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, athlete_id: 'ath_test' });
    if (url.includes('/api/pilot/sessions/list')) {
      if (sessionListMode === 'fail') throw new Error('sessions offline');
      if (sessionListMode === 'pending') return new Promise<Response>(() => {});
      return jsonResponse({ items: storedSessions });
    }
    if (url.endsWith('/api/pilot/sessions') && method === 'POST') {
      return checkInPostFails ? jsonResponse({ error: 'Internal server error' }, false) : jsonResponse({ ok: true });
    }
    if (url.includes('/api/pilot/training-holds')) return jsonResponse({ ok: true, hold: activeHold });
    if (url.includes('/api/pilot/athlete/check-in')) return jsonResponse({ today: null, recent: [] });
    if (url.includes('/api/pilot/progression/assignments')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/goals/list')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
    if (url.includes('/api/pilot/drill-library')) return jsonResponse({ drills: [] });
    if (url.includes('/api/pilot/shadow/observation-projection')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/training-attempts')) return jsonResponse({ items: [] });
    return jsonResponse({});
  }) as unknown as typeof fetch;
});

async function renderWorkspace() {
  render(<AthleteWorkspace />);
  await act(async () => {
    await Promise.resolve();
  });
}

const corner = () => within(screen.getByRole('region', { name: 'My Corner' }));

function checkInPosts(): FetchCall[] {
  return fetchCalls.filter((call) => call.method === 'POST' && call.url.endsWith('/api/pilot/sessions'));
}

/** The request body without the fields that are minted per click. */
function stable(body: Record<string, unknown>): Record<string, unknown> {
  const { session_id: _id, created_at: _created, updated_at: _updated, ...rest } = body;
  void _id; void _created; void _updated;
  return rest;
}

test('the corner\'s Start training is the one Start training, and sends the session request', async () => {
  await renderWorkspace();
  // The opening tab, How I feel today, carries the corner (Q1 A).
  fireEvent.click(await corner().findByRole('button', { name: 'Start training' }));
  await waitFor(() => expect(checkInPosts()).toHaveLength(1));
  const fromCorner = checkInPosts()[0].body;
  expect(fromCorner.athlete_id).toBe('ath_test');
  expect(Object.keys(fromCorner).sort()).toEqual(
    ['athlete_id', 'completed_flag', 'created_at', 'date', 'notes', 'rpe', 'rpe_method', 'session_id', 'updated_at'],
  );
  expect(stable(fromCorner)).toEqual(expect.objectContaining({ athlete_id: 'ath_test', completed_flag: false }));
});

test('on the Dashboard the Session Log keeps its note box and offers no second Start training (ATH-24)', async () => {
  await renderWorkspace();
  fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
  const log = within(await screen.findByRole('region', { name: 'Session log' }));
  expect(await log.findByLabelText('Anything your coach should know before you start?')).toBeTruthy();
  expect(log.queryByRole('button', { name: 'Start training' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Start training' })).toHaveLength(1);
  expect(corner().getByRole('button', { name: 'Start training' })).toBeTruthy();
});

test('with a session open today, the corner says checked in and offers no second check-in', async () => {
  const now = new Date().toISOString();
  storedSessions = [{
    session_id: 'session_1', athlete_id: 'ath_test', date: now.slice(0, 10), rpe: null,
    notes: '', completed_flag: false, created_at: now, updated_at: now,
  }];
  await renderWorkspace();
  expect(await corner().findByText(/^Training started /)).toBeTruthy();
  expect(corner().queryByRole('button', { name: 'Start training' })).toBeNull();
});

test('while the session read is in flight, the corner says it is checking -- not "not checked in"', async () => {
  sessionListMode = 'pending';
  await renderWorkspace();
  expect(await corner().findByText('Checking whether your training has started...')).toBeTruthy();
  expect(corner().queryByText('Training has not started today.')).toBeNull();
  expect(corner().queryByRole('button', { name: 'Start training' })).toBeNull();
});

test('a failed session read is said as a failure, and Try again asks the same read again', async () => {
  sessionListMode = 'fail';
  await renderWorkspace();
  expect(await corner().findByText(/Could not tell whether your training has started/)).toBeTruthy();
  expect(corner().queryByText('Training has not started today.')).toBeNull();
  expect(corner().queryByRole('button', { name: 'Start training' })).toBeNull();

  const before = fetchCalls.filter((call) => call.url.includes('/api/pilot/sessions/list')).length;
  sessionListMode = 'answer';
  await act(async () => {
    fireEvent.click(corner().getByRole('button', { name: 'Try again' }));
  });
  const after = fetchCalls.filter((call) => call.url.includes('/api/pilot/sessions/list')).length;
  expect(after).toBe(before + 1);
  expect(await corner().findByText('Training has not started today.')).toBeTruthy();
});

test('Report pain takes the athlete to the existing report\'s location picker, which still files the pain', async () => {
  sessionListMode = 'pending';
  await renderWorkspace();
  fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
  await act(async () => {
    await Promise.resolve();
  });
  const before = fetchCalls.length;

  fireEvent.click(corner().getByRole('button', { name: 'Report pain or soreness' }));

  const picker = document.getElementById('pain-location-select');
  expect(picker).not.toBeNull();
  expect(document.activeElement).toBe(picker);
  expect(document.getElementById('athlete-pain-report')?.contains(picker)).toBe(true);
  // Getting there sent nothing.
  expect(fetchCalls.length).toBe(before);

  // The existing report, unchanged: pick a place, then its own Report Pain.
  fireEvent.change(picker as HTMLSelectElement, { target: { value: 'Shoulders' } });
  fireEvent.click(screen.getByRole('button', { name: 'Report Pain' }));
  expect(await screen.findByRole('heading', { name: 'Soreness Details: Shoulders' })).toBeTruthy();
});

test('Report pain from the opening tab opens the Dashboard at the location picker and writes nothing', async () => {
  sessionListMode = 'pending';
  await renderWorkspace();
  // The workspace opens on How I feel today; the pain card is on the Dashboard.
  expect(screen.getByRole('button', { name: 'How I feel today' }).getAttribute('aria-current')).toBe('page');
  expect(document.getElementById('pain-location-select')).toBeNull();
  const writesBefore = fetchCalls.filter((call) => call.method !== 'GET').length;

  fireEvent.click(corner().getByRole('button', { name: 'Report pain or soreness' }));

  await waitFor(() => expect(document.activeElement?.id).toBe('pain-location-select'));
  expect(screen.getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page');
  expect(document.getElementById('athlete-pain-report')?.contains(document.activeElement)).toBe(true);
  // Getting there wrote nothing (the Dashboard's own reads may run).
  expect(fetchCalls.filter((call) => call.method !== 'GET').length).toBe(writesBefore);
});

test('the old Today section no longer repeats the corner\'s controls below it', async () => {
  await renderWorkspace();
  fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
  // One Start training, the corner's (ATH-24); the old Today section adds none.
  expect(screen.getAllByRole('button', { name: 'Start training' })).toHaveLength(1);
  expect(corner().getAllByRole('button', { name: 'Start training' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Open the floor' })).toHaveLength(1);
});

test('after today\'s session was checked out, the corner says so instead of "not checked in"', async () => {
  const now = new Date().toISOString();
  storedSessions = [{
    session_id: 'session_done', athlete_id: 'ath_test', date: now.slice(0, 10), rpe: '6', rpe_method: 'SESSION_RPE',
    notes: '', completed_flag: true, created_at: now, updated_at: now,
  }];
  await renderWorkspace();
  expect(await corner().findByText(/^Training ended today\./)).toBeTruthy();
  expect(corner().queryByText('Training has not started today.')).toBeNull();
});

test('a check-in that fails says so in the corner', async () => {
  checkInPostFails = true;
  await renderWorkspace();
  fireEvent.click(await corner().findByRole('button', { name: 'Start training' }));
  expect(await corner().findByText(/Training did not start/)).toBeTruthy();
});

test('with a training hold, the hold notice comes right after Report pain, inside the corner', async () => {
  activeHold = {
    scope: 'all_training',
    athlete_explanation: 'Rest the shoulder this week.',
    placed_by_name: 'Coach J.',
    lift_condition_text: null,
  };
  await renderWorkspace();
  const headline = await corner().findByText('Training is paused for you right now');
  const pain = corner().getByRole('button', { name: 'Report pain or soreness' });
  // Document order: the pain button comes first.
  expect(pain.compareDocumentPosition(headline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // And it is shown once, not again above the corner.
  expect(screen.getAllByText('Training is paused for you right now')).toHaveLength(1);
});

/* Lane AS-8 review (AS8-1). Report pain sits right above the How I feel today
   form and opens the Dashboard, which unmounts the form. The athlete's unsaved
   answers are held by the workspace and come back with the form. */
test('unsaved How I feel today answers survive Report pain and the way back, and nothing is written', async () => {
  await renderWorkspace();
  const sore4 = /^How sore are you\? 4:/;
  fireEvent.click(await screen.findByRole('button', { name: sore4 }));
  fireEvent.change(screen.getByLabelText('How many hours did you sleep?'), { target: { value: '7.5' } });

  fireEvent.click(corner().getByRole('button', { name: 'Report pain or soreness' }));
  expect(screen.getByRole('button', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('button', { name: sore4 })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'How I feel today' }));
  expect((await screen.findByRole('button', { name: sore4 })).getAttribute('aria-pressed')).toBe('true');
  expect((screen.getByLabelText('How many hours did you sleep?') as HTMLInputElement).value).toBe('7.5');
  // Kept, not sent: no check-in, pain report or session write.
  const writes = ['/api/pilot/athlete/check-in', '/api/pilot/shadow/formulas/observations', '/api/pilot/sessions'];
  expect(fetchCalls.filter((call) => call.method !== 'GET' && writes.some((path) => call.url.includes(path)))).toHaveLength(0);
});

test('Report pain from How I feel today honours reduced motion after the tab change (ATH-23)', async () => {
  const originalMatch = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query })) as unknown as typeof window.matchMedia;
  try {
    await renderWorkspace();
    fireEvent.click(corner().getByRole('button', { name: 'Report pain or soreness' }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
    expect(document.activeElement?.id).toBe('pain-location-select');
  } finally {
    window.matchMedia = originalMatch;
  }
});

describe('where the hold notice stands (lane AS-8)', () => {
  const HOLD = 'Training is paused for you right now';
  beforeEach(() => {
    activeHold = {
      scope: 'all_training',
      athlete_explanation: 'Rest the shoulder this week.',
      placed_by_name: 'Coach J.',
      lift_condition_text: null,
    };
  });

  test('on the Dashboard it is inside My Corner, after Report pain, once', async () => {
    await renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    const headline = await corner().findByText(HOLD);
    const pain = corner().getByRole('button', { name: 'Report pain or soreness' });
    expect(pain.compareDocumentPosition(headline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText(HOLD)).toHaveLength(1);
  });

  test('on a tab without My Corner it stands above the nav, once', async () => {
    await renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }));
    expect(screen.queryByRole('region', { name: 'My Corner' })).toBeNull();
    const headline = await screen.findByText(HOLD);
    const nav = screen.getByRole('button', { name: 'Today' });
    expect(headline.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText(HOLD)).toHaveLength(1);
  });
});

// useTabParam keeps the open tab in the address (lane AS4-4D4E, AS-4 part 4e),
// and jsdom keeps the address from one test to the next, so each test starts
// from a clean one.
afterEach(() => {
  window.history.replaceState(null, '', '/');
});
