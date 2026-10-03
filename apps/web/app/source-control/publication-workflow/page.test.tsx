/**
 * @jest-environment jsdom
 */

// #991 class (Lane 14 batch 8, R3). The requirement counts on this page
// printed 0 while the read was open and again after it failed: "Open
// Requirements 0" and "(0)" on both requirement panels, directly beside a
// "Load failed" alert. A count is only true of a read that answered.

import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';

import PublicationWorkflowPage from './page';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

function installFetch(requirements: () => Promise<Response>): void {
  global.fetch = jest.fn(async (url: unknown) => {
    if (String(url).includes('/api/pilot/shadow/research-requirements')) return requirements();
    return { ok: true, json: async () => ({ authenticated: true, role: 'admin' }) } as Response;
  }) as unknown as typeof fetch;
}

/** The stat tile's value, read off its own article so a renamed or moved tile
 *  fails here rather than passing on an absent element. */
function tileValue(label: string): string {
  const eyebrow = screen.getByText(label, { selector: 'p.t-eyebrow' });
  const article = eyebrow.closest('article');
  if (!article) throw new Error(`no tile for ${label}`);
  return article.querySelectorAll('p')[1]?.textContent ?? '';
}

test('a failed read prints no requirement count anywhere', async () => {
  installFetch(async () => ({ ok: false, json: async () => ({}) }) as Response);

  render(<PublicationWorkflowPage />);

  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(tileValue('Open Requirements')).toBe('--');
  expect(screen.getByText('Open Research Requirements (--)')).toBeTruthy();
  expect(screen.getByText('Resolved Research Requirements (--)')).toBeTruthy();
  expect(screen.queryByText(/\(0\)/)).toBeNull();
});

test('a network failure prints no requirement count either', async () => {
  installFetch(async () => {
    throw new TypeError('Failed to fetch');
  });

  render(<PublicationWorkflowPage />);

  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(tileValue('Open Requirements')).toBe('--');
});

test('a read that answered prints the real counts, zero included', async () => {
  installFetch(async () => ({
    ok: true,
    json: async () => ({
      items: [
        { research_requirement_id: 1, status: 'open' },
        { research_requirement_id: 2, status: 'open' },
      ],
    }),
  }) as Response);

  render(<PublicationWorkflowPage />);

  await waitFor(() => expect(tileValue('Open Requirements')).toBe('2'));
  expect(screen.getByText('Open Research Requirements (2)')).toBeTruthy();
  expect(screen.getByText('Resolved Research Requirements (0)')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
