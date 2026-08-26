import { gearValidationError, GEAR_TEXT_LIMITS, type GearProductInput } from './gearCatalog';

// The public store (/api/public/store) is the one route on this platform that
// answers an anonymous caller, and it serves product_id, name, brand,
// description and category straight through. `brand` was bounded, and
// gearCatalog.ts states why in as many words -- "it is free text that reaches a
// public page". The other four reach the same page through the same projection
// and were not bounded at all, in code or in the schema: pilot.gear_products
// declares them plain `text`.
//
// So a single admin save could put an unbounded blob on a page every shopper
// loads, and every load afterwards would carry it. These pin the reasoning to
// all five fields rather than to whichever one was written first.

function input(overrides: Partial<GearProductInput> = {}): GearProductInput {
  return {
    product_id: 'P-1',
    name: 'Everlast Powerlock 2 Pro',
    brand: 'Everlast',
    description: 'Training gloves.',
    category: 'gloves',
    vendor_id: null,
    wholesale_cost_cents: 3000,
    retail_price_cents: 6000,
    listed_publicly: true,
    availability: 'in_stock',
    checkout_url: '',
    ...overrides,
  };
}

const BOUNDED_FIELDS: Array<keyof typeof GEAR_TEXT_LIMITS> = [
  'product_id',
  'name',
  'brand',
  'description',
  'category',
  'checkout_url',
];

describe('every free-text field that reaches the public store is bounded', () => {
  // A table-driven guard over an empty list passes without ever running.
  test('the bounded-field table is not empty and covers every declared limit', () => {
    expect(BOUNDED_FIELDS.length).toBeGreaterThan(0);
    expect([...BOUNDED_FIELDS].sort()).toEqual(Object.keys(GEAR_TEXT_LIMITS).sort());
  });

  test.each(BOUNDED_FIELDS)('%s is refused one character over its limit', (field) => {
    const limit = GEAR_TEXT_LIMITS[field];
    expect(limit).toBeGreaterThan(0);

    // checkout_url must also survive the https check, so overflow it with a
    // real URL rather than with filler that would fail for the wrong reason.
    const overflow = field === 'checkout_url'
      ? `https://example.org/${'a'.repeat(limit)}`
      : 'a'.repeat(limit + 1);

    const error = gearValidationError(input({ [field]: overflow } as Partial<GearProductInput>));

    expect(error).not.toBe('');
    expect(error).toContain(field);
  });

  test.each(BOUNDED_FIELDS)('%s is accepted exactly at its limit', (field) => {
    const limit = GEAR_TEXT_LIMITS[field];
    const atLimit = field === 'checkout_url'
      ? `https://e.org/${'a'.repeat(limit - 'https://e.org/'.length)}`
      : 'a'.repeat(limit);

    expect(gearValidationError(input({ [field]: atLimit } as Partial<GearProductInput>))).toBe('');
  });

  test('an ordinary product still saves', () => {
    expect(gearValidationError(input())).toBe('');
  });

  // The pre-existing refusals must be unchanged by the length checks.
  test('a missing product id is still refused', () => {
    expect(gearValidationError(input({ product_id: '  ' }))).toBe('Missing product id');
  });

  test('a missing name is still refused', () => {
    expect(gearValidationError(input({ name: '' }))).toBe('Missing product name');
  });

  test('a non-https checkout link is still refused', () => {
    expect(gearValidationError(input({ checkout_url: 'http://example.org/buy' }))).toContain('https');
  });

  test('a javascript: checkout link is still refused', () => {
    expect(gearValidationError(input({ checkout_url: 'javascript:alert(1)' }))).not.toBe('');
  });

  test('a negative price is still refused', () => {
    expect(gearValidationError(input({ retail_price_cents: -1 }))).toContain('price');
  });
});
