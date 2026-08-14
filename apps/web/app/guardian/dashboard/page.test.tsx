/**
 * @jest-environment jsdom
 */

// This route used to accept a minor's media-consent tick and a typed safety
// concern into useState and nothing else. The honesty contract now is the
// inverse: the page must collect NOTHING and point at the real surfaces.

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import GuardianDashboardPage from './page';

jest.mock('@/src/server/pilot/pageGuard', () => ({
  requirePageRole: jest.fn(async () => undefined),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

test('collects nothing, says why, and points at the real consent and reporting surfaces', async () => {
  const { container } = render(await GuardianDashboardPage());

  // The old prototype's whole hazard: inputs that recorded nothing. None may
  // exist here in any form.
  expect(container.querySelectorAll('input, textarea, select, button')).toHaveLength(0);
  expect(screen.getByText(/nothing you enter here\s+would be saved/i)).toBeTruthy();

  const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  expect(hrefs).toContain('/parent/consent');
  expect(hrefs).toContain('/parent/dashboard');
});
