/**
 * @jest-environment jsdom
 */

/* FAM-21 (app scrub, lane U1). A product with no checkout link said "Ask at
   the gym" on a 44px bordered plate beside real Buy buttons: text drawn as a
   control that does nothing when tapped. It is a plain line of text now. */

import { Suspense, act } from 'react';
import { render, screen } from '@testing-library/react';

import GymStorePage from './page';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: React.ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const product = (overrides: Record<string, unknown>) => ({
  product_id: 'p1',
  name: 'Hand wraps',
  brand: '',
  description: '',
  category: 'Wraps',
  retail_price_cents: 1200,
  availability: 'in_stock',
  checkout_url: '',
  ...overrides,
});

async function renderStore(products: unknown[]) {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ products }) })) as unknown as typeof fetch;
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <GymStorePage params={Promise.resolve({ organizationId: 'gym-1' })} />
      </Suspense>,
    );
  });
}

test('a product with no checkout reads as a line of text, not a button-shaped plate', async () => {
  await renderStore([product({})]);

  const line = await screen.findByText('Not sold online. Ask at the gym.');
  expect(line.tagName).toBe('P');
  expect(line.className).not.toMatch(/min-h-|border|inline-flex|uppercase/);
  expect(screen.queryByText('Ask at the gym')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

test('a product with a checkout still offers Buy', async () => {
  await renderStore([product({ product_id: 'p2', checkout_url: 'https://checkout.example/x' })]);

  expect((await screen.findByRole('link', { name: 'Buy' })).getAttribute('href')).toBe('https://checkout.example/x');
  expect(screen.queryByText('Not sold online. Ask at the gym.')).toBeNull();
});

test('an item with a checkout that is unavailable just now does not say it is not sold online', async () => {
  await renderStore([product({ product_id: 'p3', availability: 'unavailable', checkout_url: 'https://checkout.example/y' })]);

  expect(await screen.findByText('Ask at the gym.')).toBeTruthy();
  expect(screen.getByText('Not available just now')).toBeTruthy();
  expect(screen.queryByText(/Not sold online/)).toBeNull();
  expect(screen.queryByRole('link', { name: 'Buy' })).toBeNull();
});
