/**
 * @jest-environment jsdom
 */

// This page is the board's only reader for three count-only routes, and every
// way it could mislead a fiduciary is a way one figure gets drawn as another.
// Pinned here: the role it admits, the envelope it accepts, a withheld figure
// drawn as a withheld figure rather than as a zero, a measured zero drawn as a
// real zero rather than as a withholding, and a failed read drawn as a failure
// rather than as an empty register.

import type { ReactNode } from 'react';
import { act, render, screen, within } from '@testing-library/react';

import BoardAggregatesPage from './page';

const mockGate: { allowedRoles: string[] | null } = { allowedRoles: null };

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ allowedRoles, children }: { readonly allowedRoles: string[]; readonly children: ReactNode }) => {
    mockGate.allowedRoles = allowedRoles;
    return children;
  },
}));

type Metric = { status: 'available' | 'unavailable' | 'insufficient_data'; count: number | null };

const empty: Metric = { status: 'unavailable', count: null };
const suppressed: Metric = { status: 'insufficient_data', count: null };

function volunteerFixture(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'organization_aggregate',
    minimumCohortSize: 5,
    generatedAt: '2026-08-10T12:00:00.000Z',
    volunteersByStatus: { active: empty, pending: empty, inactive: empty },
    newVolunteers30Days: empty,
    ...overrides,
  };
}

function competitionFixture(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'organization_aggregate',
    minimumCohortSize: 5,
    generatedAt: '2026-08-10T12:00:00.000Z',
    competitionsByStatus: { planned: 0, completed: 0, cancelled: 0 },
    entriesByResult: { won: empty, lost: empty, draw: empty, no_contest: empty },
    ...overrides,
  };
}

function leagueFixture(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'organization_aggregate',
    minimumCohortSize: 5,
    generatedAt: '2026-08-10T12:00:00.000Z',
    seasonsByStatus: { planned: 0, active: 0, completed: 0 },
    rosteredAthletes: empty,
    ...overrides,
  };
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  mockGate.allowedRoles = null;
  jest.clearAllMocks();
});

/** Answers each of the three routes from its own fixture, or refuses it. */
function mockRoutes(routes: {
  volunteer?: unknown;
  competition?: unknown;
  league?: unknown;
  refuse?: string[];
  envelope?: 'ok' | 'success';
}) {
  const envelopeKey = routes.envelope === 'success' ? 'success' : 'ok';
  const fetchMock = jest.fn().mockImplementation((url: string) => {
    const path = String(url);
    if ((routes.refuse ?? []).some((fragment) => path.includes(fragment))) {
      return Promise.resolve({ ok: false, json: async () => ({}) });
    }
    const summary = path.includes('volunteer-summary')
      ? routes.volunteer ?? volunteerFixture()
      : path.includes('external-competition-summary')
        ? routes.competition ?? competitionFixture()
        : routes.league ?? leagueFixture();
    return Promise.resolve({ ok: true, json: async () => ({ [envelopeKey]: true, summary }) });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderPage(routes: Parameters<typeof mockRoutes>[0] = {}) {
  const fetchMock = mockRoutes(routes);
  await act(async () => {
    render(<BoardAggregatesPage />);
  });
  return fetchMock;
}

function tile(label: string): HTMLElement {
  const heading = screen.getByText(label);
  const article = heading.closest('article');
  if (!article) {
    throw new Error(`No tile rendered for ${label}`);
  }
  return article;
}

test('admits board alone, because the routes behind it refuse a platform owner', async () => {
  // Not a copy of the sibling board pages, deliberately. BoardRoleGate admits
  // platform_owner and the other sub-pages pass ['board', 'platform_owner'],
  // but all three routes here gate on ['board'] and
  // volunteer-summary/route.test.ts pins the platform_owner refusal. Widening
  // this list would render a page whose every figure is a silent 403.
  await renderPage();

  expect(mockGate.allowedRoles).toEqual(['board']);
});

test('reads the three aggregate routes and nothing else', async () => {
  const fetchMock = await renderPage();

  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls).toHaveLength(3);
  expect(urls.some((url) => url.includes('/api/pilot/board/volunteer-summary'))).toBe(true);
  expect(urls.some((url) => url.includes('/api/pilot/board/external-competition-summary'))).toBe(true);
  expect(urls.some((url) => url.includes('/api/pilot/board/wrestling-league-summary'))).toBe(true);
  // The registers themselves are 403 for a board session; this page must not
  // reach for one because it is rendering their totals.
  expect(urls.some((url) => url.includes('/api/admin/volunteers'))).toBe(false);
  expect(urls.some((url) => url.includes('/api/pilot/operations/'))).toBe(false);
});

test('accepts the ok envelope these routes actually send', async () => {
  await renderPage({
    volunteer: volunteerFixture({
      volunteersByStatus: { active: { status: 'available', count: 12 }, pending: empty, inactive: empty },
    }),
  });

  expect(tile('Active Volunteers').textContent).toContain('12');
  expect(screen.queryByText('Unable to load the volunteer aggregate.')).toBeNull();
});

test('a success envelope is not an ok envelope, and is refused rather than half-read', async () => {
  // /api/pilot/board/summary answers `success: true` and BoardSummaryPanel
  // checks that field; these three answer `ok: true`. A reader that accepted
  // the wrong key would be permanently, silently wrong in one direction or
  // the other -- this pins which envelope this page is reading.
  await renderPage({ envelope: 'success' });

  expect(screen.getByText('Unable to load the volunteer aggregate.')).toBeTruthy();
  expect(screen.getByText('Unable to load the external competition aggregate.')).toBeTruthy();
  expect(screen.getByText('Unable to load the wrestling league aggregate.')).toBeTruthy();
});

test('a suppressed figure is a withheld stamp, never a small number and never a zero', async () => {
  await renderPage({
    volunteer: volunteerFixture({
      volunteersByStatus: { active: suppressed, pending: empty, inactive: empty },
    }),
  });

  const active = tile('Active Volunteers');
  expect(active.textContent).toContain('Suppressed');
  expect(active.textContent).toContain('Fewer than 5 volunteers');
  expect(within(active).queryByText('0')).toBeNull();
  expect(active.querySelector('.stamp')).not.toBeNull();
});

test('a measured zero is a real zero, and says which kind of zero it is', async () => {
  // Season and competition counts are organizational scheduling facts with no
  // cohort floor: the server hands them over as raw integers, so 0 here is the
  // measurement rather than a withholding. It has to read as one, and it must
  // not wear the stamp the withheld figures wear.
  await renderPage();

  const planned = tile('Seasons Planned');
  expect(within(planned).getByText('0')).toBeTruthy();
  expect(planned.textContent).toContain('A counted zero');
  expect(planned.textContent).not.toContain('Suppressed');
  expect(planned.querySelector('.stamp')).toBeNull();

  const competitions = tile('Competitions Planned');
  expect(within(competitions).getByText('0')).toBeTruthy();
  expect(competitions.textContent).toContain('A counted zero');
});

test('an empty gated bucket says nothing was recorded rather than printing a zero', async () => {
  await renderPage();

  const inactive = tile('Inactive Volunteers');
  expect(inactive.textContent).toContain('None recorded');
  expect(within(inactive).queryByText('0')).toBeNull();
});

test('a failed read is a failure on that section, not an empty register', async () => {
  await renderPage({ refuse: ['volunteer-summary'] });

  expect(screen.getByText('Unable to load the volunteer aggregate.')).toBeTruthy();
  // The refused section must not fall back to the vocabulary of a real
  // measurement: "None recorded" would tell a board nobody is volunteering.
  const active = tile('Active Volunteers');
  expect(active.textContent).toContain('Not read');
  expect(active.textContent).not.toContain('None recorded');
  expect(within(active).queryByText('0')).toBeNull();
});

test('one route failing does not blank the two that answered', async () => {
  await renderPage({
    refuse: ['volunteer-summary'],
    league: leagueFixture({ rosteredAthletes: { status: 'available', count: 9 } }),
  });

  expect(screen.getByText('Unable to load the volunteer aggregate.')).toBeTruthy();
  expect(screen.queryByText('Unable to load the wrestling league aggregate.')).toBeNull();
  expect(tile('Rostered Athletes').textContent).toContain('9');
});
