/**
 * @jest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import MedicalRestrictionsPage from './page';

// The shell gates on a signed-in role; what is under test is the page itself:
// it loads the roster into the staff panel, says so when it cannot, and links
// back to the clearance board.
jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children, allowedRoles }: { children: ReactNode; allowedRoles: string[] }) => (
    <main data-roles={allowedRoles.join(',')}>{children}</main>
  ),
}));
jest.mock('@/components/WorkAxis', () => ({ __esModule: true, default: () => null }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

function serve(roster: () => Response) {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/pilot/athletes/list')) return roster();
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => jest.restoreAllMocks());

test('admits coach and admin, and offers the roster to the panel', async () => {
  serve(() => ({ ok: true, status: 200, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Test Member' }] }) } as Response));
  const { container } = render(<MedicalRestrictionsPage />);
  expect(container.querySelector('main')?.getAttribute('data-roles')).toBe('coach,admin');
  expect(await screen.findByRole('option', { name: 'Test Member' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Clearance Board' }).getAttribute('href')).toBe('/coach/sports-medicine');
});

test('a roster that will not load says so, and shows no panel', async () => {
  serve(() => ({ ok: false, status: 500, json: async () => ({}) } as Response));
  render(<MedicalRestrictionsPage />);
  expect(await screen.findByText('Your roster could not be loaded. Reload to try again.')).toBeTruthy();
  expect(screen.queryByLabelText('Member')).toBeNull();
});
