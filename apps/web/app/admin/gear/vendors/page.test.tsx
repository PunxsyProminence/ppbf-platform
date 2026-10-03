/**
 * @jest-environment jsdom
 */

// A failed supplier read must not print "(0, 0 current)" in the heading:
// that count is a claim about a list nobody read.

import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import VendorsPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(() => {
  jest.restoreAllMocks();
});

test('a failed supplier read shows the error and no zero count', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;

  await act(async () => {
    render(<VendorsPage />);
  });

  expect(await screen.findByText('The supplier list could not be loaded.')).toBeTruthy();
  expect(screen.queryByText(/Suppliers \(0, 0 current\)/)).toBeNull();
});
