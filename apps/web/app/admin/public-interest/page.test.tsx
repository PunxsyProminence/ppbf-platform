/**
 * @jest-environment jsdom
 */

// AS12-2, BOA-11 (OD-2026-10-17-001 ruling 1): this shell page named itself
// twice, two ways -- "Public Interest Review" on the band and "Public
// Interest" on the page. The band now carries the page title.

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import PublicInterestReviewPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children, roleLabel }: { readonly children: ReactNode; readonly roleLabel?: string }) => (
    <div data-testid="shell" data-role-label={roleLabel}>{children}</div>
  ),
}));

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('the shell band title is the page title, Public Interest', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })) as unknown as typeof fetch;

  await act(async () => {
    render(<PublicInterestReviewPage />);
  });

  const title = screen.getByRole('heading', { level: 1 }).textContent?.trim();
  expect(title).toBe('Public Interest');
  expect(screen.getByTestId('shell').getAttribute('data-role-label')).toBe(title);
});
