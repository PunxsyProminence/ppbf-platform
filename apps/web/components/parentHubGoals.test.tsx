/**
 * @jest-environment jsdom
 */

/**
 * Lane N8-05 (F-047): the parent hub's Progress tab shows the selected child's
 * goals read-only, for the family audience, and moves with the child picker.
 * The reason line is never drawn for a family -- not even if an answer carried
 * one (the server leaves it out; see goalsAudience.test.ts).
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ParentHub from './ParentHub';

const WHY = 'Because my dad never got to finish his.';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function installFetch() {
  const fetchMock = jest.fn(async (input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    const athleteId = url.searchParams.get('athlete_id') ?? '';
    if (url.pathname.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.pathname.endsWith('/api/pilot/goals/personal')) {
      return jsonResponse({
        ok: true,
        items: [{ goal_id: `${athleteId}-own`, title: `${athleteId} own goal`, why_it_matters: WHY, target_date: null, reached_at: null, created_at: '2026-10-01T15:00:00.000Z' }],
      });
    }
    if (url.pathname.endsWith('/api/pilot/goals/list')) {
      return jsonResponse({
        items: [{ goal_id: `${athleteId}-s`, title: `${athleteId} smart goal`, target_date: '2026-11-01', metric: 'rounds', progress_percent: 25, status: 'active', created_at: '2026-10-02T15:00:00.000Z' }],
      });
    }
    if (url.pathname.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    return jsonResponse({ ok: true, items: [], announcements: [], classes: [], registrations: [], attendance: [], card: null, completed_sessions: 0 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the Progress tab shows the selected child\'s goals for the family, and follows the child picker', async () => {
  const fetchMock = installFetch();
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Progress' }));
  });

  expect(screen.getByRole('heading', { name: 'Goals they have set' })).toBeInTheDocument();
  expect(await screen.findByText('ath_1 own goal')).toBeInTheDocument();
  expect(screen.getByText('ath_1 smart goal')).toBeInTheDocument();
  expect(screen.getByText('Reported progress: 25%')).toBeInTheDocument();
  // The family audience: no reason line, whatever the answer carried.
  expect(screen.queryByText(/Why it matters/)).toBeNull();
  expect(screen.queryByText(WHY)).toBeNull();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Second Child' }));
  });
  expect(await screen.findByText('ath_2 own goal')).toBeInTheDocument();
  expect(screen.queryByText('ath_1 own goal')).toBeNull();
  expect(screen.queryByText('ath_1 smart goal')).toBeNull();

  const goalReads = fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/api/pilot/goals/'));
  expect(goalReads.some((url) => url.includes('goals/personal?athlete_id=ath_2'))).toBe(true);
  expect(goalReads.every((url) => !url.includes('athlete_id=undefined'))).toBe(true);
});
