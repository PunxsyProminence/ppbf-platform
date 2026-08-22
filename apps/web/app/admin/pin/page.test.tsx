/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import PinManagementPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('@/components/roleSession', () => ({
  getRoleSessionSnapshot: () => ({ role: 'admin' }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes('/api/pilot/admin/athlete-pin-directory')) {
      return { ok: true, json: async () => ({ ok: true, items: [] }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('carries the same foot as every other full-screen board', async () => {
  render(<PinManagementPage />);

  expect(await screen.findByText('No athletes found in this organization.')).toBeTruthy();
  expect(screen.getByRole('list', { name: 'The work axis' })).toBeTruthy();
});
