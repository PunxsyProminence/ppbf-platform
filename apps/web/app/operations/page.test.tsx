/**
 * @jest-environment jsdom
 */

// Mission Control presented invented readiness and governance alerts as a live
// operational feed. Athlete-safety wording is the worst place in the app for
// invented data, and the panel had no feed behind it at all.

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import OperationsHubPage from './page';
import type { ClubRole } from '@/components/roleRoutes';

const capturedRoles: ClubRole[][] = [];

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ allowedRoles, children }: { readonly allowedRoles: ClubRole[]; readonly children: ReactNode }) => {
    capturedRoles.push(allowedRoles);
    return children;
  },
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  capturedRoles.length = 0;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true, announcements: [] }) } as Response)) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

async function renderPage() {
  await act(async () => {
    render(<OperationsHubPage />);
  });
}

test('the platform owner can reach the hub alongside every gym role', async () => {
  await renderPage();

  expect(capturedRoles[0]).toContain('platform_owner');
  expect(capturedRoles[0]).toContain('athlete');
  expect(capturedRoles[0]).toContain('coach');
});

test('no invented safety or governance alert is presented as live data', async () => {
  await renderPage();

  expect(screen.queryByText(/readiness flags are below safe threshold/i)).toBeNull();
  expect(screen.queryByText(/governance deadline enters risk window/i)).toBeNull();
  expect(screen.queryByText(/capture rate remains at 100%/i)).toBeNull();
});

// The command node's stamp is gone because the feed behind it is real. The
// doctrine the stamp carried is the part that must survive: whatever state the
// feed is in — and under this harness's generic fetch mock it settles on the
// honest-empty state — the panel must say an empty feed is not a clear floor,
// and must never claim to be planned-only again.
test('the alert panel reads the record and never lets empty look clear', async () => {
  await renderPage();

  const panel = screen.getByRole('heading', { name: 'SHADOW COMMAND NODE' }).parentElement as HTMLElement;
  await screen.findByText(/nothing has been recorded/i);
  expect(panel.textContent).toMatch(/not that the floor is clear/i);
  expect(panel.textContent).not.toContain('PLANNED | NOT YET IMPLEMENTED');
});

test('SHADOW Monitoring reads as shipped with the human-alarm boundary stated', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'SHADOW Monitoring' });
  const card = heading.closest('article') as HTMLElement;
  expect(card.textContent).toContain('EXISTS');
  expect(card.textContent).toMatch(/remains a human decision/i);
});

test('the notices authoring surface is reachable from the hub', async () => {
  await renderPage();

  expect(screen.getByRole('link', { name: 'Notices & Motivation' }).getAttribute('href')).toBe('/notices');
});

// The capability map is supposed to be reality-based; it was telling
// operators a shipped, staging-verified console (T-003's admin/video-review)
// didn't exist, while calling a screen with real upload/playback/persistence
// a "mock-only" placeholder. Pinned so a future edit can't quietly revert
// either claim.
test('Video Review Intelligence reads as shipped, not a placeholder', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'Video Review Intelligence' });
  const card = heading.closest('article') as HTMLElement;
  expect(card.textContent).toContain('EXISTS');
  expect(card.textContent).not.toContain('PLACEHOLDER');
  const link = card.querySelector('a') as HTMLAnchorElement | null;
  expect(link?.getAttribute('href')).toBe('/admin/video-review');
});

test('AI Video Analysis reads as partial (real upload/playback), not mock-only', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'AI Video Analysis' });
  const card = heading.closest('article') as HTMLElement;
  expect(card.textContent).toContain('PARTIAL');
  expect(card.textContent).not.toContain('mock-only');
});

// The progression loop's three role surfaces (athlete, coach, parent) all
// read the real pilot progression records now; only automated gap detection
// is still planned. Pinned so the row can't quietly slide back to claiming
// the whole capability is a placeholder.
test('Closed-Loop Progression Intelligence reads as partial (real records), not a placeholder', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'Closed-Loop Progression Intelligence' });
  const card = heading.closest('article') as HTMLElement;
  expect(card.textContent).toContain('PARTIAL');
  expect(card.textContent).not.toContain('PLACEHOLDER');
});

// Performance Analytics shipped as a read-only rollup over existing records
// (sessions, readiness, activity log, progression) with a route and page of
// its own. Pinned the same way as the other shipped rows.
// The clearance board shipped with the owner's visibility boundary as its
// defining constraint. Pinned so the row can neither slide back to
// placeholder nor quietly drop the no-clinical-detail statement.
test('Sports Medicine reads as partial with the no-clinical-detail boundary stated', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'Sports Medicine' });
  const card = heading.closest('article') as HTMLElement;
  expect(card.textContent).toContain('PARTIAL');
  expect(card.textContent).not.toContain('PLACEHOLDER');
  expect(card.textContent).toMatch(/no diagnoses or clinical detail/i);
});

test('Performance Analytics reads as shipped, not a placeholder', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'Performance Analytics' });
  const card = heading.closest('article') as HTMLElement;
  expect(card.textContent).toContain('EXISTS');
  expect(card.textContent).not.toContain('PLACEHOLDER');
  const link = card.querySelector('a') as HTMLAnchorElement | null;
  expect(link?.getAttribute('href')).toBe('/coach/performance-analytics');
});

// The wrestling-league skeleton shipped with the owner's deliberate-minimalism
// constraint as its defining note. Pinned in both directions: the row can't
// slide back to placeholder, and it can't quietly claim more than the
// skeleton actually is.
test('Wrestling League Management reads as partial with the skeleton boundary stated', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'Wrestling League Management' });
  const card = heading.closest('article') as HTMLElement;
  expect(card.textContent).toContain('PARTIAL');
  expect(card.textContent).not.toContain('PLACEHOLDER');
  expect(card.textContent).toMatch(/until a real league defines them/i);
});

// The external-competition skeleton shipped under the same deliberate-
// minimalism decision, pinned the same two directions as the league row.
test('External Competition Platform reads as partial with the skeleton boundary stated', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'External Competition Platform' });
  const card = heading.closest('article') as HTMLElement;
  expect(card.textContent).toContain('PARTIAL');
  expect(card.textContent).not.toContain('PLACEHOLDER');
  expect(card.textContent).toMatch(/until real competitions define them/i);
});

// Membership and scholarship tracking shipped as real records with the
// scholarship-as-discount rule as the defining constraint. Pinned so neither
// row can slide back to planning mode nor quietly drop the never-a-bypass
// statement.
test('Membership and Scholarship Tracking read as shipped with the discount rule stated', async () => {
  await renderPage();

  const membership = screen.getByRole('heading', { name: 'Membership Tracking' }).closest('article') as HTMLElement;
  expect(membership.textContent).toContain('EXISTS');
  expect(membership.textContent).toMatch(/Billing is not built/i);

  const scholarship = screen.getByRole('heading', { name: 'Scholarship Tracking' }).closest('article') as HTMLElement;
  expect(scholarship.textContent).toContain('EXISTS');
  expect(scholarship.textContent).toMatch(/never bypasses/i);
});

// Item 9 was assessed and parked, not silently skipped. The row must say so
// and must carry the PARKED-table id, so the radar and ACTIVE_WORK.md cannot
// drift apart about whether this work is remembered.
test('Publication Workflow Automation reads as parked with its backlog id', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'Publication Workflow Automation' });
  const card = heading.closest('article') as HTMLElement;
  expect(card.textContent).toContain('BACKLOG-publication-automation');
  expect(card.textContent).toMatch(/human-gated on purpose/i);
});

// The radar is hand-maintained and had gone stale in both directions: it
// missed capabilities that ship with persistent records and route tests, and
// it still advertised the removed "BREAK MY 40% RULE" override token.
test('the radar lists the shipped coach-floor capabilities as existing', async () => {
  await renderPage();

  expect(await screen.findByText('Session Script Delivery')).toBeTruthy();
  expect(screen.getByText('Safety Compliance Center')).toBeTruthy();
  expect(screen.getByText('Coach Coverage')).toBeTruthy();
  expect(screen.getByText('Drill Library')).toBeTruthy();
  expect(screen.getByText(/backed by pilot.session_script_runs/)).toBeTruthy();
});

test('the removed override token is not advertised anywhere on the hub', async () => {
  await renderPage();

  await screen.findByText('Session Script Delivery');
  expect(screen.queryByText(/BREAK MY 40% RULE/)).toBeNull();
  expect(screen.queryByText(/GRIND STATE ENGAGED/)).toBeNull();
});

// THE FALSE CERTIFICATION PANEL. Mission Control used to carry a panel titled
// "System Diagnostics and SHADOW Certification" that ended in a green stamp
// reading "Signed & Active" over "Certification Status: Signed and Active".
// Nothing signed it: every claim in it was a module-level const in page.tsx —
// no signer, no timestamp, no build id, nothing fetched. It also mis-stated the
// platform. Its "Mathematical Gate Validation" block presented the readiness
// equation as a live safety gate, while formulas/registry.ts registers that
// exact formula (LEGACY-READINESS) as 'experimental_unsupported' because
// "Coefficients, input scales, fairness, and clinical/safety validity are
// unproven. It must not clear, restrict, or prescribe training." It claimed a
// 5.0 protective threshold that does not exist (the real constants are
// READINESS_GREEN_MIN = 7 / READINESS_YELLOW_MIN = 4, and they are display
// triage colours, not constraints), and "12-role viewport segregation" against
// a ClubRole union of 16.
//
// This is the surface staff use to ask whether the platform is safe to run on,
// so a fabricated safety certification is the worst possible thing to leave on
// it. These tests fail if any of it comes back.
describe('the hub certifies nothing it cannot show a signer for', () => {
  test('no safety-certification stamp is rendered', async () => {
    await renderPage();

    expect(document.querySelector('.stamp--green')).toBeNull();
    expect(screen.queryByText(/signed\s*&\s*active/i)).toBeNull();
    expect(screen.queryByText(/certification status/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bcertification\b/i);
    expect(document.body.textContent).not.toMatch(/\bsigned\b/i);
  });

  test('no unsupported formula is presented as an active safety gate', async () => {
    await renderPage();

    expect(screen.queryByRole('heading', { name: /mathematical gate validation/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/sleep\s*x\s*1\.25/i);
    expect(document.body.textContent).not.toMatch(/delta rpe\s*=/i);
  });

  test('no invented threshold or role count is stated', async () => {
    await renderPage();

    expect(document.body.textContent).not.toMatch(/below 5\.0/i);
    expect(document.body.textContent).not.toMatch(/12-role/i);
    expect(document.body.textContent).not.toMatch(/viewport segregation/i);
  });

  test('the fabricated build and preset signals are gone', async () => {
    await renderPage();

    expect(document.body.textContent).not.toMatch(/production build v21\.1/i);
    expect(document.body.textContent).not.toMatch(/ultra-dense winter grit/i);
    expect(document.body.textContent).not.toMatch(/verified_by_jason/i);
  });
});
