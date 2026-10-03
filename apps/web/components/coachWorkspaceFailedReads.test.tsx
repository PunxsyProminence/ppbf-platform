/**
 * @jest-environment jsdom
 */

// The #991 class on the coach home: a read that FAILED must not render the
// sentence a read that answered "none" would. Each case fails one read and
// checks the empty claim is absent and the failure is said instead.

import { act, fireEvent, render, screen } from '@testing-library/react';

import CoachWorkspace from './CoachWorkspace';

jest.mock('./CoachFloorFocus', () => ({ __esModule: true, default: () => null }));

type Fail = 'athletes' | 'queue' | 'observations' | 'readiness';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const FAILED = jsonResponse({ error: 'Internal server error' }, false);

/* One healthy, empty answer for every other read on the page: each route
   reads its own key from this, so nothing else on the page fails and an
   "unavailable" rendering below can only come from the read under test. */
const HEALTHY_EMPTY = {
  ok: true, authenticated: true, account_id: 'acct_coach_1', items: [], queue: [], run: null,
  classes: [], goals: [], activities: [], marks: [], covered: [], announcements: [],
  painReports: [], barrierReports: [], escalations: [], windowDays: 14, truncated: false,
};

const ATHLETE = { athlete_id: 'ath_1', full_name: 'Test Athlete', gym_status: 'active' };

async function renderWith(fail: Fail | null, roster: unknown[] = [ATHLETE]): Promise<void> {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return fail === 'athletes' ? FAILED : jsonResponse({ items: roster });
    }
    if (url.includes('/api/pilot/shadow/review-projection')) {
      return fail === 'queue' ? FAILED : jsonResponse({ queue: [] });
    }
    if (url.includes('/api/pilot/shadow/observation-projection')) {
      return fail === 'observations' ? FAILED : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/coach/readiness-board')) {
      return fail === 'readiness' ? FAILED : jsonResponse({ items: [] });
    }
    return jsonResponse(HEALTHY_EMPTY);
  }) as unknown as typeof fetch;
  await act(async () => {
    render(<CoachWorkspace />);
  });
}

function openTab(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: (name) => name.startsWith(label) }));
}

// The first render of this workspace pays the module's cold start, which on a
// loaded machine runs past jest's 5 s default; the assertions are not timing.
jest.setTimeout(20000);

afterEach(() => {
  jest.restoreAllMocks();
});

describe('coach home: a failed read is not an empty one', () => {
  test('a failed roster read does not say nobody is assigned', async () => {
    await renderWith('athletes');
    expect(await screen.findByText(/Your roster could not be read/)).toBeTruthy();
    expect(screen.queryByText(/Nobody is assigned to you yet/)).toBeNull();
  });

  test('an empty roster that answered still says nobody is assigned', async () => {
    await renderWith(null, []);
    expect(await screen.findByText(/Nobody is assigned to you yet/)).toBeTruthy();
    expect(screen.queryByText(/Your roster could not be read/)).toBeNull();
  });

  test('a failed review-queue read does not say "No open tasks" on the dashboard', async () => {
    await renderWith('queue');
    expect(await screen.findByText(/The review queue could not be read, so open tasks may be missing/)).toBeTruthy();
    expect(screen.queryByText(/No open tasks/)).toBeNull();
  });

  test('a healthy empty queue still says "No open tasks" on the dashboard', async () => {
    await renderWith(null);
    expect(await screen.findByText(/No open tasks/)).toBeTruthy();
  });

  test('a failed review-queue read does not say no queue items were returned', async () => {
    await renderWith('queue');
    openTab('SHADOW Intel');
    expect(screen.getByText('The review queue could not be read.')).toBeTruthy();
    expect(screen.queryByText('No SHADOW queue items returned.')).toBeNull();
  });

  test('a failed observation read does not say no observation items were returned', async () => {
    await renderWith('observations');
    openTab('SHADOW Intel');
    expect(screen.getByText('Observations could not be read.')).toBeTruthy();
    expect(screen.queryByText('No SHADOW observation items returned.')).toBeNull();
    // The queue answered, so its panel keeps its own honest empty line.
    expect(screen.getByText('No SHADOW queue items returned.')).toBeTruthy();
  });

  test('a failed readiness read does not say there are no fresh check-ins', async () => {
    await renderWith('readiness');
    expect(await screen.findByText(/Readiness could not be read/)).toBeTruthy();
    expect(screen.queryByText(/No fresh readiness check-ins/)).toBeNull();
  });

  test('a failed roster read does not say there are no fresh check-ins either', async () => {
    await renderWith('athletes');
    expect(await screen.findByText(/Readiness could not be read/)).toBeTruthy();
    expect(screen.queryByText(/No fresh readiness check-ins/)).toBeNull();
  });

  test('a healthy readiness read with nothing fresh still says so', async () => {
    await renderWith(null);
    expect(await screen.findByText(/No fresh readiness check-ins/)).toBeTruthy();
    expect(screen.queryByText(/Readiness could not be read/)).toBeNull();
  });
});
