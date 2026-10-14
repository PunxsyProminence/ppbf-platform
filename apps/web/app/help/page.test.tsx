/**
 * @jest-environment jsdom
 */

// /help was internal tester material served to anyone on the internet (audit
// PUBLIC-06). Lane N4-02 puts it behind sign-in with every role admitted:
// signing in is the only gate, so no member loses it and no visitor gets it.

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import { requirePageRole } from '@/src/server/pilot/pageGuard';
import type { PilotRole } from '@/src/server/pilot/contracts';
import HelpCenterPage from './page';

jest.mock('@/src/server/pilot/pageGuard', () => ({
  requirePageRole: jest.fn(),
}));

jest.mock('@/components/OperationsLink', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <a href="/operations">{children}</a>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockRequirePageRole = requirePageRole as jest.Mock;

const EVERY_ROLE: PilotRole[] = [
  'platform_owner',
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'board',
  'volunteer',
  'staff',
];

beforeEach(() => {
  mockRequirePageRole.mockReset();
  mockRequirePageRole.mockResolvedValue({ role: 'coach' });
});

test('asks the server guard for a signed-in member, admitting every role', async () => {
  render(await HelpCenterPage());

  expect(mockRequirePageRole).toHaveBeenCalledTimes(1);
  const [allowed] = mockRequirePageRole.mock.calls[0] as [PilotRole[]];
  expect([...allowed].sort()).toEqual([...EVERY_ROLE].sort());
  expect(screen.getByText('Help for coaches')).toBeTruthy();
});

test('a visitor who is not signed in is redirected and gets none of the help content', async () => {
  // requirePageRole signals a redirect by throwing (next/navigation redirect).
  mockRequirePageRole.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));

  await expect(HelpCenterPage()).rejects.toThrow('NEXT_REDIRECT:/login');
});

test.each([
  ['organization_admin', true],
  ['admin', true],
  ['platform_owner', true],
  ['coach', false],
  ['athlete', false],
  ['parent', false],
  ['board', false],
  ['staff', false],
  ['volunteer', false],
] as const)('a %s is offered the Admin Hub link: %s', async (role, offered) => {
  mockRequirePageRole.mockResolvedValue({ role });
  const { container } = render(await HelpCenterPage());
  const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  expect(hrefs.includes('/admin')).toBe(offered);
});

// F-064: a reader is shown their own role's help, chosen on the server.
const OTHER_ROLE_MARKERS = [
  'Coach Workspace Guide', 'Board Workspace Guide', 'Admin Hub Guide', 'Revenue & Funding Guide',
  'Development Lab Guide', 'Tester Guide', 'Coach Guide', 'Board Guide', 'Admin Guide', 'Revenue Guide', 'Parent Guide', 'Athlete Guide', 'FRONT-END SAFE', 'MIXED LIVE + PLACEHOLDER',
  'owner decision on 2026-08-26', 'PPBF MASTER TUTORIAL',
];

test.each(['parent', 'athlete', 'coach', 'staff', 'board', 'volunteer'] as const)(
  'a %s is sent none of the builder tutorial, in the HTML itself',
  async (role) => {
    mockRequirePageRole.mockResolvedValue({ role });
    const { container } = render(await HelpCenterPage());
    for (const marker of OTHER_ROLE_MARKERS) {
      expect(container.innerHTML).not.toContain(marker);
    }
  },
);

test('a parent reads parent help in plain words and no other roles sections', async () => {
  mockRequirePageRole.mockResolvedValue({ role: 'parent' });
  render(await HelpCenterPage());
  expect(screen.getByText('Help for parents and guardians')).toBeTruthy();
  expect(screen.getByText('Messages')).toBeTruthy();
  expect(screen.queryByText(/Clearance|Revenue|Treasurer/)).toBeNull();
});

test('a role the page does not know gets the smallest set', async () => {
  mockRequirePageRole.mockResolvedValue({ role: 'something_new' });
  const { container } = render(await HelpCenterPage());
  expect(screen.getByText('Help')).toBeTruthy();
  expect(container.querySelectorAll('article').length).toBe(1);
});

test.each(['organization_admin', 'admin'] as const)('a gym administrator (%s) gets plain admin help, not the builder tutorial', async (role) => {
  mockRequirePageRole.mockResolvedValue({ role });
  const { container } = render(await HelpCenterPage());
  expect(screen.getByText('Help for gym administrators')).toBeTruthy();
  for (const marker of ['Tester Guide', 'Development Lab Guide', 'Board Workspace Guide', 'FRONT-END SAFE',
    'owner decision on 2026-08-26', 'PPBF MASTER TUTORIAL']) {
    expect(container.innerHTML).not.toContain(marker);
  }
});

test.each(['staff', 'volunteer'] as const)('a %s seat gets the smallest set, not the coach workspace', async (role) => {
  mockRequirePageRole.mockResolvedValue({ role });
  const { container } = render(await HelpCenterPage());
  expect(screen.getByText('Help')).toBeTruthy();
  expect(container.innerHTML).not.toContain('coach workspace');
  expect(container.querySelectorAll('article').length).toBe(1);
});

test('the parent help says replies are possible and makes no "not built yet" claim', async () => {
  mockRequirePageRole.mockResolvedValue({ role: 'parent' });
  const { container } = render(await HelpCenterPage());
  expect(container.textContent).toContain('you can reply to them there');
  expect(container.textContent).not.toMatch(/not built yet|no feed behind|planned/i);
});

test('the platform owner keeps the whole tutorial', async () => {
  mockRequirePageRole.mockResolvedValue({ role: 'platform_owner' });
  const { container } = render(await HelpCenterPage());
  expect(container.innerHTML).toContain('Tester Guide');
  expect(container.innerHTML).toContain('Development Lab Guide');
});
