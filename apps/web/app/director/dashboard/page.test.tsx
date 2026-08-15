/**
 * @jest-environment jsdom
 */

// This route used to render fabricated safety escalations behind a live
// organization_admin guard. The honesty contract now is the inverse: the
// page must show NO incident data of any kind and point at the real queue.

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import DirectorDashboardPage from './page';

jest.mock('@/src/server/pilot/pageGuard', () => ({
  requirePageRole: jest.fn(async () => undefined),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

test('shows no incident data, says the mock is gone, and points at the real surfaces', async () => {
  const { container } = render(await DirectorDashboardPage());

  // The old prototype's hazard: invented incidents that read as real. No
  // interactive controls and no incident-shaped content may exist here.
  expect(container.querySelectorAll('input, textarea, select, button')).toHaveLength(0);
  expect(screen.queryByText(/ESC-/)).toBeNull();
  expect(screen.getByText(/demonstration escalation queue with invented incidents/)).toBeTruthy();

  const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  expect(hrefs).toContain('/admin/escalations');
  expect(hrefs).toContain('/admin/safety-review');
});
