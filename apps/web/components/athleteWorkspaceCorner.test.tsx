/**
 * @jest-environment jsdom
 */

/**
 * My Corner mounted in the athlete workspace, fed by the workspace's own reads.
 * athleteCorner.test.tsx pins the corner alone; this pins the wiring:
 *  - Start check-in in the corner sends the same request the Session Log's
 *    Check In sends, because it is the same handler;
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

const corner = () => within(screen.getByRole('region', { name: 'My corner' }));

function checkInPosts(): FetchCall[] {
  return fetchCalls.filter((call) => call.method === 'POST' && call.url.endsWith('/api/pilot/sessions'));
}

/** The request body without the fields that are minted per click. */
function stable(body: Record<string, unknown>): Record<string, unknown> {
  const { session_id: _id, created_at: _created, updated_at: _updated, ...rest } = body;
  void _id; void _created; void _updated;
  return rest;
}

test('the corner\'s Start check-in sends exactly what the Session Log\'s Check In sends', async () => {
  await renderWorkspace();
  fireEvent.click(await corner().findByRole('button', { name: 'Start check-in' }));
  await waitFor(() => expect(checkInPosts()).toHaveLength(1));
  const fromCorner = checkInPosts()[0].body;
  expect(fromCorner.athlete_id).toBe('ath_test');
  expect(Object.keys(fromCorner).sort()).toEqual(
    ['athlete_id', 'completed_flag', 'created_at', 'date', 'notes', 'rpe', 'rpe_method', 'session_id', 'updated_at'],
  );

  // The Session Log's own button, on a fresh workspace.
  document.body.innerHTML = '';
  fetchCalls.length = 0;
  await renderWorkspace();
  fireEvent.click(await screen.findByRole('button', { name: 'Check In' }));
  await waitFor(() => expect(checkInPosts()).toHaveLength(1));
  expect(stable(checkInPosts()[0].body)).toEqual(stable(fromCorner));
});

test('with a session open today, the corner says checked in and offers no second check-in', async () => {
  const now = new Date().toISOString();
  storedSessions = [{
    session_id: 'session_1', athlete_id: 'ath_test', date: now.slice(0, 10), rpe: null,
    notes: '', completed_flag: false, created_at: now, updated_at: now,
  }];
  await renderWorkspace();
  expect(await corner().findByText(/^Checked in /)).toBeTruthy();
  expect(corner().queryByRole('button', { name: 'Start check-in' })).toBeNull();
});

test('while the session read is in flight, the corner says it is checking -- not "not checked in"', async () => {
  sessionListMode = 'pending';
  await renderWorkspace();
  expect(await corner().findByText('Checking whether you are checked in...')).toBeTruthy();
  expect(corner().queryByText('You have not checked in today.')).toBeNull();
  expect(corner().queryByRole('button', { name: 'Start check-in' })).toBeNull();
});

test('a failed session read is said as a failure, and Try again asks the same read again', async () => {
  sessionListMode = 'fail';
  await renderWorkspace();
  expect(await corner().findByText(/Could not tell whether you are checked in/)).toBeTruthy();
  expect(corner().queryByText('You have not checked in today.')).toBeNull();
  expect(corner().queryByRole('button', { name: 'Start check-in' })).toBeNull();

  const before = fetchCalls.filter((call) => call.url.includes('/api/pilot/sessions/list')).length;
  sessionListMode = 'answer';
  await act(async () => {
    fireEvent.click(corner().getByRole('button', { name: 'Try again' }));
  });
  const after = fetchCalls.filter((call) => call.url.includes('/api/pilot/sessions/list')).length;
  expect(after).toBe(before + 1);
  expect(await corner().findByText('You have not checked in today.')).toBeTruthy();
});

test('Report pain takes the athlete to the existing report\'s location picker, which still files the pain', async () => {
  sessionListMode = 'pending';
  await renderWorkspace();
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

test('the old Today section no longer repeats the corner\'s controls below it', async () => {
  await renderWorkspace();
  expect(screen.getAllByRole('button', { name: 'Start check-in' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Open the floor' })).toHaveLength(1);
});

test('after today\'s session was checked out, the corner says so instead of "not checked in"', async () => {
  const now = new Date().toISOString();
  storedSessions = [{
    session_id: 'session_done', athlete_id: 'ath_test', date: now.slice(0, 10), rpe: '6', rpe_method: 'SESSION_RPE',
    notes: '', completed_flag: true, created_at: now, updated_at: now,
  }];
  await renderWorkspace();
  expect(await corner().findByText(/^Checked out today\./)).toBeTruthy();
  expect(corner().queryByText('You have not checked in today.')).toBeNull();
});

test('a check-in that fails says so in the corner', async () => {
  checkInPostFails = true;
  await renderWorkspace();
  fireEvent.click(await corner().findByRole('button', { name: 'Start check-in' }));
  expect(await corner().findByText(/That check-in did not save/)).toBeTruthy();
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
