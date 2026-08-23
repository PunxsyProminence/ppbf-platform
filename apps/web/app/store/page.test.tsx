/**
 * @jest-environment jsdom
 */

// A loaded-and-empty shop and a shop that failed to load are different facts.
// The strings matched below are the visitor-facing ones and they are matched
// loosely on purpose: what is pinned is that the three list states stay three
// distinguishable messages, not the exact wording of any of them.

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import StoreIndexPage from './page';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

test('loading is visible and is not an empty shop or a failed load', () => {
  global.fetch = jest.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

  render(<StoreIndexPage />);

  expect(screen.getByText(/loading the shop/i)).toBeTruthy();
  expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
  expect(screen.queryByText(/nothing is on sale/i)).toBeNull();
  expect(screen.queryByText(/could not be loaded/i)).toBeNull();
});

test('an empty shop says so, and does not say the shop failed to load', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ stores: [] })) as unknown as typeof fetch;

  await act(async () => {
    render(<StoreIndexPage />);
  });

  expect(screen.getByText(/nothing is on sale/i)).toBeTruthy();
  expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  expect(screen.queryByText(/loading the shop/i)).toBeNull();
});

test('a failed load never looks like an empty shop', async () => {
  global.fetch = jest.fn(async () => jsonResponse({}, false)) as unknown as typeof fetch;

  await act(async () => {
    render(<StoreIndexPage />);
  });

  expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  expect(screen.queryByText(/nothing is on sale/i)).toBeNull();
  expect(screen.queryByText(/loading the shop/i)).toBeNull();
});

test('a listed gym is a link, fetched without credentials', async () => {
  const fetchMock = jest.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        stores: [{ organization_id: 'org-1', organization_name: 'Punxsy Prominence', listed_product_count: 3 }],
      }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;

  await act(async () => {
    render(<StoreIndexPage />);
  });

  expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'GET', credentials: 'omit' }));
  expect(screen.getByRole('link', { name: /Punxsy Prominence/i })).toHaveAttribute('href', '/store/org-1');
  expect(screen.queryByText(/nothing is on sale/i)).toBeNull();
  expect(screen.queryByText(/could not be loaded/i)).toBeNull();
});
