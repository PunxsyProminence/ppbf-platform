/**
 * @jest-environment jsdom
 */

/**
 * THIS PAGE HAD NO TEST. It is the setup wizard that creates a new gym --
 * the one surface in the visual batch with no approved mockup behind it at
 * all (checked against the full 40-board AF set and docs/MOCKUP_TO_REPO_MAP.md;
 * neither names an Organizations screen this route's four-step wizard could
 * be checked against). The only change here is the work-axis foot every other
 * full-screen board in the batch carries, so this is the minimum that proves
 * it landed without breaking the one thing a platform owner opens this page
 * to do -- reach Step 1.
 */

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import SetupWizard from './page';

jest.mock('@/components/usePilotSession', () => ({
  usePilotSession: () => ({ loading: false, role: 'platform_owner', authProvider: 'microsoft' }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

test('a platform owner reaches Step 1, with the same foot every board carries', async () => {
  render(<SetupWizard />);

  expect(await screen.findByRole('heading', { name: /Step 1: Create Your Gym Profile/i })).toBeTruthy();
  expect(screen.getByRole('list', { name: 'The work axis' })).toBeTruthy();
});
