/**
 * @jest-environment jsdom
 */

// F-003. The three pages whose routes serve ['board'] alone: a platform owner
// (admitted to the subtree by BoardRoleGate) gets an honest WRONG DOOR stamp
// and NO request is made -- not a 403 drawn as "Unavailable", and not a
// redirect after the board-summary reads have already fired. A board session
// still reads every route as before.

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import { useBoardSession } from '@/components/BoardRoleGate';
import BoardAggregatesPage from './aggregates/page';
import BoardComplianceMonitoringPage from './compliance-monitoring/page';
import BoardEscalationMonitoringPage from './escalation-monitoring/page';

const gateRoles: string[][] = [];

// RoleSessionGate is replaced by a pass-through that records what it was
// asked to admit, so the suite can pin that the page gate is ['board'].
jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ allowedRoles, children }: { readonly allowedRoles: string[]; readonly children: ReactNode }) => {
    gateRoles.push([...allowedRoles]);
    return children;
  },
}));

jest.mock('@/components/BoardRoleGate', () => ({
  __esModule: true,
  useBoardSession: jest.fn(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className }: { readonly children: ReactNode; readonly href: string; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

const mockUseBoardSession = jest.mocked(useBoardSession);
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  gateRoles.length = 0;
  jest.clearAllMocks();
});

const PAGES = [
  ['compliance-monitoring', BoardComplianceMonitoringPage, ['/api/pilot/board/compliance-summary']],
  ['escalation-monitoring', BoardEscalationMonitoringPage, ['/api/pilot/board/escalation-summary']],
  ['aggregates', BoardAggregatesPage, [
    '/api/pilot/board/volunteer-summary',
    '/api/pilot/board/external-competition-summary',
    '/api/pilot/board/wrestling-league-summary',
  ]],
] as const;

async function renderAs(Page: () => ReactNode, role: 'board' | 'platform_owner') {
  mockUseBoardSession.mockReturnValue({ role, seats: [] });
  // A body that matches no page's success envelope: these tests are about
  // whether a request is made, not about what is drawn from it.
  const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<Page />);
  });
  return fetchMock;
}

describe.each(PAGES)('/board/%s', (_slug, Page, endpoints) => {
  test('platform owner: WRONG DOOR stamp, no request at all, no "Unavailable"', async () => {
    const fetchMock = await renderAs(Page, 'platform_owner');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('WRONG DOOR')).toBeTruthy();
    expect(screen.getByText(
      'Not available for this role — these figures are served to board members only.',
    )).toBeTruthy();
    expect(screen.queryByText(/unavailable/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Board Hub' }).getAttribute('href')).toBe('/board');
    // The page's own gate is never even reached.
    expect(gateRoles).toHaveLength(0);
  });

  test('board: the page gate admits board alone and every route is read', async () => {
    const fetchMock = await renderAs(Page, 'board');

    expect(screen.queryByText('WRONG DOOR')).toBeNull();
    expect(gateRoles.length).toBeGreaterThan(0);
    for (const roles of gateRoles) {
      expect(roles).toEqual(['board']);
    }
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    for (const endpoint of endpoints) {
      expect(urls.some((url) => url.includes(endpoint))).toBe(true);
    }
  });
});
