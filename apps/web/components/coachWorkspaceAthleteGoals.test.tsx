/**
 * @jest-environment jsdom
 */

// Issue #1527 (OD-2026-10-12-011, "A: Coach and parent (Recommended)"): the
// goals an athlete set, their reported progress and "I did it" show read-only
// on the coach's athlete view, with the athlete's "why it matters" line, which
// is the coach's to read. Pinned here: where the block is mounted, that it
// waits for the coach's own pick, that it reads THAT athlete, and that it
// offers no control. The block's own behaviour is in
// athleteGoalsReadOnly.test.tsx; who the routes answer is in
// goalsStaffReach.pg.test.ts.

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import CoachWorkspace from './CoachWorkspace';

jest.mock('./CoachFloorFocus', () => ({ __esModule: true, default: () => null }));

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const HEALTHY_EMPTY = {
  ok: true, authenticated: true, account_id: 'acct_coach_1', items: [], queue: [], run: null,
  classes: [], goals: [], activities: [], marks: [], covered: [], announcements: [],
  painReports: [], barrierReports: [], escalations: [], windowDays: 14, truncated: false,
};

const ROSTER = [
  { athlete_id: 'ath_1', full_name: 'First Athlete', gym_status: 'active' },
  { athlete_id: 'ath_2', full_name: 'Second Athlete', gym_status: 'active' },
];

function goalsFor(athleteId: string) {
  return {
    personal: {
      ok: true,
      items: [{
        goal_id: `own-${athleteId}`,
        title: `Own words of ${athleteId}`,
        why_it_matters: `The reason of ${athleteId}`,
        target_date: null,
        reached_at: null,
      }],
    },
    list: {
      items: [{
        goal_id: `smart-${athleteId}`,
        title: `Measured goal of ${athleteId}`,
        target_date: '2026-12-01',
        metric: 'rounds',
        progress_percent: 40,
        status: 'active',
        goal_kind: 'smart',
      }],
    },
  };
}

let fetchMock: jest.Mock;

async function renderWorkspace(): Promise<void> {
  fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) return jsonResponse({ items: ROSTER });
    const athleteId = /athlete_id=([^&]+)/.exec(url)?.[1] ?? '';
    if (url.includes('/api/pilot/goals/personal')) return jsonResponse(goalsFor(athleteId).personal);
    if (url.includes('/api/pilot/goals/list')) return jsonResponse(goalsFor(athleteId).list);
    return jsonResponse(HEALTHY_EMPTY);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<CoachWorkspace />);
  });
}

function goalReads(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/api/pilot/goals/'));
}

async function pick(athleteId: string): Promise<void> {
  const row = await screen.findByText(ROSTER.find((athlete) => athlete.athlete_id === athleteId)!.full_name, {
    selector: `[data-roster-athlete-id="${athleteId}"] *`,
  });
  await act(async () => {
    fireEvent.click(row.closest(`[data-roster-athlete-id="${athleteId}"]`)!);
  });
}

// The first render of this workspace pays the module's cold start.
jest.setTimeout(20000);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('coach athlete view: the athlete\'s goals, read-only', () => {
  test('nothing is read or shown until the coach picks an athlete', async () => {
    await renderWorkspace();
    await screen.findByText('First Athlete', { selector: '[data-roster-athlete-id="ath_1"] *' });
    expect(screen.queryByTestId('athlete-goals')).toBeNull();
    expect(goalReads()).toEqual([]);
  });

  test('the picked athlete\'s goals show with progress and the why line, and nothing in the block writes', async () => {
    await renderWorkspace();
    await pick('ath_1');

    const block = await screen.findByTestId('athlete-goals');
    expect(await within(block).findByText('Own words of ath_1')).toBeTruthy();
    expect(within(block).getByText('Why it matters to them: The reason of ath_1')).toBeTruthy();
    expect(await within(block).findByText('Reported progress: 40%')).toBeTruthy();
    expect(within(block).queryAllByRole('button')).toHaveLength(0);
    expect(block.querySelectorAll('input, textarea, select, form')).toHaveLength(0);

    const reads = goalReads();
    expect(reads.some((url) => url.includes('/goals/personal?athlete_id=ath_1'))).toBe(true);
    expect(reads.some((url) => url.includes('/goals/list?athlete_id=ath_1'))).toBe(true);
  });

  test('picking another athlete takes the first athlete\'s goals off the screen', async () => {
    await renderWorkspace();
    await pick('ath_1');
    await screen.findByText('Own words of ath_1');

    await pick('ath_2');
    expect(await screen.findByText('Own words of ath_2')).toBeTruthy();
    expect(screen.queryByText('Own words of ath_1')).toBeNull();
    expect(screen.queryByText('Why it matters to them: The reason of ath_1')).toBeNull();
  });
});
