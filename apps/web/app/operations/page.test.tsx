/**
 * @jest-environment jsdom
 */

// Mission Control presented invented readiness and governance alerts as a live
// operational feed. Athlete-safety wording is the worst place in the app for
// invented data, and the panel had no feed behind it at all.

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import OperationsHubPage from './page';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';
import type { ClubRole } from '@/components/roleRoutes';
import { OPERATIONS_ROLES } from '@/components/operationsAccess';

const capturedRoles: ClubRole[][] = [];

/* The gate is stubbed to a passthrough for the content tests -- most of this
   file describes what the register prints, and routing it through a real
   session check every time would test RoleSessionGate instead.
   `useRealGate` flips it back on for the refusal tests at the bottom, which
   are the only ones that need it and the only ones that can prove it. Same
   switch app/research/page.test.tsx uses for the same reason. */
let useRealGate = false;

jest.mock('@/components/RoleSessionGate', () => {
  const React = jest.requireActual('react');
  const actual = jest.requireActual('@/components/RoleSessionGate');
  return {
    __esModule: true,
    default: (props: { readonly allowedRoles: ClubRole[]; readonly children: ReactNode }) => {
      capturedRoles.push(props.allowedRoles);
      return useRealGate
        ? React.createElement(actual.default, props)
        : props.children;
    },
  };
});

const mockReplace = jest.fn();
/* ONE router object for the life of the file. RoleSessionGate's effect depends
   on [router], so a mock that builds a fresh object per render re-runs it on
   every render, which re-checks the session forever and hangs the test with
   nothing wrong with the page. The same note is written at the top of
   app/shadow/page.test.tsx, which learned it the same way. */
const mockRouter = { replace: mockReplace, push: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
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
  useRealGate = false;
  mockReplace.mockClear();
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true, announcements: [] }) } as Response)) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  clearRoleSession();
  jest.clearAllMocks();
});

/* The hub reads the viewer's role for VISIBILITY (Operations V1): the lab
   desks and the lab rows of the register render only for the admin desks.
   Most of this file describes the full register, so the default viewer is an
   admin; the role-visibility tests below pass the role they mean. */
async function renderPage(role: ClubRole = 'admin') {
  createPersistentRoleSession(role);
  await act(async () => {
    render(<OperationsHubPage />);
  });
}

/* THE GATE, AFTER THE OWNER DECISION OF 2026-08-26.

   This test used to be called "the platform owner can reach the hub alongside
   every gym role", and it asserted that the allowed list contained 'athlete'
   and 'coach'. That was true, and it was the whole defect: the list was built
   by mapping over the role selector this page renders, so it admitted all
   sixteen roles the platform has. The hub is administration now. */
test('the hub admits the admin desks and nobody else', async () => {
  await renderPage();

  // Equality, not containment: a containment check would still pass if a role
  // were added back, which is exactly the drift this decision is undoing.
  expect(capturedRoles[0]).toEqual(['admin', 'platform_owner']);
});

test('the gate reads the shared policy rather than a list of its own', async () => {
  await renderPage();

  // One source. If this page ever grows its own copy again, these diverge.
  expect(capturedRoles[0]).toEqual([...OPERATIONS_ROLES]);
});

// OPERATIONS V1 (2026-08-21): ordinary roles land in operational work and are
// not offered the lab. This is VISIBILITY ONLY -- hiding a desk from the
// launcher gates nothing, and the data behind every lab surface keeps its own
// API access checks (the same rule buildingMap.ts states for its rows).
//
// These cases render the component DIRECTLY, with the gate mocked to a
// passthrough, so the refused roles below reach the register in a way they no
// longer can through the route. That is on purpose: this describe block is
// about the row-level narrowing surviving on its own, independent of the page
// gate that now also happens to refuse them. The gate's own behaviour is
// proven separately, against the real gate, further down this file.
describe('the lab desks are offered to the admin desks only', () => {
  test.each(['admin', 'platform_owner'] as const)('%s sees OTHER DESKS and the lab register rows', async (role) => {
    await renderPage(role);

    expect(screen.getByRole('heading', { name: 'OTHER DESKS' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Research Intake' }).getAttribute('href')).toBe('/research');
    expect(screen.getByRole('heading', { name: 'SHADOW Monitoring' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Scenario Simulation' })).toBeTruthy();
  });

  /* The other half of this describe used to be a six-role table asserting that
     a coach, an athlete, a parent, staff, a volunteer and a board member each
     "sees the operational desks only" -- that they READ this page, with the
     lab desks hidden. Its premise is retired: none of those six can open the
     hub at all now, and the assertions below prove that instead. What is left
     here is the admin case, which is the only one there is.

     showsLabDesks is consequently always true for anyone who reaches this
     render. It is kept in the page as belt-and-braces against the gate ever
     widening again; there is nothing left for a test to vary. */
});

test('no invented safety or governance alert is presented as live data', async () => {
  await renderPage();

  expect(screen.queryByText(/readiness flags are below safe threshold/i)).toBeNull();
  expect(screen.queryByText(/governance deadline enters risk window/i)).toBeNull();
  expect(screen.queryByText(/capture rate remains at 100%/i)).toBeNull();
});

// THE NIGHT FEED IS NOT FURNITURE IN THIS ROOM. The hub used to mount
// <ShadowCommandFeed /> -- a newest-first event/telemetry feed, the After Hours
// room's own chrome -- under a heading reading "SHADOW COMMAND NODE", inside
// .room--office. ROOM-PURPOSE-DNA forbids night telemetry in the front office
// by name. The panel is a door now, and the log is read in the room that keeps
// it. These fail if the feed is mounted here again, and if the one remaining
// door to that room stops being office-voiced.
test('the night feed is not mounted in the office, only a door to the room that keeps it', async () => {
  await renderPage();

  expect(screen.queryByRole('heading', { name: /shadow command node/i })).toBeNull();
  expect(document.body.textContent).not.toMatch(/reading the operational record/i);
  expect(document.body.textContent).not.toMatch(/nothing is recorded in the operational feed/i);

  const panel = screen.getByRole('heading', { name: 'After Hours' }).parentElement as HTMLElement;
  expect(panel.textContent).toMatch(/kept in the\s+after-hours room, not at this desk/i);
});

test('exactly one door leads to the after-hours room, and it says so', async () => {
  await renderPage();

  const nightDoors = screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('href') === '/admin/shadow');

  expect(nightDoors).toHaveLength(1);
  expect(nightDoors[0].textContent).toBe('Open the after-hours room');
  // The removed second door was labelled "The Office" and opened After Hours.
  expect(screen.queryByRole('link', { name: 'The Office' })).toBeNull();
});

// The register is the office's own furniture: a ruled paper record, not a
// sixth grid of leather tiles. Pinned because "convert it back to cards" is
// exactly the drift that made this room interchangeable with the board room.
test('the capability register renders as a ruled ledger', async () => {
  await renderPage();

  const table = document.querySelector('table.ledger') as HTMLTableElement | null;
  expect(table).not.toBeNull();
  expect(table?.querySelector('caption')?.textContent).toBe('The capability register');
  expect(screen.getByRole('heading', { name: 'Drill Library' }).closest('tr')).not.toBeNull();
});

// The state chips spoke the roadmap's language at a front desk. The record
// keeps its own words; the page prints the clerk's.
test('the register prints clerk words for build state, not spec words', async () => {
  await renderPage();

  await screen.findByText('Drill Library');
  expect(document.body.textContent).not.toMatch(/\bEXISTS\b/);
  expect(document.body.textContent).not.toMatch(/\bPLACEHOLDER\b/);
  expect(document.body.textContent).toMatch(/IN USE/);
});

test('SHADOW Monitoring reads as shipped with the human-alarm boundary stated', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'SHADOW Monitoring' });
  const card = heading.closest('tr') as HTMLElement;
  expect(card.textContent).toContain('IN USE');
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
  const card = heading.closest('tr') as HTMLElement;
  expect(card.textContent).toContain('IN USE');
  expect(card.textContent).not.toContain('NOT BUILT');
  const link = card.querySelector('a') as HTMLAnchorElement | null;
  expect(link?.getAttribute('href')).toBe('/admin/video-review');
});

test('AI Video Analysis reads as partial (real upload/playback), not mock-only', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'AI Video Analysis' });
  const card = heading.closest('tr') as HTMLElement;
  expect(card.textContent).toContain('IN PART');
  expect(card.textContent).not.toContain('mock-only');
});

// The progression loop's three role surfaces (athlete, coach, parent) all
// read the real pilot progression records now; only automated gap detection
// is still planned. Pinned so the row can't quietly slide back to claiming
// the whole capability is a placeholder.
test('Closed-Loop Progression Intelligence reads as partial (real records), not a placeholder', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'Closed-Loop Progression Intelligence' });
  const card = heading.closest('tr') as HTMLElement;
  expect(card.textContent).toContain('IN PART');
  expect(card.textContent).not.toContain('NOT BUILT');
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
  const card = heading.closest('tr') as HTMLElement;
  expect(card.textContent).toContain('IN PART');
  expect(card.textContent).not.toContain('NOT BUILT');
  expect(card.textContent).toMatch(/no diagnoses or clinical detail/i);
});

test('Performance Analytics reads as shipped, not a placeholder', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'Performance Analytics' });
  const card = heading.closest('tr') as HTMLElement;
  expect(card.textContent).toContain('IN USE');
  expect(card.textContent).not.toContain('NOT BUILT');
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
  const card = heading.closest('tr') as HTMLElement;
  expect(card.textContent).toContain('IN PART');
  expect(card.textContent).not.toContain('NOT BUILT');
  expect(card.textContent).toMatch(/until a real league defines them/i);
});

// The external-competition skeleton shipped under the same deliberate-
// minimalism decision, pinned the same two directions as the league row.
test('External Competition Platform reads as partial with the skeleton boundary stated', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'External Competition Platform' });
  const card = heading.closest('tr') as HTMLElement;
  expect(card.textContent).toContain('IN PART');
  expect(card.textContent).not.toContain('NOT BUILT');
  expect(card.textContent).toMatch(/until real competitions define them/i);
});

// Membership and scholarship tracking shipped as real records with the
// scholarship-as-discount rule as the defining constraint. Pinned so neither
// row can slide back to planning mode nor quietly drop the never-a-bypass
// statement.
test('Membership and Scholarship Tracking read as shipped with the discount rule stated', async () => {
  await renderPage();

  const membership = screen.getByRole('heading', { name: 'Membership Tracking' }).closest('tr') as HTMLElement;
  expect(membership.textContent).toContain('IN USE');
  expect(membership.textContent).toMatch(/Billing is not built/i);

  const scholarship = screen.getByRole('heading', { name: 'Scholarship Tracking' }).closest('tr') as HTMLElement;
  expect(scholarship.textContent).toContain('IN USE');
  expect(scholarship.textContent).toMatch(/never bypasses/i);
});

// Item 9 was assessed and parked, not silently skipped. The row must say so
// and must carry the PARKED-table id, so the radar and ACTIVE_WORK.md cannot
// drift apart about whether this work is remembered.
test('Publication Workflow Automation reads as parked with its backlog id', async () => {
  await renderPage();

  const heading = screen.getByRole('heading', { name: 'Publication Workflow Automation' });
  const card = heading.closest('tr') as HTMLElement;
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
  expect(screen.getByText(/pilot\.session_script_runs/)).toBeTruthy();
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

/* ── THE REFUSAL, WITH THE REAL GATE ─────────────────────────────────────────

   Everything above runs with RoleSessionGate stubbed to a passthrough, which
   is right for describing the register and useless for proving who may read
   it: with the gate mocked out, the page body renders for any role and the
   old six-role table passed while asserting the opposite of today's policy.

   These flip the real gate on. It answers a refused role by calling
   router.replace and never setting its authorized state, so the correct
   assertions are: none of the hub is on screen, the holding screen is, and
   the redirect fired. */
describe('a role the hub no longer admits', () => {
  const REFUSED = ['athlete', 'coach', 'parent', 'staff', 'volunteer', 'board'] as const;

  function serverSays(role: string) {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/pilot/auth/session')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ authenticated: true, role, auth_provider: 'microsoft' }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, announcements: [] }) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  test('the table names every role this page used to admit', () => {
    // A table that emptied itself would run none of the cases below and still
    // report green.
    expect(REFUSED.length).toBeGreaterThan(0);
  });

  test.each(REFUSED)('%s never sees the hub, and is sent to their own surface', async (role) => {
    useRealGate = true;
    serverSays(role);

    await act(async () => { render(<OperationsHubPage />); });

    // queryBy*, never getBy*, so a rendered hub fails as an assertion rather
    // than as a thrown lookup.
    expect(screen.queryByRole('heading', { name: 'The Ring' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'WORKSPACES' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'THE ROLE SELECTOR' })).toBeNull();
    expect(mockReplace).toHaveBeenCalled();
  });

  /* NO FLASH. The hub's markup is constructed when the component returns, but
     it is passed to the gate as `children` and must never be mounted. What a
     refused role sees instead is the gate's own holding screen. */
  test('shows the holding screen rather than a moment of the hub', async () => {
    useRealGate = true;
    serverSays('coach');

    await act(async () => { render(<OperationsHubPage />); });

    expect(screen.getByText('Checking access')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'The Ring' })).toBeNull();
  });

  /* A refusal must not spend the refused role's session on requests made for
     a page they cannot read. The hub mounts AnnouncementBanner inside the
     gate; if that ever moves outside it, this catches it. */
  test('asks for nothing on a refused role behalf', async () => {
    useRealGate = true;
    const fetchMock = serverSays('athlete');

    await act(async () => { render(<OperationsHubPage />); });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/api/pilot/auth/session'))).toBe(true);
    expect(urls.some((url) => url.includes('announcement'))).toBe(false);
  });

  /* The other direction, and it is not optional: without it, a gate that
     refused EVERYBODY would pass every test above. */
  test.each(['admin', 'platform_owner'])('%s still reads the hub', async (role) => {
    useRealGate = true;
    serverSays(role);

    await act(async () => { render(<OperationsHubPage />); });

    expect(screen.getByRole('heading', { name: 'The Ring' })).toBeTruthy();
    expect(screen.queryByText('Checking access')).toBeNull();
  });
});
