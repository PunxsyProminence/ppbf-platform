import { query, queryOne } from './db';

/**
 * The gym's supplier accounts: who it buys from, on what account, on what
 * terms, and who to call.
 *
 * WHY THIS IS A SEPARATE TABLE FROM THE BRAND ON A PRODUCT. "Everlast" is two
 * different facts with opposite audiences:
 *
 *   - As a brand on a product it is PUBLIC, and should be. A parent buying
 *     gloves wants to know they are Everlast, and the word is stamped on the
 *     glove either way. That lives in gear_products.brand, and it is the one
 *     field PUBLIC_FIELDS in gearCatalog.ts has ever gained.
 *
 *   - As the gym's Everlast ACCOUNT -- account number, discount tier, net
 *     terms, rep contact -- it is CONFIDENTIAL, exactly like the wholesale
 *     cost. It is the gym's negotiated commercial position, and a supplier
 *     agreement may forbid disclosing it at all. That lives here.
 *
 * Conflating them costs one thing or the other. Publish the account and the
 * gym's terms leak; suppress the brand and the store gets worse for no gain.
 *
 * THERE IS NO PUBLIC FIELD LIST IN THIS FILE, AND THERE MUST NEVER BE ONE.
 * gearCatalog.ts holds two explicit lists because it serves two audiences.
 * This module serves one, so it holds one list and every read in it is behind
 * an organization-admin route. If a public surface ever needs something about
 * a supplier -- "we stock Everlast" -- that is the brand on the product, which
 * it already has.
 *
 * NEVER A PASSWORD. There is no column for a supplier portal login and no
 * function here accepts one; credentialFieldError() refuses a request that
 * offers one rather than silently dropping it. A supplier login stored in this
 * application would be a credential nobody rotates, readable by anyone holding
 * an organization admin session, in a database built to hold youth records.
 * What a Treasurer needs on a screen to place an order is WHICH account, WHERE
 * the portal is and WHO to call -- they sign in with their own credentials,
 * held wherever the gym already holds them.
 *
 * EVERY READ IS SCOPED TO ONE ORGANIZATION. Two gyms both buying from Everlast
 * hold two rows with two account numbers and two discount tiers, because they
 * are two separate commercial relationships.
 */

/**
 * Every column of a vendor record. One list, because there is one audience.
 *
 * Explicit rather than `select *` for the same reason gearCatalog.ts is: a
 * query that later acquires a column must not be able to widen what leaves the
 * platform by accident.
 */
const VENDOR_FIELDS =
  'vendor_id, vendor_name, account_number, discount_tier, net_terms_days, '
  + 'portal_url, rep_name, rep_email, rep_phone, notes, active, created_at, updated_at';

export interface GearVendor {
  vendor_id: string;
  vendor_name: string;
  account_number: string;
  discount_tier: string;
  net_terms_days: number | null;
  portal_url: string;
  rep_name: string;
  rep_email: string;
  rep_phone: string;
  notes: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface GearVendorInput {
  vendor_id: string;
  vendor_name: string;
  account_number: string;
  discount_tier: string;
  net_terms_days: number | null;
  portal_url: string;
  rep_name: string;
  rep_email: string;
  rep_phone: string;
  notes: string;
  active: boolean;
}

/**
 * This gym's suppliers. Current ones first, then the ones it has stopped
 * buying from -- which stay on the record because the products bought from
 * them still reference the account the purchase was made on.
 */
export async function listVendorsForOrganization(organizationId: string): Promise<GearVendor[]> {
  return query<GearVendor>(
    `select ${VENDOR_FIELDS}
       from pilot.gear_vendors
      where organization_id = $1
      order by active desc, vendor_name asc`,
    [organizationId],
  );
}

/**
 * One supplier account, or null.
 *
 * Both arguments, always. A vendor belonging to another gym returns null here
 * rather than a row, which is the same answer as a vendor that does not exist
 * -- so this cannot be used to probe another gym's supplier list.
 */
export async function getVendorForOrganization(
  organizationId: string,
  vendorId: string,
): Promise<GearVendor | null> {
  return queryOne<GearVendor>(
    `select ${VENDOR_FIELDS}
       from pilot.gear_vendors
      where organization_id = $1
        and vendor_id = $2`,
    [organizationId, vendorId],
  );
}

/** How many products this gym has recorded against each of its suppliers. */
export interface VendorProductCount {
  vendor_id: string;
  product_count: number;
}

export async function countProductsByVendor(organizationId: string): Promise<VendorProductCount[]> {
  return query<VendorProductCount>(
    `select vendor_id, count(*)::int as product_count
       from pilot.gear_products
      where organization_id = $1
        and vendor_id is not null
      group by vendor_id`,
    [organizationId],
  );
}

const MAX_NET_TERMS_DAYS = 365;

/**
 * Keys this platform refuses to accept on a vendor record, whatever a caller
 * calls them.
 *
 * A rejection rather than a silent drop, deliberately. An admin who types a
 * portal password into a form and gets a cheerful "Saved" reasonably believes
 * the platform is holding it -- and will stop keeping it anywhere else. Being
 * told plainly that this application does not store supplier logins is the
 * only outcome that leaves them correctly informed.
 */
const CREDENTIAL_KEY_PATTERN = /^pass(word|wd|phrase)?$|password|passphrase|secret|credential|api_?key|access_?token|^login$|^pin$/i;

/**
 * The same refusal, arriving through the one field that legitimately holds a
 * URL. Separate from the key pattern because a query string is matched on
 * `name=` rather than on a whole key, and because a portal link may carry a
 * signed token that the key pattern has no reason to know about.
 */
const CREDENTIAL_IN_URL_PATTERN = /(password|passwd|secret|token|api[-_]?key|auth|signature|sig)=/i;

/**
 * Why a request cannot be accepted because it offers a credential, or empty.
 *
 * Scans the raw body keys rather than the parsed input, because the parsed
 * input has no field for a password -- which is exactly why a password sent in
 * one would otherwise vanish without comment.
 *
 * The message is prefixed "Unsupported" on purpose: jsonError() maps a message
 * to a status by its prefix, and an unprefixed validation message surfaces as
 * a masked 500 telling the admin the server broke rather than what was wrong.
 */
export function credentialFieldError(body: Record<string, unknown>): string {
  const offending = Object.keys(body).filter((key) => CREDENTIAL_KEY_PATTERN.test(key));
  if (offending.length === 0) {
    return '';
  }
  return `Unsupported field "${offending[0]}": this platform never stores a supplier login. `
    + 'Record the account number, the portal address and the rep instead, and keep the '
    + 'password wherever the gym already keeps its passwords.';
}

/**
 * Why a vendor cannot be saved, or empty if it can.
 *
 * Every message begins Missing or Unsupported so jsonError() answers 400. An
 * unprefixed message falls through to the generic branch, which replaces it
 * with "Internal server error" and tells the admin the server broke when what
 * actually happened is that they left a field blank.
 */
export function gearVendorValidationError(input: GearVendorInput): string {
  if (!input.vendor_id.trim()) {
    return 'Missing vendor id';
  }
  if (!input.vendor_name.trim()) {
    return 'Missing vendor name';
  }
  if (input.net_terms_days !== null) {
    if (!Number.isInteger(input.net_terms_days) || input.net_terms_days < 0) {
      return 'Unsupported net terms: it must be a whole number of days, and not negative';
    }
    if (input.net_terms_days > MAX_NET_TERMS_DAYS) {
      return `Unsupported net terms: ${MAX_NET_TERMS_DAYS} days is the longest this accepts`;
    }
  }
  // The portal link is optional -- a supplier may take orders by phone -- but
  // if present it must be a real https address, for the same reasons the
  // checkout link is: an http link sends whatever follows over the wire in the
  // clear, and a javascript: value rendered as a link is an injection.
  if (input.portal_url.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(input.portal_url.trim());
    } catch {
      return 'Unsupported portal link: it must be a full https:// address';
    }
    if (parsed.protocol !== 'https:') {
      return 'Unsupported portal link: it must be https';
    }
    // A portal URL carrying a token or a password in its query string is the
    // credential this table refuses, arriving through the one field that
    // legitimately holds a URL.
    if (CREDENTIAL_IN_URL_PATTERN.test(parsed.search)) {
      return 'Unsupported portal link: it carries a credential in its query string. '
        + 'Save the plain address of the sign-in page instead.';
    }
  }
  if (input.rep_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.rep_email.trim())) {
    return 'Unsupported rep email address';
  }
  return '';
}

export async function upsertGearVendor(
  organizationId: string,
  input: GearVendorInput,
): Promise<void> {
  await query(
    `insert into pilot.gear_vendors
       (organization_id, vendor_id, vendor_name, account_number, discount_tier,
        net_terms_days, portal_url, rep_name, rep_email, rep_phone, notes, active,
        updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     on conflict (organization_id, vendor_id) do update
       set vendor_name = excluded.vendor_name,
           account_number = excluded.account_number,
           discount_tier = excluded.discount_tier,
           net_terms_days = excluded.net_terms_days,
           portal_url = excluded.portal_url,
           rep_name = excluded.rep_name,
           rep_email = excluded.rep_email,
           rep_phone = excluded.rep_phone,
           notes = excluded.notes,
           active = excluded.active,
           updated_at = now()`,
    [
      organizationId,
      input.vendor_id.trim(),
      input.vendor_name.trim(),
      input.account_number.trim(),
      input.discount_tier.trim(),
      input.net_terms_days,
      input.portal_url.trim(),
      input.rep_name.trim(),
      input.rep_email.trim(),
      input.rep_phone.trim(),
      input.notes.trim(),
      input.active,
    ],
  );
}
