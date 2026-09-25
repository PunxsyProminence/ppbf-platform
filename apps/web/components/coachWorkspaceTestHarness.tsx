/**
 * THE COACH WORKSPACE TEST HARNESS.
 *
 * Extracted from coachWorkspaceHonesty.test.tsx so a second suite can drive the
 * workspace through the SAME fake server, rather than standing up its own.
 *
 * That is not tidiness. The glance parity suite exists to prove BOARD and ROOM
 * tell a coach the same truth from one source of state. If it built its own
 * fetch mock, the two suites would drift, and parity would end up asserted
 * against app states the real server never produces -- a test that passes about
 * a situation that cannot happen. One harness, one set of states, both layouts.
 *
 * Nothing here was rewritten in the move. Every default and every comment is
 * the one the honesty suite already relied on, including the deliberate choice
 * that an idle coach is a HEALTHY read rather than a 404, which is what makes
 * an 'unavailable' rendering in these tests a real signal instead of a mock
 * artefact.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

import CoachWorkspace from './CoachWorkspace';

export interface RouteResponses {
  floorPlans?: () => Promise<Response>;
  reviewProjection?: () => Promise<Response>;
  coachReviews?: () => Promise<Response>;
  announcements?: () => Promise<Response>;
  intakeReviewAction?: (body: { intake_case_id?: string; action?: string }) => Promise<Response>;
  painReports?: () => Promise<Response>;
  barrierReports?: () => Promise<Response>;
  athletesList?: () => Promise<Response> | Response;
  readinessBoard?: () => Promise<Response> | Response;
  sessionsList?: (athleteId: string) => Promise<Response> | Response;
  coachReviewsList?: (sessionId: string) => Promise<Response> | Response;
  escalationsGet?: () => Promise<Response> | Response;
  escalationsPost?: (body: { action?: string; escalation_id?: string }) => Promise<Response> | Response;
  liveRun?: () => Promise<Response> | Response;
  scheduler?: () => Promise<Response> | Response;
  credentials?: () => Promise<Response> | Response;
  development?: () => Promise<Response> | Response;
  attendanceToday?: () => Promise<Response> | Response;
}

export function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(routes: RouteResponses = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_coach_1' });
    }
    if (url.includes('/api/pilot/athletes/list')) {
      return routes.athletesList ? routes.athletesList() : jsonResponse({ items: [] });
    }
    // { run: null } is the route's own success shape for "you have nothing
    // running" -- not a 404 -- so the default here is a HEALTHY read of an
    // idle coach, which is what makes an 'unavailable' rendering in these
    // tests a real signal rather than a mock artefact.
    if (url.includes('/api/pilot/session-scripts/runs')) {
      return routes.liveRun ? routes.liveRun() : jsonResponse({ run: null });
    }
    if (url.includes('/api/pilot/scheduler')) {
      return routes.scheduler ? routes.scheduler() : jsonResponse({ ok: true, classes: [] });
    }
    if (url.includes('/api/pilot/coach/credentials')) {
      return routes.credentials ? routes.credentials() : jsonResponse({ ok: true, items: [] });
    }
    // Default: a HEALTHY read of a coach who has written nothing down yet.
    // That matters for the same reason the live-run default does -- it makes
    // an 'unavailable' rendering in these tests a real signal rather than an
    // unstubbed-fetch artefact.
    if (url.includes('/api/pilot/coach/attendance-today')) {
      // Default is a HEALTHY read that found no marks -- an unregistered gym,
      // which is the ordinary state before class. That makes an 'Unavailable'
      // rendering in these tests a real signal rather than a mock artefact.
      return routes.attendanceToday
        ? routes.attendanceToday()
        : jsonResponse({ ok: true, day: '2026-08-28', covered: ['ath_1', 'ath_2'], marks: [] });
    }
    if (url.includes('/api/pilot/coach/development')) {
      return routes.development
        ? routes.development()
        : jsonResponse({ ok: true, goals: [], activities: [] });
    }
    if (url.includes('/api/pilot/coach/readiness-board')) {
      // Default: a healthy feed with no fresh check-ins -- everyone UNKNOWN.
      return routes.readinessBoard ? routes.readinessBoard() : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/sessions/list')) {
      const athleteId = new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '';
      return routes.sessionsList ? routes.sessionsList(athleteId) : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/floor-plans')) {
      return routes.floorPlans ? routes.floorPlans() : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/shadow/review-projection')) {
      return routes.reviewProjection ? routes.reviewProjection() : jsonResponse({ queue: [] });
    }
    if (url.includes('/api/pilot/shadow/observation-projection')) {
      return jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/coach-reviews/list')) {
      const sessionId = new URL(url, 'http://localhost').searchParams.get('session_id') ?? '';
      return routes.coachReviewsList ? routes.coachReviewsList(sessionId) : jsonResponse({ items: [] });
    }
    if (url.includes('/api/pilot/coach-reviews')) {
      return routes.coachReviews ? routes.coachReviews() : jsonResponse({ ok: true });
    }
    if (url.includes('/api/pilot/announcements/get')) {
      return routes.announcements ? routes.announcements() : jsonResponse({ ok: true, announcements: [] });
    }
    if (url.includes('/api/pilot/coach/pain-reports')) {
      return routes.painReports ? routes.painReports() : jsonResponse({ ok: true, painReports: [], windowDays: 14, truncated: false });
    }
    if (url.includes('/api/pilot/coach/barrier-reports')) {
      return routes.barrierReports ? routes.barrierReports() : jsonResponse({ ok: true, barrierReports: [], truncated: false });
    }
    if (url.includes('/api/pilot/escalations')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; escalation_id?: string };
        if (routes.escalationsPost) return routes.escalationsPost(body);
        return jsonResponse({ ok: true, escalation: { escalation_id: body.escalation_id, status: 'acknowledged' } });
      }
      return routes.escalationsGet ? routes.escalationsGet() : jsonResponse({ ok: true, escalations: [] });
    }
    if (url.includes('/api/pilot/intake/review-action')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { intake_case_id?: string; action?: string };
      if (routes.intakeReviewAction) return routes.intakeReviewAction(body);
      const status = body.action === 'approve' ? 'approved' : 'rejected';
      return jsonResponse({ ok: true, intake_case_id: body.intake_case_id, status });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

export async function renderWorkspace(routes: RouteResponses = {}): Promise<jest.Mock> {
  const fetchMock = installFetch(routes);
  await act(async () => {
    render(<CoachWorkspace />);
  });
  return fetchMock;
}

export // A tab carrying a pending-count badge (see StatusBadge in CoachWorkspace.tsx)
// has that count in its accessible name too -- "Tasks 3 pending", not just
// "Tasks" -- so this matches on the label as a prefix rather than requiring
// an exact string that only holds when the queue happens to be empty.
function openTab(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}\\b`) }));
}
