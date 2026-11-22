/**
 * @jest-environment jsdom
 */

/* FAM-21 (app scrub, lane U1). A product with no checkout link said "Ask at
   the gym" on a 44px bordered plate beside real Buy buttons: text drawn as a
   control that does nothing when tapped. It is a plain line of text now. */

import { Suspense, act } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

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

/* FAM-22 (app scrub; lane AS-9, AS9-7): the page is not blank while the read
   is out, and its heading names the gym from the public list of shops (AS-9
   Q12 = A, no server change). */
describe('the gym is named, and the page is not blank while loading', () => {
  function installFetch(list: { ok: boolean; stores?: unknown[] }, products: unknown[] = []) {
    const calls: Array<{ url: string; credentials: unknown }> = [];
    global.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, credentials: init?.credentials });
      if (url.includes('organization_id=')) return { ok: true, json: async () => ({ products }) };
      return { ok: list.ok, json: async () => ({ stores: list.stores ?? [] }) };
    }) as unknown as typeof fetch;
    return calls;
  }

  async function renderGym() {
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <GymStorePage params={Promise.resolve({ organizationId: 'gym-1' })} />
        </Suspense>,
      );
    });
  }

  test('the heading names the gym from the list of shops', async () => {
    const calls = installFetch({ ok: true, stores: [
      { organization_id: 'gym-2', organization_name: 'Other Gym', listed_product_count: 1 },
      { organization_id: 'gym-1', organization_name: 'Test Gym', listed_product_count: 1 },
    ] });
    await renderGym();

    expect((await screen.findByRole('heading', { level: 1 })).textContent?.trim()).toBe('Test Gym Equipment');
    // The list read is the public one: no gym id in it, and no cookie sent.
    const listReads = calls.filter((call) => !call.url.includes('organization_id='));
    expect(listReads.map((call) => call.url)).toEqual(['/api/public/store']);
    expect(calls.every((call) => call.credentials === 'omit')).toBe(true);
  });

  test('a list read that failed names no gym, even if its body lists this one', async () => {
    installFetch({ ok: false, stores: [{ organization_id: 'gym-1', organization_name: 'Test Gym' }] });
    await renderGym();
    expect(screen.getByRole('heading', { level: 1 }).textContent?.trim()).toBe('Equipment');
  });

  test('a list without this gym names no gym, and never another gym', async () => {
    installFetch({ ok: true, stores: [{ organization_id: 'gym-2', organization_name: 'Other Gym' }] });
    await renderGym();
    expect(screen.getByRole('heading', { level: 1 }).textContent?.trim()).toBe('Equipment');
    cleanup();
  });

  test('a loading line shows until the products answer, and then goes', async () => {
    let answer: (value: unknown) => void = () => {};
    global.fetch = jest.fn((input: unknown) => {
      if (String(input).includes('organization_id=')) {
        return new Promise((resolve) => { answer = resolve; });
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    }) as unknown as typeof fetch;
    await renderGym();

    expect(screen.getByRole('status').textContent).toBe("Loading this gym's shop...");
    expect(screen.queryByText('Nothing is on sale from this gym just now.')).toBeNull();

    await act(async () => {
      answer({ ok: true, json: async () => ({ products: [] }) });
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Nothing is on sale from this gym just now.')).toBeTruthy();
  });
});
