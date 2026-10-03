/**
 * @jest-environment jsdom
 */

// A failed catalogue read must not print "(0, 0 on sale)" in the heading:
// that count is a claim about a list nobody read.

import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import GearPage from './page';

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

test('a failed catalogue read shows the error and no zero count', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;

  await act(async () => {
    render(<GearPage />);
  });

  expect(await screen.findByText('The catalogue could not be loaded.')).toBeTruthy();
  expect(screen.queryByText(/The catalogue \(0, 0 on sale\)/)).toBeNull();
});
