/**
 * @jest-environment jsdom
 */

// The regression this file exists to prevent already happened once: commit
// d7899044 swapped the real AthleteWorkspace mount for a zero-fetch stub,
// and nothing failed -- check-ins, goals, the training-hold banner, and the
// athlete's only pain-reporting path all silently vanished for months while
// the workspace kept passing its own tests, unmounted. This pins the mount.

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import AthleteDashboardPage from './page';

jest.mock('@/src/server/pilot/pageGuard', () => ({
  requirePageRole: jest.fn(async () => undefined),
}));

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/components/AthleteWorkspace', () => ({
  __esModule: true,
  default: () => <div data-testid="athlete-workspace-mount" />,
}));

test('the athlete landing mounts the real workspace, not a stub', async () => {
  render(await AthleteDashboardPage());

  expect(screen.getByTestId('athlete-workspace-mount')).toBeTruthy();
});
