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
  expect(screen.getByText('PPBF MASTER TUTORIAL')).toBeTruthy();
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
