/**
 * @jest-environment jsdom
 */

/**
 * The floor view mounted in the coach workspace, fed by the workspace's own
 * reads. coachFloorFocus.test.tsx pins the view on its own (no fetch, Next
 * writes nothing); this pins the wiring: what the workspace hands it, and that
 * the one write it can reach is the same acknowledge the escalation panel sends.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import CoachWorkspace from './CoachWorkspace';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

type Route = () => Response;

interface Routes {
  athletesList?: Route;
  readinessBoard?: Route;
  painReports?: Route;
  barrierReports?: Route;
  escalationsGet?: Route;
  escalationsPost?: (body: { action?: string; escalation_id?: string }) => Response;
}

/* Every default is a HEALTHY read that found nothing, the same defaults the
   workspace honesty suite uses, so a failure rendered here is a real signal. */
function installFetch(routes: Routes = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, account_id: 'acct_coach_1' });
    if (url.includes('/api/pilot/athletes/list')) return routes.athletesList ? routes.athletesList() : jsonResponse({ items: [] });
    if (url.includes('/api/pilot/session-scripts/runs')) return jsonResponse({ run: null });
    if (url.includes('/api/pilot/scheduler')) return jsonResponse({ ok: true, classes: [] });
    if (url.includes('/api/pilot/coach/credentials')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/coach/attendance-today')) {
      return jsonResponse({ ok: true, day: '2026-08-28', covered: ['ath_1'], marks: [] });
    }
    if (url.includes('/api/pilot/coach/development')) return jsonResponse({ ok: true, goals: [], activities: [] });
    if (url.includes('/api/pilot/coach/readiness-board')) {
      return routes.readinessBoard ? routes.readinessBoard() : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/sessions/list')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/floor-plans')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/shadow/review-projection')) return jsonResponse({ queue: [] });
    if (url.includes('/api/pilot/shadow/observation-projection')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/coach-reviews/list')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
    if (url.includes('/api/pilot/coach/pain-reports')) {
      return routes.painReports
        ? routes.painReports()
        : jsonResponse({ ok: true, painReports: [], windowDays: 14, truncated: false });
    }
    if (url.includes('/api/pilot/coach/barrier-reports')) {
      return routes.barrierReports ? routes.barrierReports() : jsonResponse({ ok: true, barrierReports: [], truncated: false });
    }
    if (url.includes('/api/pilot/escalations')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; escalation_id?: string };
        if (routes.escalationsPost) return routes.escalationsPost(body);
        throw new Error('Unexpected escalation write');
      }
      return routes.escalationsGet ? routes.escalationsGet() : jsonResponse({ ok: true, escalations: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderWorkspace(routes: Routes = {}): Promise<jest.Mock> {
  const fetchMock = installFetch(routes);
  await act(async () => {
    render(<CoachWorkspace />);
  });
  return fetchMock;
}

const floor = () => within(screen.getByRole('region', { name: 'The floor' }));

function escalation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    escalation_id: 'esc_1',
    athlete_id: 'ath_1',
    source_type: 'pain_report',
    severity: 'high',
    reason: 'Pain score 8 reported after sparring round.',
    status: 'open',
    created_at: '2026-08-14T18:00:00.000Z',
    ...overrides,
  };
}

const roster = () => jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'Jordan P.' }] });

afterEach(() => {
  jest.restoreAllMocks();
});

test('an open escalation is first on the floor, and acknowledging it there sends the panel\'s own request', async () => {
  const posted: Array<{ action?: string; escalation_id?: string }> = [];
  const fetchMock = await renderWorkspace({
    athletesList: roster,
    escalationsGet: () => jsonResponse({ ok: true, escalations: [escalation()] }),
    escalationsPost: (body) => {
      posted.push(body);
      return jsonResponse({ ok: true, escalation: escalation({ status: 'acknowledged' }) });
    },
  });

  expect(floor().getByText('Needs you now · 1 of 1')).toBeTruthy();
  expect(floor().getByRole('heading', { name: 'Jordan P.' })).toBeTruthy();

  const before = fetchMock.mock.calls.length;
  fireEvent.click(floor().getByRole('button', { name: 'Open' }));
  expect(fetchMock.mock.calls.length).toBe(before);

  await act(async () => {
    fireEvent.click(floor().getByRole('button', { name: 'Acknowledge' }));
  });

  expect(posted).toEqual([{ action: 'acknowledge', escalation_id: 'esc_1' }]);
  // Seen, so it leaves the floor's queue; the panel below still lists it.
  expect(floor().queryByText('Needs you now · 1 of 1')).toBeNull();
  expect(floor().getByRole('heading', { name: 'Nothing needs you right now' })).toBeTruthy();
});

test('a failed pain-report read is shown on the floor first, never as "nothing needs you"', async () => {
  await renderWorkspace({
    painReports: () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
  });

  expect(floor().queryByRole('heading', { name: 'Nothing needs you right now' })).toBeNull();
  expect(floor().getByRole('heading', { name: 'Could not be read' })).toBeTruthy();
  expect(floor().getByText('Pain reports')).toBeTruthy();
});

test('a failed escalation read is shown on the floor first, ahead of any report', async () => {
  await renderWorkspace({
    escalationsGet: () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
  });

  expect(floor().queryByRole('heading', { name: 'Nothing needs you right now' })).toBeNull();
  expect(floor().getByRole('heading', { name: 'Could not be read' })).toBeTruthy();
  expect(floor().getByText('Safety escalations')).toBeTruthy();
});

test('with every read healthy and empty, the floor says nothing has been reported', async () => {
  await renderWorkspace({ athletesList: roster });
  expect(floor().getByRole('heading', { name: 'Nothing needs you right now' })).toBeTruthy();
  expect(floor().getByText(/not that everyone is fine/)).toBeTruthy();
});

test('an unvalidated GREEN reading shows as "Not validated" on the floor, never as a band', async () => {
  await renderWorkspace({
    athletesList: roster,
    readinessBoard: () => jsonResponse({
      items: [
        {
          athlete_id: 'ath_1', status: 'GREEN', score: 8,
          measured_at: '2026-08-15T12:00:00.000Z',
          method: 'staff_entered_intake',
          reliability_status: 'UNVALIDATED - PPBF MUST ESTABLISH',
          validity_status: 'UNKNOWN',
        },
      ],
    }),
  });

  expect(floor().getByRole('button', { name: 'Jordan P.: readiness Not validated' })).toBeTruthy();
  expect(floor().queryByRole('button', { name: 'Jordan P.: readiness Green' })).toBeNull();
});

test('choosing an athlete on the floor reads nothing and opens nothing', async () => {
  const fetchMock = await renderWorkspace({ athletesList: roster });
  const before = fetchMock.mock.calls.length;
  Element.prototype.scrollIntoView = jest.fn();

  fireEvent.click(floor().getByRole('button', { name: 'Jordan P.: readiness No reading' }));

  expect(fetchMock.mock.calls.length).toBe(before);
  expect(document.activeElement?.getAttribute('data-roster-athlete-id')).toBe('ath_1');
});

test('every open escalation, pain report and barrier report the panels hold is on the floor\'s count', async () => {
  await renderWorkspace({
    athletesList: roster,
    escalationsGet: () => jsonResponse({
      ok: true,
      escalations: [
        escalation(),
        escalation({ escalation_id: 'esc_2', athlete_id: 'ath_unknown', severity: 'critical' }),
        // Already seen: stays in the panel, leaves the floor's queue.
        escalation({ escalation_id: 'esc_3', status: 'acknowledged' }),
      ],
    }),
    painReports: () => jsonResponse({
      ok: true,
      windowDays: 14,
      truncated: false,
      painReports: [{
        nearMissId: 'nm_1', athleteId: 'ath_1', athleteName: 'Jordan P.', severity: 'moderate', painScore: 5,
        location: 'Left shoulder', painType: null, observedAt: null, recordedAt: '2026-08-14T18:00:00.000Z', reporter: 'athlete',
      }],
    }),
    barrierReports: () => jsonResponse({
      ok: true,
      truncated: false,
      barrierReports: [{
        note_id: 'note-1', athlete_id: 'ath_1', athlete_name: 'Jordan P.', reporter_role: 'parent',
        note_type: 'transportation_barrier', note_text: 'We lost our ride on Tuesdays.', created_at: '2026-08-10T10:00:00.000Z',
      }],
    }),
  });

  expect(floor().getByText('Needs you now · 1 of 4')).toBeTruthy();
  const needs = floor().getByText('Needs you').closest('.coach-floor-focus__gauge') as HTMLElement;
  expect(needs.querySelector('.coach-floor-focus__gauge-value')?.textContent).toBe('4');
  // Safety first: the open escalations lead, in the order the server sent them.
  expect(floor().getByRole('heading', { name: 'Jordan P.' })).toBeTruthy();
  fireEvent.click(floor().getByRole('button', { name: 'Next →' }));
  expect(floor().getByRole('heading', { name: 'Athlete ID ath_unknown' })).toBeTruthy();
  fireEvent.click(floor().getByRole('button', { name: 'Next →' }));
  expect(floor().getByText('Pain report')).toBeTruthy();
  fireEvent.click(floor().getByRole('button', { name: 'Next →' }));
  expect(floor().getByText('Family barrier report')).toBeTruthy();
});

/* ONE PLACE PER ACTION (Jason 2026-10-03, option A). On the Dashboard every
   report action is on the board and nowhere else, and the full lists below it
   stay complete -- acknowledged rows included -- so nothing a coach could see
   before is lost. Off the Dashboard the board is absent and the lists keep
   their own buttons, so the actions are never unreachable. */
test('on the Dashboard each report action is on the board only, and the full lists stay complete below it', async () => {
  await renderWorkspace({
    athletesList: roster,
    escalationsGet: () => jsonResponse({
      ok: true,
      escalations: [
        escalation(),
        escalation({ escalation_id: 'esc_2', athlete_id: 'ath_unknown', severity: 'critical', reason: 'Second open one.' }),
        escalation({ escalation_id: 'esc_3', status: 'acknowledged', reason: 'Already seen.' }),
      ],
    }),
    painReports: () => jsonResponse({
      ok: true,
      windowDays: 14,
      truncated: false,
      painReports: [{
        nearMissId: 'nm_1', athleteId: 'ath_1', athleteName: 'Jordan P.', severity: 'moderate', painScore: 5,
        location: 'Left shoulder', painType: null, observedAt: null, recordedAt: '2026-08-14T18:00:00.000Z', reporter: 'athlete',
      }],
    }),
    barrierReports: () => jsonResponse({
      ok: true,
      truncated: false,
      barrierReports: [{
        note_id: 'note-1', athlete_id: 'ath_1', athlete_name: 'Jordan P.', reporter_role: 'parent',
        note_type: 'transportation_barrier', note_text: 'We lost our ride on Tuesdays.', created_at: '2026-08-10T10:00:00.000Z',
      }],
    }),
  });

  // The full lists: every escalation, open and acknowledged, every report.
  expect(screen.getByRole('heading', { name: 'Athlete Pain Reports' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Safety Escalations' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Family Barrier Reports' })).toBeTruthy();
  expect(screen.getByText('Pain score 8 reported after sparring round.')).toBeTruthy();
  expect(screen.getByText('Second open one.')).toBeTruthy();
  expect(screen.getByText('Already seen.')).toBeTruthy();
  expect(screen.getAllByText(/Acknowledge it from Needs You Now/)).toHaveLength(2);
  expect(screen.getByText('Left shoulder')).toBeTruthy();
  expect(screen.getByText('We lost our ride on Tuesdays.')).toBeTruthy();

  // No action below the board: none until the coach opens an item on it.
  expect(screen.queryAllByRole('button', { name: 'Acknowledge' })).toHaveLength(0);
  expect(screen.queryAllByRole('link', { name: /record what you did/i })).toHaveLength(0);
  expect(screen.queryAllByRole('link', { name: /Message Home/ })).toHaveLength(0);

  // Each one, opened on the board, is there exactly once on the page.
  fireEvent.click(floor().getByRole('button', { name: 'Open' }));
  expect(screen.getAllByRole('button', { name: 'Acknowledge' })).toHaveLength(1);
  fireEvent.click(floor().getByRole('button', { name: 'Next →' }));
  fireEvent.click(floor().getByRole('button', { name: 'Next →' }));
  fireEvent.click(floor().getByRole('button', { name: 'Open' }));
  expect(screen.getAllByRole('link', { name: /record what you did/i })).toHaveLength(1);
  fireEvent.click(floor().getByRole('button', { name: 'Next →' }));
  fireEvent.click(floor().getByRole('button', { name: 'Open' }));
  expect(screen.getAllByRole('link', { name: /Message Home/ })).toHaveLength(1);

  // Off the Dashboard the board is gone and the lists carry the actions.
  fireEvent.click(screen.getByRole('button', { name: /^Goals/ }));
  expect(screen.queryByRole('region', { name: 'The floor' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Acknowledge' })).toHaveLength(2);
  expect(screen.getAllByRole('link', { name: /record what you did/i })).toHaveLength(1);
  expect(screen.getAllByRole('link', { name: /Message Home/ })).toHaveLength(1);
});

test('a live-run read that failed shows the session gauge as unknown, never "None"', async () => {
  installFetch();
  const base = global.fetch as jest.Mock;
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input).includes('/api/pilot/session-scripts/runs')) return jsonResponse({ error: 'boom' }, { ok: false, status: 500 });
    return base(input, init);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<CoachWorkspace />);
  });

  const session = floor().getByText('Session').closest('.coach-floor-focus__gauge') as HTMLElement;
  expect(session.querySelector('.coach-floor-focus__gauge-value')?.textContent).toBe('?');
  expect(floor().queryByRole('link', { name: 'Start a session' })).toBeNull();
});

test('a readiness feed that failed shows the readings gauge as unknown, never 0 of N', async () => {
  await renderWorkspace({
    athletesList: roster,
    readinessBoard: () => jsonResponse({ error: 'boom' }, { ok: false, status: 500 }),
  });
  const readings = floor().getByText('Readings').closest('.coach-floor-focus__gauge') as HTMLElement;
  expect(readings.querySelector('.coach-floor-focus__gauge-value')?.textContent).toBe('?');
  expect(readings.textContent).not.toContain('0 of 1');
});

test('acknowledging two escalations in a row takes two deliberate taps on two opened items', async () => {
  const posted: Array<{ action?: string; escalation_id?: string }> = [];
  await renderWorkspace({
    athletesList: roster,
    escalationsGet: () => jsonResponse({
      ok: true,
      escalations: [escalation(), escalation({ escalation_id: 'esc_2', athlete_id: 'ath_unknown' })],
    }),
    escalationsPost: (body) => {
      posted.push(body);
      return jsonResponse({ ok: true, escalation: escalation({ escalation_id: body.escalation_id, status: 'acknowledged' }) });
    },
  });

  fireEvent.click(floor().getByRole('button', { name: 'Open' }));
  await act(async () => {
    fireEvent.click(floor().getByRole('button', { name: 'Acknowledge' }));
  });
  expect(posted).toEqual([{ action: 'acknowledge', escalation_id: 'esc_1' }]);
  // The second child's escalation is now in place -- closed, no Acknowledge under the coach's finger.
  expect(floor().getByRole('heading', { name: 'Athlete ID ath_unknown' })).toBeTruthy();
  expect(floor().queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  expect(floor().getByText(/Acknowledged: Jordan P\./)).toBeTruthy();

  fireEvent.click(floor().getByRole('button', { name: 'Open' }));
  await act(async () => {
    fireEvent.click(floor().getByRole('button', { name: 'Acknowledge' }));
  });
  expect(posted).toEqual([
    { action: 'acknowledge', escalation_id: 'esc_1' },
    { action: 'acknowledge', escalation_id: 'esc_2' },
  ]);
});

test('an athlete the register says this coach does not cover is marked "Not your athlete" on the floor too', async () => {
  await renderWorkspace({
    athletesList: () => jsonResponse({ items: [
      { athlete_id: 'ath_1', full_name: 'Jordan P.' },
      { athlete_id: 'ath_2', full_name: 'Casey R.' },
    ] }),
  });
  const casey = floor().getByRole('button', { name: /^Casey R\./ });
  expect(casey.textContent).toContain('Not your athlete');
  const jordan = floor().getByRole('button', { name: /^Jordan P\./ });
  expect(jordan.textContent).not.toContain('Not your athlete');
});
