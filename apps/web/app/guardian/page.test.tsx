/**
 * @jest-environment jsdom
 */

// The /guardian page renders no data of its own -- it is a description of the
// family side. These pin the two honesty properties that description needs:
// a working signpost to the real surface, and no link circling back to itself.

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';

import GuardianPortalPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/ShadowChatButton', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className }: { readonly children: ReactNode; readonly href: string; readonly className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

test('signposts the Family Dashboard as the working surface', () => {
  render(<GuardianPortalPage />);

  const cta = screen.getByRole('link', { name: 'Open your Family Dashboard' });
  expect(cta).toHaveAttribute('href', '/parent/dashboard');
  // The description says where the data actually is, instead of implying this
  // page shows it.
  expect(screen.getByText(/The place you actually see your child/)).toBeInTheDocument();
});

test('no link on this page circles back to /guardian itself', () => {
  render(<GuardianPortalPage />);

  const selfLinks = screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('href') === '/guardian');
  expect(selfLinks).toHaveLength(0);
});

test('the explainer section names the dashboard as where those surfaces live', () => {
  render(<GuardianPortalPage />);

  expect(screen.getByText('What the Family Dashboard Covers')).toBeInTheDocument();
  expect(screen.queryByText('What You Can See Here')).not.toBeInTheDocument();
});
