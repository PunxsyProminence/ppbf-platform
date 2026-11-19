/**
 * @jest-environment jsdom
 */

/**
 * THE MEDICAL-STOP MARK STAYS OFF ESCALATIONS (Jason, card OW25-48 A, 2026-11-19:
 * "Medical-stop mark only for a medical stop"; other critical escalations get
 * "the restricted mark, a glyph and a word").
 *
 * --locked and its ✕ mean a medical stop, MEDICALLY_NOT_ALLOWED
 * (OD-2026-09-29-001). That comes from the clearance record, never from
 * pilot.safety_escalations: no escalation source_type is a medical stop, and a
 * pain report is not one at any severity (OD-2026-10-03-017). So every source
 * type at every severity is rendered on the three escalation surfaces the
 * ruling reaches, and none of them may carry the mark:
 *   - the header badge (SafetyAttentionBadge),
 *   - the coach home's Safety Escalations panel and floor view (CoachWorkspace),
 *   - the /admin/escalations rows.
 * (The board's aggregate Critical tile is pinned in its own page test.)
 *
 * The source types come from /admin/escalations' SOURCE_LABEL, which the
 * compiler holds to every value of SafetyEscalationSourceType, and which
 * app/admin/escalations/page.test.tsx checks against
 * SAFETY_ESCALATION_SOURCE_TYPES itself. escalationLadder.ts cannot be imported
 * here: it loads 'pg', which does not run under jsdom.
 */

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import EscalationsPage, { SOURCE_LABEL } from '@/app/admin/escalations/page';
import CoachWorkspace from './CoachWorkspace';
import SafetyAttentionBadge from './SafetyAttentionBadge';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

const SOURCE_TYPES = Object.keys(SOURCE_LABEL);
const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
const PAIN = { trigger: 'athlete_pain_report', near_miss_id: 'nm_1' };

/** Every source type at every severity, plus a pain-report escalation at each. */
function everyEscalation(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const source_type of SOURCE_TYPES) {
    for (const severity of SEVERITIES) {
      rows.push({
        escalation_id: `esc_${source_type}_${severity}`,
        source_type,
        athlete_id: 'ath_1',
        severity,
        reason: `Escalation ${source_type} ${severity}.`,
        status: 'open',
        escalated_to_role: 'organization_admin',
        created_at: '2026-08-14T18:00:00.000Z',
        metadata: {},
      });
    }
  }
  for (const severity of SEVERITIES) {
    rows.push({
      escalation_id: `esc_pain_${severity}`,
      source_type: 'near_miss',
      athlete_id: 'ath_1',
      severity,
      reason: `Pain escalation ${severity}.`,
      status: 'open',
      escalated_to_role: 'coach',
      created_at: '2026-08-14T18:00:00.000Z',
      metadata: PAIN,
    });
  }
  return rows;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** The medical-stop mark in any of its spellings: class, token, or glyph. */
function expectNoMedicalStopMark(element: Element): void {
  const html = element.innerHTML + (element.getAttribute('class') ?? '');
  expect(html).not.toMatch(/locked/);
  expect(element.textContent ?? '').not.toContain('✕');
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the guard covers every source type the ladder admits', () => {
  // A fixture list that silently shrank would pass the guard by testing less.
  expect(SOURCE_TYPES.length).toBeGreaterThanOrEqual(11);
  expect(SOURCE_TYPES).toEqual(expect.arrayContaining(['pain_report', 'training_hold', 'sparring_symptom', 'incident']));
});

describe.each(SOURCE_TYPES)('a %s escalation', (sourceType) => {
  test.each(SEVERITIES)('at %s never wears the medical-stop mark on the header badge', async (severity) => {
    global.fetch = jest.fn(async () => jsonResponse({
      ok: true,
      escalations: [{ escalation_id: 'esc_1', source_type: sourceType, severity, status: 'open', metadata: {} }],
    })) as unknown as typeof fetch;

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SafetyAttentionBadge role="coach" />));
    });

    expectNoMedicalStopMark(container);
    if (severity === 'critical' || severity === 'high') {
      // It is shown, on the restricted rung, with its glyph and its word.
      const badge = container.querySelector('.badge--restricted');
      expect(badge).toBeTruthy();
      expect(badge?.querySelector('i')?.textContent).toBe('▲');
      expect(badge?.textContent).toContain(severity.toUpperCase());
    }
  });
});

test.each(SEVERITIES)('a %s pain-report escalation never wears the medical-stop mark on the header badge', async (severity) => {
  global.fetch = jest.fn(async () => jsonResponse({
    ok: true,
    escalations: [{ escalation_id: 'esc_1', severity, status: 'open', metadata: PAIN }],
  })) as unknown as typeof fetch;

  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<SafetyAttentionBadge role="organization_admin" />));
  });

  expectNoMedicalStopMark(container);
});

test('no escalation row on /admin/escalations wears the medical-stop mark', async () => {
  const rows = everyEscalation();
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/auth/session')) return jsonResponse({ ok: true, role: 'admin' });
    return jsonResponse({ ok: true, escalations: rows });
  }) as unknown as typeof fetch;

  render(<EscalationsPage />);
  await screen.findByText('Escalation incident critical.');

  const table = screen.getByText('Escalation incident critical.').closest('table') as HTMLElement;
  expect(table.querySelectorAll('tbody tr').length).toBeGreaterThanOrEqual(rows.length);
  expectNoMedicalStopMark(table);
  // Critical rows still say so: the restricted mark, ▲, and the word.
  const critical = screen.getByText('Escalation incident critical.').closest('tr')?.querySelector('.badge');
  expect(critical?.className).toContain('badge--restricted');
  expect(critical?.textContent).toBe('▲critical');
});

test('no escalation on the coach home panel or floor view wears the medical-stop mark', async () => {
  const rows = everyEscalation();
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
      return jsonResponse({ ok: true, painReports: [], windowDays: 14, truncated: false });
    }
    if (url.includes('/api/pilot/coach/barrier-reports')) return jsonResponse({ ok: true, barrierReports: [], truncated: false });
    if (url.includes('/api/pilot/escalations')) return jsonResponse({ ok: true, escalations: rows });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<CoachWorkspace />));
  });

  const panel = screen.getByRole('heading', { name: 'Safety Escalations' }).closest('section') as HTMLElement;
  expect(panel.querySelectorAll('article')).toHaveLength(rows.length);
  expectNoMedicalStopMark(panel);
  expect(panel.className).toContain('--restricted');

  const floor = container.querySelectorAll('.coach-floor-focus__badge');
  expect(floor.length).toBeGreaterThan(0);
  floor.forEach((badge) => expect(badge.className).not.toContain('badge--locked'));
});
