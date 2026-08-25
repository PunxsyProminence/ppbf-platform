import { query } from './db';

/**
 * The gym's equipment catalogue: one product, two prices, two audiences.
 *
 * The gym buys on a wholesale account at roughly half retail and sells some of
 * it on to fund the program. So every product carries a number the public may
 * see (retail) and a number it may not (what the gym paid). The cost is the
 * gym's negotiated position with a supplier; publishing it would expose terms
 * that are not the public's to see and that a supplier agreement may forbid
 * disclosing at all.
 *
 * HOW THAT BOUNDARY IS HELD. Two explicit column lists, not one list minus a
 * field. A shared list with the cost removed at the call site is one careless
 * edit away from leaking, and the edit that does it looks harmless in review.
 * This is the same discipline the roster export uses and for the same stated
 * reason: a query that later selects an extra field must not be able to widen
 * what leaves the platform by accident.
 *
 * EVERY READ IS SCOPED TO ONE ORGANIZATION. Each gym has its own catalogue,
 * its own suppliers and its own prices, and no query here is reachable without
 * naming which gym is being asked about. The public store is addressed per
 * organization for the same reason -- there is no global store, because there
 * is no global gym.
 *
 * MONEY IS INTEGER CENTS. Never float: 0.1 + 0.2 is not 0.3 in binary floating
 * point, and a catalogue that drifts a cent per operation produces a margin
 * report that will not reconcile against a bank statement.
 */

/**
 * What anyone may see. No cost, no supplier account, and no way to derive
 * either.
 *
 * `brand` is here on purpose and is the only field this list has ever gained.
 * The brand printed on a glove is public by construction -- a parent buying
 * gloves wants to know they are Everlast, and the word is stamped on the
 * product either way. What is confidential is the gym's Everlast ACCOUNT, and
 * that is a different column (vendor_id) pointing at a different table
 * (pilot.gear_vendors) which no query in this file touches.
 */
const PUBLIC_FIELDS =
  'product_id, name, brand, description, category, retail_price_cents, availability, checkout_url';

/**
 * What the gym's own people may see. Cost, margin and the supplier account
 * reference live only here.
 *
 * vendor_id is an id, not the account: even an organization admin reads the
 * account number, discount tier and terms through gearVendors.ts, which is a
 * separate module with a separate route.
 */
const INTERNAL_FIELDS =
  'product_id, name, brand, description, category, vendor_id, wholesale_cost_cents, retail_price_cents, '
  + 'listed_publicly, availability, checkout_url, created_at, updated_at';

export interface PublicGearProduct {
  product_id: string;
  name: string;
  brand: string;
  description: string;
  category: string;
  retail_price_cents: number;
  availability: 'in_stock' | 'order_only' | 'unavailable';
  checkout_url: string;
}

export interface InternalGearProduct extends PublicGearProduct {
  vendor_id: string | null;
  wholesale_cost_cents: number;
  listed_publicly: boolean;
  created_at: string;
  updated_at: string;
}

export interface GearStoreSummary {
  organization_id: string;
  organization_name: string;
  listed_product_count: number;
}

/**
 * The public store for one gym.
 *
 * Selects PUBLIC_FIELDS only, so the cost is not fetched and then hidden -- it
 * never leaves Postgres. A price concealed by a component is a price in the
 * page source.
 *
 * 'unavailable' products are still returned: a gym saying "we stock this, not
 * right now" is more useful to a parent than the item vanishing, and it is
 * honest in a way an empty shelf is not.
 */
export async function listPublicGear(organizationId: string): Promise<PublicGearProduct[]> {
  return query<PublicGearProduct>(
    `select ${PUBLIC_FIELDS}
       from pilot.gear_products
      where organization_id = $1
        and listed_publicly
      order by name asc`,
    [organizationId],
  );
}

/**
 * Every gym with something on public sale.
 *
 * The index that makes this multi-store rather than one store with a gym's
 * name on it. A gym with no listed products does not appear at all, rather than
 * appearing as an empty shop -- which reads as a broken page.
 */
export async function listPublicStores(): Promise<GearStoreSummary[]> {
  return query<GearStoreSummary>(
    `select o.organization_id,
            o.organization_name,
            count(g.product_id)::int as listed_product_count
       from pilot.organizations o
       join pilot.gear_products g
         on g.organization_id = o.organization_id
        and g.listed_publicly
      group by o.organization_id, o.organization_name
     having count(g.product_id) > 0
      order by o.organization_name asc`,
  );
}

/** The gym's own view: cost, margin, and what is on sale. */
export async function listGearForOrganization(organizationId: string): Promise<InternalGearProduct[]> {
  return query<InternalGearProduct>(
    `select ${INTERNAL_FIELDS}
       from pilot.gear_products
      where organization_id = $1
      order by name asc`,
    [organizationId],
  );
}

export interface GearProductInput {
  product_id: string;
  name: string;
  brand: string;
  description: string;
  category: string;
  /** Null when the gym has not recorded which supplier account it was bought on. */
  vendor_id: string | null;
  wholesale_cost_cents: number;
  retail_price_cents: number;
  listed_publicly: boolean;
  availability: string;
  checkout_url: string;
}

const AVAILABILITY = new Set(['in_stock', 'order_only', 'unavailable']);

/**
 * Every free-text field that reaches a public page, and how long it may be.
 *
 * `brand` was bounded here first, and its reason -- "it is free text that
 * reaches a public page" -- is the whole argument. It applies unchanged to the
 * other four: /api/public/store selects product_id, name, brand, description
 * and category out of PUBLIC_FIELDS above and serves them to an anonymous
 * caller, and pilot.gear_products declares all of them plain `text` with no
 * length constraint. So one admin save could put an unbounded blob on the one
 * page this platform answers without asking who is calling, and every load
 * afterwards would carry it.
 *
 * Sizes are what the field is for, not a guess at an attacker: long enough for
 * "Everlast Powerlock 2 Pro" and a paragraph about it, short enough that none
 * of them is a place to paste a document. checkout_url is bounded at the
 * conventional browser-safe URL length -- a link nothing can follow is not a
 * link.
 */
export const GEAR_TEXT_LIMITS = {
  product_id: 120,
  name: 200,
  brand: 120,
  description: 4000,
  category: 80,
  checkout_url: 2000,
} as const;

/**
 * Why a product cannot be saved, or empty if it can.
 *
 * Selling below cost is allowed and deliberately so -- a gym subsidising gloves
 * for families who cannot afford them is a choice the platform has no business
 * refusing. The Treasurer view shows the negative margin plainly instead, which
 * is the honest treatment: make it visible, not impossible.
 */
export function gearValidationError(input: GearProductInput): string {
  if (!input.product_id.trim()) {
    return 'Missing product id';
  }
  if (!input.name.trim()) {
    return 'Missing product name';
  }
  // Length is checked for every field that reaches the public store, not only
  // for brand. Trimmed, because the stored value is trimmed -- checking the
  // untrimmed length would refuse a legitimate value padded with whitespace
  // while accepting nothing longer.
  for (const [field, limit] of Object.entries(GEAR_TEXT_LIMITS) as Array<[keyof typeof GEAR_TEXT_LIMITS, number]>) {
    if (input[field].trim().length > limit) {
      return `Unsupported ${field}: it must be ${limit} characters or fewer`;
    }
  }
  if (!Number.isInteger(input.wholesale_cost_cents) || input.wholesale_cost_cents < 0) {
    return 'Unsupported cost: it must be a whole number of cents, and not negative';
  }
  if (!Number.isInteger(input.retail_price_cents) || input.retail_price_cents < 0) {
    return 'Unsupported price: it must be a whole number of cents, and not negative';
  }
  if (!AVAILABILITY.has(input.availability)) {
    return 'Unsupported availability';
  }
  // A checkout link is optional -- a store can list before a processor account
  // exists -- but if present it must be a real https URL. An http link would
  // send a buyer's card details over the wire in the clear, and a relative or
  // javascript: value on a public page is an injection rather than a link.
  if (input.checkout_url.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(input.checkout_url.trim());
    } catch {
      return 'Unsupported checkout link: it must be a full https:// address';
    }
    if (parsed.protocol !== 'https:') {
      return 'Unsupported checkout link: it must be https';
    }
  }
  return '';
}

export async function upsertGearProduct(
  organizationId: string,
  input: GearProductInput,
): Promise<void> {
  await query(
    `insert into pilot.gear_products
       (organization_id, product_id, name, brand, description, category, vendor_id,
        wholesale_cost_cents, retail_price_cents, listed_publicly, availability,
        checkout_url, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     on conflict (organization_id, product_id) do update
       set name = excluded.name,
           brand = excluded.brand,
           description = excluded.description,
           category = excluded.category,
           vendor_id = excluded.vendor_id,
           wholesale_cost_cents = excluded.wholesale_cost_cents,
           retail_price_cents = excluded.retail_price_cents,
           listed_publicly = excluded.listed_publicly,
           availability = excluded.availability,
           checkout_url = excluded.checkout_url,
           updated_at = now()`,
    [
      organizationId,
      input.product_id.trim(),
      input.name.trim(),
      input.brand.trim(),
      input.description.trim(),
      input.category.trim() || 'general',
      // Null, never '': the foreign key is MATCH SIMPLE, so a null means "no
      // supplier recorded" and is not checked, while '' would be checked and
      // fail against a vendor that cannot exist.
      input.vendor_id?.trim() || null,
      input.wholesale_cost_cents,
      input.retail_price_cents,
      input.listed_publicly,
      input.availability,
      input.checkout_url.trim(),
    ],
  );
}

/**
 * Margin in cents, and as a percentage of the retail price.
 *
 * Percentage of RETAIL rather than of cost, because that is the number a
 * Treasurer reconciles against takings: of every dollar a buyer hands over,
 * this is what stayed with the gym. Margin over cost would be a bigger,
 * flattering number describing a different question.
 *
 * A product priced at zero has no margin percentage rather than an infinite
 * one; the caller renders that as blank.
 */
export function gearMargin(product: { wholesale_cost_cents: number; retail_price_cents: number }): {
  margin_cents: number;
  margin_percent: number | null;
} {
  const marginCents = product.retail_price_cents - product.wholesale_cost_cents;
  return {
    margin_cents: marginCents,
    margin_percent:
      product.retail_price_cents > 0
        ? Math.round((marginCents / product.retail_price_cents) * 1000) / 10
        : null,
  };
}
