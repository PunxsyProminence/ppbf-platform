/**
 * @jest-environment jsdom
 */

/**
 * Which rung a pain severity is painted on. --locked means a medical stop and
 * nothing else (OD-2026-09-29-001); a pain report is not one at any severity
 * (Jason, 2026-10-03), so none of them may wear that badge.
 * Every surface that paints a severity is checked: the pain report card, the
 * escalation card, and the floor view that repeats both.
 */

import { act, render } from '@testing-library/react';

import CoachWorkspace from './CoachWorkspace';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function painReport(nearMissId: string, severity: string): Record<string, unknown> {
  return {
    nearMissId,
    athleteId: 'ath_1',
    athleteName: 'Jordan P.',
    severity,
    painScore: null,
    location: 'Left wrist',
    painType: 'Sharp',
    observedAt: '2026-08-14T17:30:00.000Z',
    recordedAt: '2026-08-14T18:00:00.000Z',
    reporter: 'athlete',
  };
}

function escalation(escalationId: string, severity: string): Record<string, unknown> {
  return {
    escalation_id: escalationId,
    athlete_id: 'ath_1',
    source_type: 'pain_report',
    severity,
    reason: 'Pain reported after sparring round.',
    status: 'open',
    created_at: '2026-08-14T18:00:00.000Z',
  };
}

/* Every other read is a HEALTHY read that found nothing, as in the honesty and
   floor-focus suites. */
function installFetch(severity: string): void {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, account_id: 'acct_coach_1' });
    if (url.includes('/api/pilot/athletes/list')) return jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'Jordan P.' }] });
    if (url.includes('/api/pilot/session-scripts/runs')) return jsonResponse({ run: null });
    if (url.includes('/api/pilot/scheduler')) return jsonResponse({ ok: true, classes: [] });
    if (url.includes('/api/pilot/coach/credentials')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/coach/attendance-today')) {
      return jsonResponse({ ok: true, day: '2026-08-28', covered: ['ath_1'], marks: [] });
    }
    if (url.includes('/api/pilot/coach/development')) return jsonResponse({ ok: true, goals: [], activities: [] });
    if (url.includes('/api/pilot/coach/readiness-board')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/sessions/list')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/floor-plans')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/shadow/review-projection')) return jsonResponse({ queue: [] });
    if (url.includes('/api/pilot/shadow/observation-projection')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/coach-reviews/list')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
    if (url.includes('/api/pilot/coach/pain-reports')) {
      return jsonResponse({ ok: true, painReports: [painReport('nm_1', severity)], windowDays: 14, truncated: false });
    }
    if (url.includes('/api/pilot/coach/barrier-reports')) return jsonResponse({ ok: true, barrierReports: [], truncated: false });
    if (url.includes('/api/pilot/escalations')) return jsonResponse({ ok: true, escalations: [escalation('esc_1', severity)] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

/** Every badge whose label starts with the severity word. */
async function severityBadges(severity: string): Promise<Element[]> {
  installFetch(severity);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<CoachWorkspace />));
  });
  return Array.from(container.querySelectorAll('.badge'))
    .filter((badge) => (badge.textContent ?? '').replace(/^\W+/, '').startsWith(severity));
}

function toneOf(badge: Element): string {
  return Array.from(badge.classList).find((cls) => cls.startsWith('badge--')) ?? '';
}

afterEach(() => {
  jest.restoreAllMocks();
});

test.each([
  ['high', 'badge--restricted'],
  ['moderate', 'badge--restricted'],
  ['low', 'badge--monitor'],
  ['critical', 'badge--restricted'],
])('a %s pain report and escalation are painted %s everywhere', async (severity, tone) => {
  const badges = await severityBadges(severity);
  // Pain card, escalation card, and the floor view's current item.
  expect(badges.length).toBeGreaterThanOrEqual(3);
  expect(badges.some((badge) => badge.classList.contains('coach-floor-focus__badge'))).toBe(true);
  expect(new Set(badges.map(toneOf))).toEqual(new Set([tone]));
});
