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
 * type at every severity is rendered on the escalation surfaces the ruling
 * reaches, and none of them may carry the mark:
 *   - the header badge (SafetyAttentionBadge),
 *   - the coach home's Safety Escalations panel (CoachWorkspace),
 *   - the /admin/escalations rows,
 *   - the /admin/safety-review Open Escalations list,
 *   - the /coach/intelligence Open safety escalations list.
 * The board's aggregate Critical tile is pinned in its own page test. The
 * coach floor view shows one queue item at a time, so it is not swept here;
 * its badge tone is painSeverityTone, which coachWorkspacePainTone.test.tsx
 * pins to restricted for a critical escalation on the floor.
 *
 * The source types come from /admin/escalations' SOURCE_LABEL, which the
 * compiler holds to every value of SafetyEscalationSourceType, and which
 * app/admin/escalations/page.test.tsx checks against
 * SAFETY_ESCALATION_SOURCE_TYPES itself. escalationLadder.ts cannot be imported
 * here: it loads 'pg', which does not run under jsdom.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import ts from 'typescript';

import EscalationsPage, { SOURCE_LABEL } from '@/app/admin/escalations/page';
import SafetyReviewPage from '@/app/admin/safety-review/page';
import CoachIntelligencePage from '@/app/coach/intelligence/page';
import CoachWorkspace from './CoachWorkspace';
import SafetyAttentionBadge, { showsPainNumber } from './SafetyAttentionBadge';
import { DESIGN_SYSTEM_ENTRY, readDesignSystemCss } from '@/src/design/readDesignSystemCss';

// The bar's route. The badge shows a lone pain number only on the office's
// safety-record pages; every test starts on one and moves where it says.
let mockPathname: string | null = '/admin/escalations';
jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  usePathname: () => mockPathname,
}));

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

function installCoachFetch(rows: Array<Record<string, unknown>>): void {
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
}

afterEach(() => {
  jest.restoreAllMocks();
  mockPathname = '/admin/escalations';
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

test('no escalation on the coach home Safety Escalations panel wears the medical-stop mark', async () => {
  const rows = everyEscalation();
  installCoachFetch(rows);

  await act(async () => {
    render(<CoachWorkspace />);
  });

  const panel = screen.getByRole('heading', { name: 'Safety Escalations' }).closest('section') as HTMLElement;
  expect(panel.querySelectorAll('article')).toHaveLength(rows.length);
  expectNoMedicalStopMark(panel);
  expect(panel.className).toContain('--restricted');
});

test('no escalation on the /admin/safety-review list wears the medical-stop mark', async () => {
  const rows = everyEscalation().map((row) => ({ ...row, athlete_name: String(row.reason) }));
  global.fetch = jest.fn(async () => jsonResponse({
    ok: true,
    openHolds: [],
    failingGates: [],
    openEscalations: rows,
    openViolations: [],
    openFlags: [],
    violationsReadLimit: 200,
    violationsTruncated: false,
  })) as unknown as typeof fetch;

  render(<SafetyReviewPage />);
  const heading = await screen.findByText(`Open Escalations (${rows.length})`);
  const section = heading.closest('section') as HTMLElement;
  expect(section.querySelectorAll('li')).toHaveLength(rows.length);
  expectNoMedicalStopMark(section);
});

test('no escalation on the /coach/intelligence list wears the medical-stop mark', async () => {
  const rows = everyEscalation().map((row) => ({
    ...row,
    athlete_name: 'Jordan P.',
    pain_report: row.metadata === PAIN,
  }));
  global.fetch = jest.fn(async () => jsonResponse({
    stalled_gaps: [],
    readiness_concerns: [],
    fading_attendance: [],
    unreviewed_sessions: [],
    expiring_holds: [],
    open_safety_escalations: rows,
    open_compliance_violations: [],
  })) as unknown as typeof fetch;

  await act(async () => {
    render(<CoachIntelligencePage />);
  });
  const section = screen.getByRole('heading', { name: 'Open safety escalations' }).closest('section') as HTMLElement;
  expect(section.querySelectorAll('li')).toHaveLength(rows.length);
  expectNoMedicalStopMark(section);
});

/* A LONE PAIN REPORT, CRITICAL OR HIGH (Overwatch, 2026-11-19, option B with a
   condition: show the pain number where the surface already holds it, with no
   new read; otherwise option A, the same mark for both, stated).
   An escalation filed from one pain report stores no score in its metadata
   (the near miss id and the trigger); the number is in its reason text,
   written by painReportAlert.ts describe() ("...at severity N/10."). The
   /admin/escalations row, the coach panel card and /coach/intelligence show
   that reason, so the number is on screen there. The header badge and
   /admin/safety-review receive the reason but do not show it, so they read
   the number out of it (painScoreFromEscalationReason; option B1): the badge
   only for exactly one open pain report and only on the office's
   safety-record pages (showsPainNumber), never on a desk screen used with a
   member present, a floor page or the coach home.
   The badge renders only for staff sessions (coach, organization admin), and
   GlobalRoleHeader draws no bar on /wall (globalRoleHeader.test.tsx). */
describe.each([
  ['critical', 8],
  ['high', 5],
] as const)('a lone %s pain-report escalation', (severity, score) => {
  const row = {
    escalation_id: `esc_pain_${severity}`,
    source_type: 'near_miss',
    athlete_id: 'ath_1',
    severity,
    reason: `Athlete ath_1 reported pain at the left wrist at severity ${score}/10. Self-reported by the athlete, not assessed by a coach or a medical provider.`,
    status: 'open',
    escalated_to_role: 'coach',
    created_at: '2026-08-14T18:00:00.000Z',
    metadata: PAIN,
  };

  test('shows its number on the /admin/escalations row, beside the restricted mark', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/auth/session')) return jsonResponse({ ok: true, role: 'admin' });
      return jsonResponse({ ok: true, escalations: [row] });
    }) as unknown as typeof fetch;

    render(<EscalationsPage />);
    const reason = await screen.findByText(row.reason);
    const tr = reason.closest('tr') as HTMLElement;
    expect(tr.textContent).toContain(`${score}/10`);
    expect(tr.querySelector('.badge')?.textContent).toBe('▲Pain report');
    expectNoMedicalStopMark(tr);
  });

  test('shows its number on the coach home Safety Escalations card', async () => {
    installCoachFetch([row]);
    await act(async () => {
      render(<CoachWorkspace />);
    });
    const panel = screen.getByRole('heading', { name: 'Safety Escalations' }).closest('section') as HTMLElement;
    const card = panel.querySelector('article') as HTMLElement;
    expect(card.textContent).toContain(`${score}/10`);
    expect(card.querySelector('.badge')?.className).toContain('badge--restricted');
    expectNoMedicalStopMark(card);
  });

  test('shows its number on the /coach/intelligence row', async () => {
    global.fetch = jest.fn(async () => jsonResponse({
      stalled_gaps: [], readiness_concerns: [], fading_attendance: [], unreviewed_sessions: [], expiring_holds: [],
      open_safety_escalations: [{ ...row, athlete_name: 'Jordan P.', pain_report: true }],
      open_compliance_violations: [],
    })) as unknown as typeof fetch;
    await act(async () => {
      render(<CoachIntelligencePage />);
    });
    const li = screen.getByText(new RegExp(`severity ${score}/10`)).closest('li') as HTMLElement;
    expect(li.textContent).toContain(`${score}/10`);
    expect(li.querySelector('.badge')?.textContent).toBe('▲Pain report');
    expectNoMedicalStopMark(li);
  });

  test('shows its number on the header badge, in both densities and the aria-label', async () => {
    global.fetch = jest.fn(async () => jsonResponse({ ok: true, escalations: [row] })) as unknown as typeof fetch;

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SafetyAttentionBadge role="coach" />));
    });

    const badge = container.querySelector('.badge') as HTMLElement;
    expect(badge.className).toContain('badge--restricted');
    expect(badge.textContent).toBe(`▲SAFETY 1 · PAIN REPORT ${score}/10Safety 1 pain report ${score}/10`);
    const link = screen.getByRole('link', { name: /Safety escalations needing acknowledgement/i });
    expect(link.getAttribute('aria-label')).toContain(`1 pain report ${score}/10`);
    // The number only: never the reason, the location, or the athlete.
    expect(container.textContent).not.toMatch(/wrist|ath_1|Self-reported/);
  });

  test('shows the number on /admin/safety-review', async () => {
    global.fetch = jest.fn(async () => jsonResponse({
      ok: true, openHolds: [], failingGates: [],
      openEscalations: [{ ...row, athlete_name: 'Jordan T.' }],
      openViolations: [], openFlags: [], violationsReadLimit: 200, violationsTruncated: false,
    })) as unknown as typeof fetch;

    render(<SafetyReviewPage />);
    await screen.findByText('Open Escalations (1)');
    const li = screen.getByText('Jordan T.').closest('li') as HTMLElement;
    expect(li.querySelector('.badge')?.textContent).toBe(`▲Pain report ${score}/10`);
    expect(li.textContent).not.toMatch(/wrist|Self-reported/);
  });

  test.each([
    // Desk screens used with a member standing there (Overwatch, 2026-11-19).
    '/admin/pin', '/admin/activation-codes', '/admin/people', '/admin',
    // Gym-floor and other pages.
    '/coach', '/coach/floor-groups', '/coach/drills', '/schedule', '/athlete', '/', null,
  ])(
    'shows no number on the header badge on %s',
    async (pathname) => {
      mockPathname = pathname;
      global.fetch = jest.fn(async () => jsonResponse({ ok: true, escalations: [row] })) as unknown as typeof fetch;

      await act(async () => {
        render(<SafetyAttentionBadge role="coach" />);
      });

      const badge = document.body.querySelector('.badge') as HTMLElement;
      expect(badge.textContent).toBe('▲SAFETY 1 · PAIN REPORTSafety 1 pain report');
      expect(document.body.textContent).not.toContain(`${score}/10`);
      const link = screen.getByRole('link', { name: /Safety escalations needing acknowledgement/i });
      expect(link.getAttribute('aria-label')).not.toContain('/10');
    },
  );
});

test('the header badge shows no pain number when two pain reports are open', async () => {
  const pain = (id: string, score: number, severity: string) => ({
    escalation_id: id, severity, status: 'open', metadata: PAIN,
    reason: `Athlete ath_1 reported pain at the knee at severity ${score}/10. Self-reported by the athlete, not assessed by a coach or a medical provider.`,
  });
  global.fetch = jest.fn(async () => jsonResponse({ ok: true, escalations: [pain('p1', 8, 'critical'), pain('p2', 5, 'high')] })) as unknown as typeof fetch;

  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<SafetyAttentionBadge role="coach" />));
  });

  expect(container.textContent).toContain('SAFETY 2 · PAIN REPORTS');
  expect(container.textContent).not.toMatch(/\d+\/10/);
});

test.each(['athlete', 'parent', 'board', 'platform_owner', 'volunteer'])(
  'a %s session never gets the badge, so never the pain number',
  async (role) => {
    const fetchMock = jest.fn(async () => jsonResponse({ ok: true, escalations: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<SafetyAttentionBadge role={role} />));
    });
    expect(container.innerHTML).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

/* A REPEATED-PATTERN PAIN ESCALATION (metadata.trigger_key) carries no score
   anywhere: its reason counts reports ("Triggered 'athlete_pain_report' N
   times..."; escalationLadder.ts detectRepeatedPatternEscalations). So on
   every surface it reads "Pain report" on the restricted mark at critical and
   at high alike, with no number (option A, by Overwatch's condition). */
test.each(['critical', 'high'] as const)('a %s repeated-pattern pain escalation reads "Pain report" with no number', async (severity) => {
  const row = {
    escalation_id: `esc_rp_${severity}`,
    source_type: 'repeated_pattern',
    athlete_id: 'ath_1',
    severity,
    reason: "Triggered 'athlete_pain_report' 3 times in the last 14 days -- review the pattern.",
    status: 'open',
    escalated_to_role: 'coach',
    created_at: '2026-08-14T18:00:00.000Z',
    metadata: { trigger_key: 'athlete_pain_report', occurrence_count: 3, window_days: 14 },
  };
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/auth/session')) return jsonResponse({ ok: true, role: 'admin' });
    return jsonResponse({ ok: true, escalations: [row] });
  }) as unknown as typeof fetch;

  render(<EscalationsPage />);
  const tr = (await screen.findByText(row.reason)).closest('tr') as HTMLElement;
  expect(tr.querySelector('.badge')?.textContent).toBe('▲Pain report');
  expect(tr.querySelector('.badge')?.className).toContain('badge--restricted');
  expect(tr.textContent).not.toMatch(/\d+\/10/);
  expectNoMedicalStopMark(tr);
});

test('only the safety-record pages carry the number; every other route reads false', () => {
  expect(showsPainNumber('/admin/escalations')).toBe(true);
  expect(showsPainNumber('/admin/safety-review')).toBe(true);
  expect(showsPainNumber('/admin/safety-flags')).toBe(true);
  for (const route of ['/admin', '/admin/pin', '/admin/activation-codes', '/admin/people', '/admin/escalations/x', '/admin/escalationsx', '/coach', '/wall', '', null, undefined]) {
    expect(showsPainNumber(route)).toBe(false);
  }
});

test('a lone critical pain report beside an ordinary high: the number belongs to the pain report, HIGH to the other', async () => {
  global.fetch = jest.fn(async () => jsonResponse({
    ok: true,
    escalations: [
      { escalation_id: 'e1', severity: 'high', status: 'open', metadata: {} },
      {
        escalation_id: 'p1', severity: 'critical', status: 'open', metadata: PAIN,
        reason: 'Athlete ath_1 reported pain at the knee at severity 8/10. Self-reported by the athlete, not assessed by a coach or a medical provider.',
      },
    ],
  })) as unknown as typeof fetch;

  await act(async () => {
    render(<SafetyAttentionBadge role="organization_admin" />);
  });

  expect(screen.getByText('SAFETY 1 · PAIN REPORT 8/10 · 1 · HIGH')).toBeTruthy();
  expect(screen.getByText('Safety 1 pain report 8/10, 1 high')).toBeTruthy();
});

/* ------------------------------------------------------------------------
 * THE MARK ANYWHERE ELSE (lane U1, SC2-2, widened by lane SWP, SWP-1; Jason,
 * card OW25-48 A: "Medical-stop mark only for a medical stop"; Overwatch Q6:
 * the whole non-home population).
 *
 * The cases above render the escalation surfaces. The rest reads the source:
 *   1. every non-test source file under app/, components/, lib/ and src/, comments
 *      removed by the TypeScript parser (not a hand-written lexer: a JSX
 *      apostrophe or a nested template literal holding a URL used to flip the
 *      lexer's quote state and hide the mark), for the token family:
 *      alert--critical, badge--locked and every other spelling of --locked
 *      (var(--locked), border-(--locked), --locked-ink, --locked-deep,
 *      --locked-rgb; not an unlisted --locked-<word>), the --safety-locked / --status-critical /
 *      --status-danger aliases, the string 'locked' (how a tone map reaches
 *      `badge--${tone}`), and every class the CSS paints with the family;
 *   2. the CSS the app loads (app/globals.css and the design system, imports
 *      resolved): a rule that paints the family must be on CSS_ALLOWED;
 *   3. each `alert--${x}` / `badge--${x}` / 'badge--' + x site, asked of the
 *      TypeScript checker: a site that can be 'critical' (alert) or 'locked'
 *      (badge) must be in a file on MARK_ALLOWED, and a site the checker cannot
 *      resolve to string literals is on UNRESOLVED_TONE_SITES with its reason.
 *
 * What this does NOT see: a mark applied by an inline style built at run time,
 * a class string that comes from an API response, `.concat()`, `.join()`, a
 * name split across `+` pieces (`'badge-' + '-' + t`) or written with escapes,
 * or any other way of building a tone class than `${}` or `+` (a `+` chain is
 * read by the string it ends in before the variable), a Tailwind utility
 * that names the colour without the token, and nothing is rendered here.
 *
 * A file may carry the mark only if it is
 *   - ALLOWED, with the reason, and no more often than today; or
 *   - PENDING: still to be swept, no more often than today. A PENDING file that
 *     no longer carries the mark fails here until it is deleted, so the lists
 *     only shrink. The CSS and tone lists below shrink the same way.
 * ------------------------------------------------------------------------ */

const MARK_ALLOWED = new Map<string, { readonly count: number; readonly why: string }>([
  // The clearance badge moved here from the Clearance Board (lane AS-5, Q-B1 = A on #2041); the board and Athlete Safety draw it.
  ['components/clearanceReading.ts', { count: 1, why: "the clearance badge's 'not cleared' (the Clearance Board and Athlete Safety): a clearance record saying MEDICALLY_NOT_ALLOWED, the one medical stop" }],
  ['app/coach/decision-loop/page.tsx', { count: 2, why: "the Medical Administrative Status 'not_cleared' (the clearance record), and the tone type that names it" }],
  ['app/admin/waiver-status/page.tsx', { count: 1, why: "Tonight's 'Not cleared' when the clearance record itself says not_cleared (Overwatch Q5); a hold alone is restricted" }],
  ['app/admin/safety-flags/page.tsx', { count: 1, why: 'a blocking flag that is a clinician stop (concussion_rest_period, rtp_not_cleared; Overwatch Q5); other blocking flags are restricted' }],
  ['app/admin/safety-review/page.tsx', { count: 1, why: 'the same clinician-stop blocking flags as /admin/safety-flags (Overwatch Q5)' }],
  ['app/admin/shadow/page.tsx', { count: 1, why: "the WORD 'locked' for a SHADOW feature not yet unlocked, on the restricted rung; not a class" }],
  ['components/uiStyles.ts', { count: 6, why: "token definitions (statusDanger, errorButton, errorContainer, errorText) that nothing renders" }],
]);

/** Still to be swept, with today's count: SC2-3 (office, board and platform pages). */
const MARK_PENDING_SC2_3 = new Map<string, number>([
  // Swept in SC2-3 (lane U1). Kept empty so the next sweep's list reads alike.
]);

/** Still to be swept, with today's count: SC2-4 (athlete sign-in, athlete and parent pages). */
const MARK_PENDING_SC2_4 = new Map<string, number>([]);

/**
 * CSS rules that paint the family, keyed by the rule's first selector (with its
 * @media prefix when it sits in one). `count` is the declarations in it that
 * use the family, summed over every rule with that key. `mark: true` means the
 * rule draws the medical-stop mark, so its class names join the source tokens
 * above and a component using one must be on MARK_ALLOWED. `mark: false` is a
 * rule that borrows a colour and is not the mark. Like MARK_ALLOWED, the list
 * only shrinks: an entry whose rule is gone, or that paints fewer declarations,
 * fails until it is edited down.
 */
const CSS_ALLOWED = new Map<string, { readonly count: number; readonly mark: boolean; readonly why: string; readonly selectors?: string }>([
  [':root', { count: 3, mark: false, why: 'the aliases --safety-locked, --status-critical and --status-danger, each var(--locked) (app/globals.css); a use of an alias is counted as the mark in source' }],
  ['.tactical-chip-critical', { count: 1, mark: true, why: 'unused today (no component names it); a component that does is the mark and fails here. app/globals.css belongs to lane U2' }],
  ['.tactical-btn-critical', { count: 1, mark: true, why: 'unused today, as .tactical-chip-critical' }],
  ['.tactical-alert-critical', { count: 3, mark: true, why: 'unused today, as .tactical-chip-critical' }],
  ['.badge--locked', { count: 2, mark: true, why: "the mark's own definition: the badge rung for a medical stop (design-system/legacy/ppbf-leather-brass.css)" }],
  ['@media print | .badge--locked', { count: 2, mark: true, why: "the mark's own definition, for print" }],
  ['.alert--critical', { count: 2, mark: true, why: "the mark's own definition: the alert rung for a medical stop" }],
  [
    '.mat-leather .stamp',
    {
      count: 1,
      mark: false,
      // The whole selector list, pinned: a class added to this rule would borrow the ink with no count change, and a component using it would not be counted.
      selectors: '.mat-leather .stamp, .mat-leather--raised .stamp, .mat-leather--worn .stamp, .mat-brass--dark .stamp, .mat-slate .stamp, .mat-wood .stamp, .mat-wood--dark .stamp',
      why: "a bare .stamp on the seven dark materials takes the pale --locked-ink because the stamp red is unreadable on dark hides (ppbf-leather-brass.css, its own comment; Overwatch's Q2 = A on #2046; OD-2026-09-29-001: red is free to use). It is not a mark class: a bare 'stamp' in a component is not counted",
    },
  ],
]);

/** `alert--${x}` / `badge--${x}` sites the checker cannot prove, keyed `file :: expression`, with why. */
const UNRESOLVED_TONE_SITES = new Map<string, string>([
  ['components/CoachLiveTiles.tsx :: badge.tone', "Tile's badge.tone is typed string. Its three call sites pass 'restricted' and 'monitor' (read by hand, #2046 section 4). Typing it as the ladder's union would let the checker prove it (lane 6C7's file)"],
]);

const WEB_ROOT = path.resolve(__dirname, '..');
const SCANNED_DIRS = ['app', 'components', 'lib', 'src'];
const SCANNED_FILE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/;

/** Every non-test .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs under app/, components/, lib/ and src/, as paths relative to apps/web. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.next') walk(full);
      } else if (SCANNED_FILE.test(entry.name) && !/\.test\./.test(entry.name)) {
        found.push(path.relative(WEB_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  for (const dir of SCANNED_DIRS) walk(path.join(WEB_ROOT, dir));
  return found.sort();
}

/** Files the parser reported a syntax error in: their counts are not trusted. */
const unparsed: string[] = [];

/**
 * Source with comments removed, by the TypeScript parser. Strings, template
 * literals and JSX text are kept exactly as written, so a `//` inside
 * 'https://x.org' is not a comment. A file the parser cannot read cleanly is
 * recorded in `unparsed` (the parser's own diagnostics; the field is internal to
 * TypeScript, so a missing one reads as a failure, not as a clean parse).
 */
function withoutComments(source: string, fileName = 'file.tsx', record?: string): string {
  const scriptKind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.jsx$/.test(fileName) ? ts.ScriptKind.JSX : /\.(?:js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (record && (!diagnostics || diagnostics.length > 0)) unparsed.push(record);
  return ts.createPrinter({ removeComments: true }).printFile(sourceFile);
}

// --- the CSS the app loads -------------------------------------------------

/** A declaration's value uses one of the family's custom properties. */
const FAMILY_VALUE = /var\(\s*--(?:locked(?:-ink|-deep|-rgb)?|safety-locked|status-critical|status-danger)\s*[,)]/i;

interface CssRule {
  readonly selector: string;
  readonly body: string;
  readonly atRules: string;
}

/**
 * Every style rule in `css`, flat, with the at-rules it sits in. Strings and
 * parentheses are skipped whole, so a brace inside `content: "{"` or a url() is
 * not a block. An at-rule block with no nested braces (@theme, @font-face) is a
 * declaration block and is returned as a rule of its own. CSS nesting is not
 * used in these sheets; a nested block throws, so a sheet that starts nesting
 * fails here instead of being misread. @media print is kept (the mark's print
 * rule is listed as its own key).
 */
function cssRules(css: string): CssRule[] {
  const text = css.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\/\*[\s\S]*?\*\//g, (_all, quoted?: string) => quoted ?? ' ');
  const rules: CssRule[] = [];
  const atRules: string[] = [];
  let prelude = '';
  const skipPast = (from: number, open: string, close: string): number => {
    let depth = 1;
    let j = from + 1;
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (c === '"' || c === "'") {
        j += 1;
        while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      } else if (c === open) depth += 1;
      else if (c === close) depth -= 1;
      j += 1;
    }
    return j;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      prelude += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(') {
      const end = skipPast(i, '(', ')');
      prelude += text.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '{') {
      const head = prelude.trim().replace(/\s+/g, ' ');
      prelude = '';
      const end = skipPast(i, '{', '}');
      const body = text.slice(i + 1, end - 1);
      const hasBlock = /\{/.test(body.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ''));
      if (head.startsWith('@') && hasBlock) {
        atRules.push(head);
        continue;
      }
      if (hasBlock) throw new Error(`CSS nesting inside "${head}": cssRules reads flat rules only`);
      rules.push({ selector: head, body, atRules: atRules.join(' | ') });
      i = end - 1;
      continue;
    }
    if (ch === '}') {
      prelude = '';
      atRules.pop();
      continue;
    }
    if (ch === ';') {
      prelude = '';
      continue;
    }
    prelude += ch;
  }
  return rules;
}

/** A selector list's parts, split only on commas outside (), [] and quotes. */
function selectorParts(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of list) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      depth += 1;
    } else if (ch === ')' || ch === ']') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/** A rule body's declarations, split on `;` outside () and quotes. */
function declarations(body: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
    } else if (ch === ';' && depth === 0) {
      found.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  found.push(current.trim());
  return found.filter(Boolean);
}

/** The rules that paint the family: key, how many declarations do, and the class names in the selector. */
function paintingRules(css: string): Array<{ key: string; count: number; classes: string[]; selectors: string }> {
  const found: Array<{ key: string; count: number; classes: string[]; selectors: string }> = [];
  for (const rule of cssRules(css)) {
    const count = declarations(rule.body).filter((declaration) => FAMILY_VALUE.test(declaration.slice(declaration.indexOf(':') + 1))).length;
    if (count === 0) continue;
    const parts = selectorParts(rule.selector);
    const key = `${rule.atRules.startsWith('@media print') ? '@media print | ' : ''}${parts[0]}`;
    found.push({ key, count, selectors: rule.selector, classes: [...rule.selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]) });
  }
  return found;
}

function loadedCss(): string {
  return `${readDesignSystemCss(DESIGN_SYSTEM_ENTRY)}\n${fs.readFileSync(path.join(WEB_ROOT, 'app/globals.css'), 'utf8')}`;
}

// --- the token ---------------------------------------------------------------

/** The family, in any spelling: `--locked` followed by anything but a word character or hyphen (so var(--locked), border-(--locked) and badge--locked), its -ink/-deep/-rgb forms, the aliases, alert--critical and the string 'locked'. */
const FAMILY_TOKEN = String.raw`alert--critical|--locked(?![\w-])|--locked-(?:ink|deep|rgb)\b|--safety-locked|--status-critical|--status-danger|['"\x60]locked['"\x60]`;

/** The token plus the classes the CSS paints with the mark (a `mark: true` rule). */
function markTokenFor(markClasses: readonly string[]): RegExp {
  const classes = markClasses.map((name) => `(?<![\\w-])${name.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\w-])`);
  return new RegExp([FAMILY_TOKEN, ...classes].join('|'), 'g');
}

const CSS_PAINTING = paintingRules(loadedCss());
const MARK_CLASSES = [...new Set(CSS_PAINTING.filter(({ key }) => CSS_ALLOWED.get(key)?.mark ?? true).flatMap(({ classes }) => classes))];
const MARK_TOKEN = markTokenFor(MARK_CLASSES);

function markCountsInSource(): Map<string, number> {
  const counts = new Map<string, number>();
  unparsed.length = 0;
  for (const relative of sourceFiles()) {
    const found = withoutComments(fs.readFileSync(path.join(WEB_ROOT, relative), 'utf8'), relative, relative).match(MARK_TOKEN);
    if (found) counts.set(relative, found.length);
  }
  return counts;
}

/** Non-test files under app/, components/ and src/, other than the badge's own, that name the shared clearance badge. */
function clearanceBadgeUsers(): string[] {
  return sourceFiles()
    .filter((relative) => relative !== 'components/clearanceReading.ts')
    .filter((relative) => {
      const raw = fs.readFileSync(path.join(WEB_ROOT, relative), 'utf8');
      // Parse only a file that names it at all (the parse of every file took 2.5 s of a 5 s limit).
      return /\b(clearanceBadge|CLEARANCE_BADGE)\b/.test(raw) && /\b(clearanceBadge|CLEARANCE_BADGE)\b/.test(withoutComments(raw, relative));
    })
    .sort();
}

// --- the tone sites ------------------------------------------------------------

interface ToneSite {
  readonly file: string;
  readonly line: number;
  readonly family: 'alert' | 'badge' | 'tactical';
  readonly expression: string;
  /** The string literals the checker says the expression can be. */
  readonly literals: readonly string[];
  /** True when some member of its type is not a string literal. */
  readonly unresolved: boolean;
}

/**
 * Each `alert--${x}`, `badge--${x}` and 'alert--' + x site in `files`, with the
 * type the TypeScript checker gives x. Only these two ways of building the class
 * are read (see the block comment). `rootNames` are absolute paths.
 */
function toneSites(rootNames: readonly string[], options: ts.CompilerOptions, relativeTo: string): ToneSite[] {
  const program = ts.createProgram([...rootNames], options);
  const checker = program.getTypeChecker();
  const sites: ToneSite[] = [];
  for (const file of rootNames) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) throw new Error(`the checker could not open ${file}`);
    const read = (prefix: string, expression: ts.Expression) => {
      const match = /(alert|badge)--$|(tactical)-(?:alert|chip|btn)-$/.exec(prefix);
      if (!match) return;
      const type = checker.getTypeAtLocation(expression);
      const members = type.isUnion() ? type.types : [type];
      sites.push({
        file: path.relative(relativeTo, file).split(path.sep).join('/'),
        line: sourceFile.getLineAndCharacterOfPosition(expression.getStart()).line + 1,
        family: (match[1] ?? match[2]) as ToneSite['family'],
        expression: expression.getText(),
        literals: members.filter((member): member is ts.StringLiteralType => member.isStringLiteral()).map((member) => member.value),
        unresolved: members.some((member) => !member.isStringLiteral()),
      });
    };
    const visit = (node: ts.Node) => {
      if (ts.isTemplateExpression(node)) {
        let prefix = node.head.text;
        for (const span of node.templateSpans) {
          read(prefix, span.expression);
          prefix = span.literal.text;
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const before = trailingText(node.left);
        if (before !== null) read(before, node.right);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites;
}

/** The string literal a `+` chain ends in: 'a' gives 'a'; 'a' + 'b' gives 'b'; anything else gives null. */
function trailingText(expression: ts.Expression): string | null {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return trailingText(expression.expression);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) return trailingText(expression.right);
  return null;
}

function appToneSites(): ToneSite[] {
  const files = sourceFiles()
    .filter((relative) => /(?:alert|badge)--\$\{|tactical-(?:alert|chip|btn)-\$\{|['"`](?:(?:alert|badge)--|tactical-(?:alert|chip|btn)-)['"`]\s*\+/.test(fs.readFileSync(path.join(WEB_ROOT, relative), 'utf8')))
    .map((relative) => path.join(WEB_ROOT, relative));
  const config = ts.readConfigFile(path.join(WEB_ROOT, 'tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, WEB_ROOT).options;
  return toneSites(files, options, WEB_ROOT);
}

/** Where a tone class is the mark: `badge--${x}` can be 'locked'; `alert--${x}` and the CSS's `tactical-alert-${x}` (and -chip-, -btn-) can be 'critical'. */
const isMarkTone = (site: ToneSite) => site.literals.includes(site.family === 'badge' ? 'locked' : 'critical');

describe('the medical-stop mark appears nowhere else in the source', () => {
  const counts = markCountsInSource();
  const pending = new Map([...MARK_PENDING_SC2_3, ...MARK_PENDING_SC2_4]);

  // The two inputs the hand-written lexer misread (U1 named them; #2046 measured
  // guard 0, TypeScript parser 1). Each holds the mark once, in code.
  test('a JSX apostrophe does not hide a later string that holds the mark', () => {
    const source = "export const A = () => <p>Don't</p>;\nconst u = 'https://example.org'; const cls = \"alert alert--critical\";\n";
    expect(withoutComments(source).match(MARK_TOKEN)).toHaveLength(1);
  });

  test('a nested template literal holding a URL does not hide the mark after it', () => {
    const source = "const a = `${ok ? `https://a.org` : 'x'} y`; const c = 'badge badge--locked'\n";
    expect(withoutComments(source, 'a.ts').match(MARK_TOKEN)).toHaveLength(1);
  });

  test('a comment that names the mark is not counted; code that holds a comment marker in a string is', () => {
    expect(withoutComments('const m = /filename="([^"]+)"/.exec(h); // badge--locked\n/* alert--critical */ x', 'a.ts').match(MARK_TOKEN)).toBeNull();
    expect(withoutComments('a = "video/*"; b = "badge--locked"; // badge--locked\nc = 1;', 'a.ts').match(MARK_TOKEN)).toHaveLength(1);
  });

  test.each([
    ['"border-(--locked) bg-(--safety-locked)"', 2],
    ['"text-[color:var(--locked-deep)]"', 1],
    ['{ color: "var(--status-danger)" }', 1],
    ['"var(--locked-ink)" + "var(--locked-rgb)"', 2],
    ['"var(--locked, #a81e22)"', 1],
    ['"var(--stamp-red)"', 0],
    ['"var(--locked-other)"', 0],
  ])('the token reads %s as %i use(s)', (value, expected) => {
    expect(withoutComments(`const x = ${value};`, 'a.ts').match(MARK_TOKEN)?.length ?? 0).toBe(expected);
  });

  test('a class the CSS paints with the mark counts in a component; a class that only borrows a colour does not', () => {
    expect(MARK_CLASSES).toEqual(expect.arrayContaining(['tactical-alert-critical', 'badge--locked', 'alert--critical']));
    expect(MARK_CLASSES).not.toContain('stamp');
    expect(withoutComments('const c = "ge-tile tactical-btn-critical"', 'a.ts').match(MARK_TOKEN)).toHaveLength(1);
    expect(withoutComments('const c = "stamp mat-leather"', 'a.ts').match(MARK_TOKEN)).toBeNull();
  });

  // What this proves: every scanned file parses without a syntax error, so no
  // count rests on a half-read file.
  test('every scanned file parses cleanly', () => {
    expect(unparsed).toEqual([]);
  });

  test('the scan sees the one real medical stop, so it is not blind', () => {
    expect(counts.get('components/clearanceReading.ts')).toBe(1);
  });

  test('the scan walks src/ as well as app/ and components/', () => {
    expect(sourceFiles().some((file) => file.startsWith('src/'))).toBe(true);
    expect(sourceFiles().some((file) => file.startsWith('app/'))).toBe(true);
    expect(sourceFiles().some((file) => file.startsWith('components/'))).toBe(true);
    expect(sourceFiles().some((file) => file.startsWith('lib/'))).toBe(true);
    // Not only .ts/.tsx: a .mjs under src/ is read too.
    expect(sourceFiles()).toContain('src/testing/legacyLoaderGoldenData/generate.mjs');
  });

  // The scan counts the mark's TOKEN, so it cannot see a file that draws the
  // mark by reading the shared badge (lane AS-5, Q-B1 = A on #2041). The badge
  // map is not exported; this pins which files draw a clearance through
  // clearanceBadge(), the ones MARK_ALLOWED's reason names. Another file
  // drawing it has to be added here, with its reason.
  test('the one real medical stop is drawn only where its reason says: the Clearance Board and Athlete Safety', () => {
    expect(clearanceBadgeUsers()).toEqual(['app/coach/athlete-safety/page.tsx', 'app/coach/sports-medicine/page.tsx']);
  });

  // And the badge's own file hands the map out only through clearanceBadge().
  // An alias (`export { CLEARANCE_BADGE as ... }`), a re-export or a wrapper
  // exported under a new name would let a third page draw the mark past both
  // checks above, so its exports are pinned: a new one is added here, with its
  // reason, and is not a way to the badge.
  test('the badge\'s own file exports no other way to the badge than clearanceBadge()', () => {
    const source = withoutComments(fs.readFileSync(path.resolve(__dirname, 'clearanceReading.ts'), 'utf8'), 'clearanceReading.ts');
    expect(source).not.toMatch(/\bexport\s*(\{|\*|default\b)/);
    const exported = [...source.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|type|interface|class|enum)\s+(\w+)/g)]
      .map((match) => match[1])
      .sort();
    expect(exported).toEqual([
      'ActiveHold', 'CLEARANCE_UNREAD', 'ClearanceReading', 'ClearanceValue', 'clearanceBadge', 'isActiveHold',
      'isClearanceRow', 'isoInstant', 'readActiveHold', 'readClearance', 'whenPassed',
    ]);
    // Every `export` in the file is one of those declarations.
    expect((source.match(/\bexport\b/g) ?? []).length).toBe(exported.length);
  });

  test('every file that carries the mark is allowed, with its reason, or still pending a sweep', () => {
    const unexplained = [...counts.keys()].filter((file) => !MARK_ALLOWED.has(file) && !pending.has(file));
    expect(unexplained).toEqual([]);
  });

  test('no allowed or pending file carries the mark more often than it does today', () => {
    const limits = new Map([...[...MARK_ALLOWED].map(([file, { count }]) => [file, count] as const), ...pending]);
    const grown = [...limits].filter(([file, count]) => (counts.get(file) ?? 0) > count).map(([file]) => file);
    expect(grown).toEqual([]);
  });

  test('the pending lists only shrink: a swept file is taken off', () => {
    const swept = [...pending.keys()].filter((file) => !counts.has(file));
    expect(swept).toEqual([]);
  });
});

describe('the CSS the app loads paints the medical-stop family only where it is listed', () => {
  // The scanner is checked on a fixture before it is trusted on the sheets: a
  // brace in a string, a comment holding a rule, a declaration-only at-rule, a
  // rule under @media, and a selector list whose first part is the key.
  const FIXTURE = `
    /* .commented { color: var(--locked); } */
    :root { --a: var(--locked); --b: #fff; --c: var( --safety-locked ); }
    @theme { --color-x: var(--status-danger); }
    @media print { .p, .q { color: var(--locked-ink); } }
    @media (min-width: 40rem) { .wide .y { content: "}{"; border: 1px solid var(--locked-rgb, red); } }
    .quiet { color: var(--stamp-red); background: url("a{b}.png"); }
    .multi, .other .child { background: var(--status-critical); color: var(--locked-deep); }
  `;

  test('the scanner reads the rules, strings, comments and at-rules of a fixture as expected', () => {
    expect(paintingRules(FIXTURE)).toEqual([
      { key: ':root', count: 2, classes: [], selectors: ':root' },
      { key: '@theme', count: 1, classes: [], selectors: '@theme' },
      { key: '@media print | .p', count: 1, classes: ['p', 'q'], selectors: '.p, .q' },
      { key: '.wide .y', count: 1, classes: ['wide', 'y'], selectors: '.wide .y' },
      { key: '.multi', count: 2, classes: ['multi', 'other', 'child'], selectors: '.multi, .other .child' },
    ]);
  });

  test('a nested block fails loudly instead of being misread', () => {
    expect(() => cssRules('.a { color: red; .b { color: var(--locked); } }')).toThrow(/nesting/);
  });

  test('the scanner reads the sheets, so it is not blind', () => {
    expect(cssRules(loadedCss()).length).toBeGreaterThan(500);
    expect(CSS_PAINTING.map(({ key }) => key)).toEqual(expect.arrayContaining(['.badge--locked', '.alert--critical', ':root']));
  });

  test('every rule that paints the family is listed, with its reason', () => {
    const unlisted = [...new Set(CSS_PAINTING.map(({ key }) => key))].filter((key) => !CSS_ALLOWED.has(key));
    expect(unlisted).toEqual([]);
  });

  test('each listed rule paints exactly the declarations its entry counts: a rule that paints fewer, or no longer paints, is edited down or taken off', () => {
    const painted = new Map<string, number>();
    for (const { key, count } of CSS_PAINTING) painted.set(key, (painted.get(key) ?? 0) + count);
    const grown = [...CSS_ALLOWED].filter(([key, { count }]) => (painted.get(key) ?? 0) > count).map(([key]) => key);
    // A rule that paints fewer declarations than its entry says leaves slack a later use could hide in.
    const shrunk = [...CSS_ALLOWED].filter(([key, { count }]) => (painted.get(key) ?? 0) < count).map(([key]) => key);
    expect({ grown, shrunk }).toEqual({ grown: [], shrunk: [] });
  });

  test('a rule that only borrows the ink is pinned to its whole selector list, so no new class joins it unseen (Q2 = A)', () => {
    const drifted = CSS_PAINTING.filter(({ key, selectors }) => {
      const entry = CSS_ALLOWED.get(key);
      return entry?.mark === false && entry.selectors !== undefined && entry.selectors !== selectors;
    }).map(({ key, selectors }) => `${key} -> ${selectors}`);
    expect(drifted).toEqual([]);
    // Every mark:false entry that can carry a class must say which classes.
    expect([...CSS_ALLOWED].filter(([key, entry]) => !entry.mark && entry.selectors === undefined && key !== ':root')).toEqual([]);
  });
});

describe('a runtime tone class cannot carry the mark unseen', () => {
  const sites = appToneSites();

  // Fixtures: the checker is asked about code written to the temp directory, so
  // the cases that must go red are shown going red (the mutation proof for
  // SWP-1 adds the same shapes to a real scanned file).
  function fixtureSites(code: string): ToneSite[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tone-fixture-'));
    try {
      const file = path.join(dir, 'fixture.tsx');
      fs.writeFileSync(file, code);
      return toneSites([file], { strict: true, jsx: ts.JsxEmit.Preserve, noResolve: true, target: ts.ScriptTarget.ES2020 }, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("an alert--${tone} whose type can be 'critical' is a mark site (U1's third gap)", () => {
    const [site] = fixtureSites("type Sev = 'low' | 'critical';\nexport const f = (s: Sev) => `alert alert--${s}`;\n");
    expect(site).toMatchObject({ family: 'alert', expression: 's', literals: ['low', 'critical'], unresolved: false });
    expect(isMarkTone(site)).toBe(true);
  });

  test("a badge--${tone} that can be 'locked' is a mark site, and one that cannot is not", () => {
    const [locked, plain] = fixtureSites(
      "export const a = (t: 'cleared' | 'locked') => `badge badge--${t}`;\nexport const b = (t: 'monitor' | 'restricted') => 'badge--' + t;\n",
    );
    expect([isMarkTone(locked), isMarkTone(plain)]).toEqual([true, false]);
  });

  test("a chained + ('badge ' + 'badge--' + t) is read, as is the CSS's single-dash tactical-alert-${t}", () => {
    const [chain, tactical] = fixtureSites(
      "export const a = (t: 'ok' | 'locked') => 'badge ' + 'badge--' + t;\nexport const b = (t: 'ok' | 'critical') => `tactical-alert-${t}`;\n",
    );
    expect([chain.family, isMarkTone(chain), tactical.family, isMarkTone(tactical)]).toEqual(['badge', true, 'tactical', true]);
  });

  test('a tone typed string is unresolved, and the checker says so', () => {
    const [site] = fixtureSites('export const f = (t: string) => `badge badge--${t}`;\n');
    expect(site).toMatchObject({ literals: [], unresolved: true });
  });

  test('the checker reads the real sites, so it is not blind', () => {
    expect(sites.length).toBeGreaterThanOrEqual(7);
    const decisionLoop = sites.find(({ file }) => file === 'app/coach/decision-loop/page.tsx');
    expect(decisionLoop?.literals).toContain('locked');
  });

  test('a site that can be the mark is in a file on MARK_ALLOWED', () => {
    const unexplained = sites.filter((site) => isMarkTone(site) && !MARK_ALLOWED.has(site.file)).map(({ file, line }) => `${file}:${line}`);
    expect(unexplained).toEqual([]);
  });

  test('a site the checker cannot resolve is listed with its reason, and the list only shrinks', () => {
    const unresolved = sites.filter((site) => site.unresolved).map(({ file, expression }) => `${file} :: ${expression}`);
    expect(unresolved.filter((key) => !UNRESOLVED_TONE_SITES.has(key))).toEqual([]);
    expect([...UNRESOLVED_TONE_SITES.keys()].filter((key) => !unresolved.includes(key))).toEqual([]);
  });
});
