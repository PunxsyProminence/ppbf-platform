import { NextRequest } from 'next/server';

import { GET } from './route';
import { query } from '@/src/server/pilot/db';

jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn() }));

const mockQuery = query as jest.Mock;

function get(search = '') {
  return GET(new NextRequest(`http://localhost/api/public/store${search}`));
}

beforeEach(() => {
  jest.resetAllMocks();
  mockQuery.mockResolvedValue([]);
});

/**
 * The gym buys equipment at roughly half retail on a wholesale account. That
 * cost is its negotiated position with a supplier -- not the public's to see,
 * and quite possibly something the supplier agreement forbids disclosing.
 *
 * These tests hold the boundary at the only place it can actually be held: the
 * cost is never SELECTED, so there is nothing in the response object to hide.
 */
describe('the wholesale cost never reaches a public response', () => {
  it('does not select the cost column at all', async () => {
    await get('?organization_id=org-1');

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).not.toMatch(/wholesale_cost_cents/);
    // And it is not a `select *` that would acquire the column the moment
    // anyone adds one.
    expect(sql).not.toMatch(/select\s+\*/i);
    expect(sql).toMatch(/retail_price_cents/);
  });

  // The defence that matters is the query, not the serializer -- but if a cost
  // ever did arrive in a row, it must not be handed onward. This proves the
  // response carries only the fields the store needs, rather than whatever the
  // database returned.
  it('does not pass an unexpected column through to the caller', async () => {
    mockQuery.mockResolvedValue([
      {
        product_id: 'p-1',
        name: 'Gloves',
        description: '',
        category: 'general',
        retail_price_cents: 4000,
        availability: 'in_stock',
        checkout_url: 'https://example.test/buy',
      },
    ]);

    const body = await (await get('?organization_id=org-1')).json();
    const serialized = JSON.stringify(body);

    expect(serialized).not.toMatch(/wholesale/i);
    expect(serialized).not.toMatch(/cost/i);
    expect(body.products[0].retail_price_cents).toBe(4000);
  });

  it('scopes every read to the named gym', async () => {
    await get('?organization_id=org-1');
    expect(mockQuery.mock.calls[0][1]).toEqual(['org-1']);
  });
});

/**
 * "Everlast" is two facts with opposite audiences. As a brand on a glove it is
 * public and the store should say so -- the word is stamped on the product
 * either way. As the gym's Everlast ACCOUNT (account number, discount tier,
 * net terms, rep) it is confidential, exactly like the wholesale cost.
 *
 * These tests hold both halves. A test that only asserted absence would pass
 * just as well against a store that had lost the brand entirely.
 */
describe('the brand is public and the supplier account is not', () => {
  it('selects the brand', async () => {
    await get('?organization_id=org-1');

    expect(String(mockQuery.mock.calls[0][0])).toMatch(/brand/);
  });

  it('selects nothing about the supplier account', async () => {
    await get('?organization_id=org-1');
    const sql = String(mockQuery.mock.calls[0][0]);

    // Not the id, not the table, not a join to it. The id alone would say
    // which supplier a gym buys from and is the handle on everything else.
    expect(sql).not.toMatch(/vendor/i);
    expect(sql).not.toMatch(/gear_vendors/i);
    expect(sql).not.toMatch(/account_number/i);
    expect(sql).not.toMatch(/\bjoin\b/i);
  });

  it('hands the shopper the brand and nothing that came from a vendor row', async () => {
    mockQuery.mockResolvedValue([
      {
        product_id: 'gloves-12oz',
        name: 'Training gloves 12oz',
        brand: 'Everlast',
        description: '',
        category: 'gloves',
        retail_price_cents: 4000,
        availability: 'in_stock',
        checkout_url: 'https://example.test/buy',
      },
    ]);

    const body = await (await get('?organization_id=org-1')).json();
    const serialized = JSON.stringify(body);

    expect(body.products[0].brand).toBe('Everlast');
    expect(serialized).not.toMatch(/vendor/i);
    expect(serialized).not.toMatch(/account/i);
    expect(serialized).not.toMatch(/discount/i);
  });
});

describe('multi-store', () => {
  // There is no default organization and no "the" store. Without a gym named,
  // this is the index of gyms that have one.
  it('lists the gyms with a store when none is named', async () => {
    mockQuery.mockResolvedValue([
      { organization_id: 'org-1', organization_name: 'Punxsy Prominence', listed_product_count: 3 },
    ]);

    const body = await (await get()).json();

    expect(body.stores).toHaveLength(1);
    expect(body.stores[0].organization_name).toBe('Punxsy Prominence');
    expect(body.products).toBeUndefined();
  });

  // A gym that does not exist and a gym with nothing listed answer the same
  // way. Distinguishing them would turn this into a probe for which
  // organization ids are real, answered to somebody who has not said who they
  // are.
  it('answers an unknown gym exactly as it answers an empty one', async () => {
    mockQuery.mockResolvedValue([]);
    const unknown = await (await get('?organization_id=does-not-exist')).json();

    mockQuery.mockResolvedValue([]);
    const empty = await (await get('?organization_id=org-1')).json();

    expect(unknown).toEqual({ ok: true, organization_id: 'does-not-exist', products: [] });
    expect(empty).toEqual({ ok: true, organization_id: 'org-1', products: [] });
  });
});

// This is the one surface on the platform that answers without asking who is
// calling. #111 removed a route that let an anonymous request execute DDL, and
// the auth rate limiter was still creating a table from the unauthenticated
// login path as of last night. An anonymous endpoint here gets one verb.
describe('the anonymous surface stays small', () => {
  it('exports no write handler', async () => {
    const route = await import('./route');

    expect(typeof route.GET).toBe('function');
    expect((route as Record<string, unknown>).POST).toBeUndefined();
    expect((route as Record<string, unknown>).PATCH).toBeUndefined();
    expect((route as Record<string, unknown>).PUT).toBeUndefined();
    expect((route as Record<string, unknown>).DELETE).toBeUndefined();
  });

  it('reads no athlete data', async () => {
    await get('?organization_id=org-1');
    const sql = String(mockQuery.mock.calls[0][0]);

    expect(sql).not.toMatch(/athlete/i);
    expect(sql).not.toMatch(/guardian/i);
    expect(sql).not.toMatch(/pilot\.accounts/i);
  });
});
