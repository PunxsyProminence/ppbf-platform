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

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import EscalationsPage, { SOURCE_LABEL } from '@/app/admin/escalations/page';
import SafetyReviewPage from '@/app/admin/safety-review/page';
import CoachIntelligencePage from '@/app/coach/intelligence/page';
import CoachWorkspace from './CoachWorkspace';
import SafetyAttentionBadge, { showsPainNumber } from './SafetyAttentionBadge';

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
 * THE MARK ANYWHERE ELSE (lane U1, SC2-2; Jason, card OW25-48 A: "Medical-stop
 * mark only for a medical stop"; Overwatch Q6: the whole non-home population).
 *
 * The cases above render the escalation surfaces. This one reads the source:
 * every non-test .ts/.tsx under app/ and components/, comments removed by a
 * string-aware pass (a `/*` or `//` inside a string such as accept="video/*"
 * is code, not a comment), for what draws --locked: alert--critical,
 * badge--locked, var(--locked), --locked-ink, the --safety-locked /
 * --status-critical / --status-danger aliases, and the string 'locked', which
 * is how a tone map reaches `badge--${tone}`. Not caught: a class built from a
 * tone whose VALUE is 'critical' (`alert--${tone}`); app/admin/memberships is
 * the one such page, swept in SC2-3. CSS is not read.
 *
 * A file may carry the mark only if it is
 *   - ALLOWED, with the reason, and no more often than today; or
 *   - PENDING: still to be swept by the next U1 PRs (SC2-3, SC2-4), no more
 *     often than today. Each of those PRs deletes its files from the list, and
 *     a PENDING file that no longer carries the mark fails here until it is
 *     deleted, so the lists only shrink.
 * ------------------------------------------------------------------------ */

const MARK_TOKEN = /alert--critical|badge--locked|--locked-ink|var\(--locked\)|var\(--safety-locked\)|var\(--status-critical\)|var\(--status-danger\)|['"`]locked['"`]/g;

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
 * Source with comments removed; strings (and what is inside them) kept.
 * `unbalanced` is set when the file ends still inside a string: a quote the
 * pass misread (in a regex literal or bare JSX text) has flipped which spans
 * it treats as code, so the count for that file cannot be trusted.
 */
let unbalanced = false;
function withoutComments(source: string): string {
  unbalanced = false;
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length;) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
      continue;
    }
    // A regex literal: a `/` where a value starts (after an operator, an
    // opening bracket, a comma or `return`). Its quotes and slashes are not
    // strings or comments (/filename="([^"]+)"/ has three quotes).
    // Not after `<`: `</div>` closes a tag, it is not a regex.
    if (c === '/' && /(^|[=(,:[!&|?{};+\-*%~^]|\breturn)\s*$/.test(out.slice(-12))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n') {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        j += 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i += 1;
  }
  unbalanced = quote !== null;
  return out;
}

/** Files the comment pass ended inside a string: their counts are not trusted. */
const misread: string[] = [];

function markCountsInSource(): Map<string, number> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const webRoot = path.resolve(__dirname, '..');
  const counts = new Map<string, number>();
  misread.length = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        const relative = path.relative(webRoot, full).split(path.sep).join('/');
        const found = withoutComments(fs.readFileSync(full, 'utf8')).match(MARK_TOKEN);
        if (unbalanced) misread.push(relative);
        if (found) counts.set(relative, found.length);
      }
    }
  };
  walk(path.join(webRoot, 'app'));
  walk(path.join(webRoot, 'components'));
  return counts;
}

/** Non-test files under app/ and components/, other than the badge's own, that name the shared clearance badge. */
function clearanceBadgeUsers(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const webRoot = path.resolve(__dirname, '..');
  const users: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        const relative = path.relative(webRoot, full).split(path.sep).join('/');
        if (relative === 'components/clearanceReading.ts') continue;
        if (/\b(clearanceBadge|CLEARANCE_BADGE)\b/.test(withoutComments(fs.readFileSync(full, 'utf8')))) users.push(relative);
      }
    }
  };
  walk(path.join(webRoot, 'app'));
  walk(path.join(webRoot, 'components'));
  return users.sort();
}

describe('the medical-stop mark appears nowhere else in the source', () => {
  const counts = markCountsInSource();
  const pending = new Map([...MARK_PENDING_SC2_3, ...MARK_PENDING_SC2_4]);

  test('the comment pass skips a regex literal, whose quotes are not strings', () => {
    expect(withoutComments('const m = /filename="([^"]+)"/.exec(h); // badge--locked\nx')).toBe('const m = /filename="([^"]+)"/.exec(h); \nx');
    expect(unbalanced).toBe(false);
    expect(withoutComments('a = b / c; d = "e"; // f\ng')).toBe('a = b / c; d = "e"; \ng');
  });

  test('the comment pass keeps code that holds a comment marker inside a string', () => {
    expect(withoutComments('a = "video/*"; b = "badge--locked"; // badge--locked\nc = 1; /* alert--critical */ d')).toBe(
      'a = "video/*"; b = "badge--locked"; \nc = 1;   d',
    );
  });

  // What this proves: no file ENDS inside a string. A quote misread mid-file
  // that a later quote happens to re-balance is not caught here.
  test('the comment pass ends every file outside a string', () => {
    expect(misread).toEqual([]);
  });

  test('the scan sees the one real medical stop, so it is not blind', () => {
    expect(counts.get('components/clearanceReading.ts')).toBe(1);
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    const source = withoutComments(fs.readFileSync(path.resolve(__dirname, 'clearanceReading.ts'), 'utf8'));
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
