/**
 * @jest-environment jsdom
 */

/**
 * Which rung a pain severity is painted on. --locked means a medical stop and
 * nothing else (OD-2026-09-29-001); a pain report is not one at any severity
 * (Jason, 2026-10-03), so none of them may wear that badge.
 * Every surface that paints a severity is checked: the pain report card, the
 * escalation card, and the floor view that repeats both.
 *
 * #1528 (owner ruling 2026-10-12): a pain report reads as its number only, and
 * an escalation filed from one reads "Pain report". The stored severity still
 * picks the tone, so the tone is checked by the number and label too.
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
    painScore: 5,
    location: 'Left wrist',
    painType: 'Sharp',
    observedAt: '2026-08-14T17:30:00.000Z',
    recordedAt: '2026-08-14T18:00:00.000Z',
    reporter: 'athlete',
  };
}

function escalation(
  escalationId: string,
  severity: string,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    metadata,
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
function installFetch(severity: string, escalationMetadata: Record<string, unknown> = {}): void {
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
    if (url.includes('/api/pilot/escalations')) return jsonResponse({ ok: true, escalations: [escalation('esc_1', severity, escalationMetadata)] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

async function renderBadges(severity: string, escalationMetadata: Record<string, unknown> = {}): Promise<Element[]> {
  installFetch(severity, escalationMetadata);
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<CoachWorkspace />));
  });
  return Array.from(container.querySelectorAll('.badge'));
}

const badgeText = (badge: Element) => (badge.textContent ?? '').replace(/^\W+/, '');

/** The pain report's badges ("5/10") and the escalation's (its severity word). */
async function severityBadges(severity: string): Promise<Element[]> {
  return (await renderBadges(severity))
    .filter((badge) => badgeText(badge).startsWith('5/10') || badgeText(badge).startsWith(severity));
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

test.each(['moderate', 'high', 'critical'])(
  'a %s pain report and an escalation filed from it print no severity word (#1528)',
  async (severity) => {
    const badges = await renderBadges(severity, { trigger: 'athlete_pain_report', near_miss_id: 'nm_1' });
    const pain = badges.filter((badge) => badgeText(badge).startsWith('5/10'));
    const escalationBadges = badges.filter((badge) => badgeText(badge).startsWith('Pain report'));
    // Pain card; escalation card and the floor's current item (escalations
    // come first on the floor).
    expect(pain.length).toBeGreaterThanOrEqual(1);
    expect(escalationBadges.length).toBeGreaterThanOrEqual(2);
    expect(badges.filter((badge) => /^(moderate|high|critical)\b/.test(badgeText(badge)))).toEqual([]);
    // The stored severity still picks the tone.
    expect(new Set([...pain, ...escalationBadges].map(toneOf))).toEqual(new Set(['badge--restricted']));
  },
);

test('a repeated-pattern escalation over pain reports reads "Pain report" (#1528)', async () => {
  const badges = await renderBadges('high', { trigger_key: 'athlete_pain_report', occurrence_count: 3 });
  expect(badges.filter((badge) => badgeText(badge).startsWith('Pain report')).length).toBeGreaterThanOrEqual(2);
  expect(badges.filter((badge) => /^high\b/.test(badgeText(badge)))).toEqual([]);
});
