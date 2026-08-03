import { readFileSync } from 'node:fs';
import path from 'node:path';

import { credentialFieldError, gearVendorValidationError, type GearVendorInput } from './gearVendors';

function vendor(over: Partial<GearVendorInput> = {}): GearVendorInput {
  return {
    vendor_id: 'everlast',
    vendor_name: 'Everlast',
    account_number: 'EVL-99887766',
    discount_tier: 'Tier 2',
    net_terms_days: 30,
    portal_url: 'https://orders.everlast.example/signin',
    rep_name: 'Dana Reyes',
    rep_email: 'dana.reyes@everlast.example',
    rep_phone: '814-555-0142',
    notes: '',
    active: true,
    ...over,
  };
}

describe('a valid supplier account', () => {
  it('accepts a fully filled record', () => {
    expect(gearVendorValidationError(vendor())).toBe('');
  });

  it('accepts a supplier the gym has only a name for', () => {
    // The normal first state. A Treasurer types the name they know and fills
    // the account details in when the paperwork arrives; refusing that would
    // mean the record cannot be started at all.
    expect(gearVendorValidationError(vendor({
      account_number: '',
      discount_tier: '',
      net_terms_days: null,
      portal_url: '',
      rep_name: '',
      rep_email: '',
      rep_phone: '',
    }))).toBe('');
  });

  it('accepts zero-day terms and no-terms-recorded as different things', () => {
    expect(gearVendorValidationError(vendor({ net_terms_days: 0 }))).toBe('');
    expect(gearVendorValidationError(vendor({ net_terms_days: null }))).toBe('');
  });
});

describe('what it refuses', () => {
  it('refuses a record with no id or no name', () => {
    expect(gearVendorValidationError(vendor({ vendor_id: '  ' }))).toBe('Missing vendor id');
    expect(gearVendorValidationError(vendor({ vendor_name: '' }))).toBe('Missing vendor name');
  });

  it('refuses terms that are not a whole number of days', () => {
    expect(gearVendorValidationError(vendor({ net_terms_days: -1 }))).toMatch(/^Unsupported net terms/);
    expect(gearVendorValidationError(vendor({ net_terms_days: 30.5 }))).toMatch(/^Unsupported net terms/);
    expect(gearVendorValidationError(vendor({ net_terms_days: NaN }))).toMatch(/^Unsupported net terms/);
    expect(gearVendorValidationError(vendor({ net_terms_days: 3650 }))).toMatch(/^Unsupported net terms/);
  });

  it('refuses a portal link that is not https', () => {
    expect(gearVendorValidationError(vendor({ portal_url: 'http://orders.example' })))
      .toMatch(/^Unsupported portal link/);
    expect(gearVendorValidationError(vendor({ portal_url: '/orders' })))
      .toMatch(/^Unsupported portal link/);
    expect(gearVendorValidationError(vendor({ portal_url: 'javascript:alert(1)' })))
      .toMatch(/^Unsupported portal link/);
  });

  // The credential refusal reaching the one field that legitimately holds a
  // URL. A "portal link" with the password in the query string is the login,
  // pasted out of a browser address bar.
  it('refuses a portal link carrying a credential in its query string', () => {
    for (const url of [
      'https://orders.example/in?password=hunter2',
      'https://orders.example/in?token=abc123',
      'https://orders.example/in?api_key=abc123',
      'https://orders.example/in?auth=abc123',
    ]) {
      expect(gearVendorValidationError(vendor({ portal_url: url })))
        .toMatch(/^Unsupported portal link/);
    }
  });

  it('accepts an ordinary portal link with a harmless query string', () => {
    expect(gearVendorValidationError(vendor({ portal_url: 'https://orders.example/in?account=EVL' })))
      .toBe('');
  });

  it('refuses a rep email that is not an address', () => {
    expect(gearVendorValidationError(vendor({ rep_email: 'dana at everlast' })))
      .toBe('Unsupported rep email address');
  });
});

/**
 * jsonError() maps a message to a status by its prefix. A validation message
 * that starts with anything else falls through to the generic branch, which
 * replaces it with "Internal server error" and answers 500 -- telling an admin
 * the server broke when what actually happened is that they mistyped a number.
 * That has already cost time in this repo twice.
 */
describe('every refusal is prefixed so it surfaces as a 400', () => {
  const RECOGNIZED = /^(Missing|Unsupported|Forbidden|Unauthorized|Not found|Request body|PIN)/;

  const refusals: GearVendorInput[] = [
    vendor({ vendor_id: '' }),
    vendor({ vendor_name: '' }),
    vendor({ net_terms_days: -1 }),
    vendor({ net_terms_days: 3650 }),
    vendor({ net_terms_days: NaN }),
    vendor({ portal_url: 'http://orders.example' }),
    vendor({ portal_url: 'not a url' }),
    vendor({ portal_url: 'https://orders.example/in?password=hunter2' }),
    vendor({ rep_email: 'nope' }),
  ];

  it.each(refusals.map((input, index) => [index, input] as const))(
    'refusal %i carries a status-mapping prefix',
    (_index, input) => {
      const message = gearVendorValidationError(input);
      expect(message).not.toBe('');
      expect(message).toMatch(RECOGNIZED);
    },
  );
});

/**
 * A supplier login in this app would be a credential nobody rotates, readable
 * by anyone with an organization admin session, in a database built to hold
 * youth records. It is refused loudly rather than dropped quietly: an admin
 * told "Saved" would reasonably believe the platform is holding it and stop
 * keeping it anywhere else.
 */
describe('no supplier password, ever', () => {
  it.each([
    'password',
    'portal_password',
    'passwd',
    'passphrase',
    'login',
    'vendor_secret',
    'api_key',
    'apiKey',
    'access_token',
    'accessToken',
    'portal_credential',
    'pin',
  ])('refuses a body offering %s', (key) => {
    const message = credentialFieldError({ vendor_id: 'everlast', [key]: 'hunter2' });

    expect(message).toMatch(/^Unsupported field/);
    expect(message).toContain(key);
    // And it says what to do instead, rather than only refusing.
    expect(message).toMatch(/account number/);
  });

  it('says nothing about an ordinary body', () => {
    expect(credentialFieldError({
      vendor_id: 'everlast',
      vendor_name: 'Everlast',
      account_number: 'EVL-99887766',
      discount_tier: 'Tier 2',
      net_terms_days: 30,
      portal_url: 'https://orders.everlast.example/signin',
      rep_name: 'Dana Reyes',
      rep_email: 'dana.reyes@everlast.example',
      rep_phone: '814-555-0142',
      notes: 'Free freight over $500.',
      active: true,
    })).toBe('');
  });

  // Negative control. The two assertions above pass equally against a
  // credentialFieldError that always returns a message and one that never
  // does; this pins which.
  it('is not simply refusing or accepting everything', () => {
    expect(credentialFieldError({ notes: 'x' })).toBe('');
    expect(credentialFieldError({ password: 'x' })).not.toBe('');
  });
});

/**
 * The structural half of the boundary, asserted against the source rather than
 * against behavior, because the failure it guards is an edit that looks
 * harmless in review: someone adds a field to a shared list, or points the
 * public read at the internal one.
 */
describe('the field lists', () => {
  const catalogSource = readFileSync(path.join(__dirname, 'gearCatalog.ts'), 'utf8');
  const vendorSource = readFileSync(path.join(__dirname, 'gearVendors.ts'), 'utf8');

  function constantBody(source: string, name: string): string {
    const match = new RegExp(`const ${name} =[\\s\\S]*?;`).exec(source);
    if (!match) throw new Error(`${name} not found -- was it renamed?`);
    return match[0];
  }

  it('gives the public the brand and nothing else new', () => {
    const publicFields = constantBody(catalogSource, 'PUBLIC_FIELDS');

    expect(publicFields).toContain('brand');
    // The two facts that must never be in this list. vendor_id is an id rather
    // than an account, but publishing it would still say which supplier a gym
    // buys from, and it is the handle on everything that follows.
    expect(publicFields).not.toMatch(/vendor/i);
    expect(publicFields).not.toMatch(/wholesale/i);
  });

  it('keeps the public and internal lists separate rather than derived', () => {
    // The discipline #190 established: two explicit lists, not one list minus
    // a field. A derived list is one careless edit from leaking, and the edit
    // that does it looks harmless.
    expect(constantBody(catalogSource, 'PUBLIC_FIELDS')).not.toMatch(/INTERNAL_FIELDS/);
    expect(constantBody(catalogSource, 'INTERNAL_FIELDS')).not.toMatch(/PUBLIC_FIELDS/);
    expect(constantBody(catalogSource, 'INTERNAL_FIELDS')).toContain('vendor_id');
  });

  it('has no public vendor field list to leak through', () => {
    // Deliberate asymmetry. gearCatalog.ts has two audiences and two lists;
    // this module has one audience and one list. A PUBLIC_ constant appearing
    // here would mean someone had started exposing supplier records.
    expect(vendorSource).not.toMatch(/const\s+PUBLIC_/);
    expect(vendorSource).toMatch(/const VENDOR_FIELDS =/);
  });

  it('never reads a vendor record from the public store route', () => {
    const routeSource = readFileSync(
      path.resolve(__dirname, '../../../app/api/public/store/route.ts'),
      'utf8',
    );

    // Comments stripped first. The route's header explains at length why it
    // does NOT touch the vendor table, and an assertion that cannot tell the
    // explanation from the thing it warns against fails on its own
    // documentation -- which is what happened when the note about
    // pilot.gear_vendors was added.
    const code = routeSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).not.toMatch(/gear_vendors/);
    expect(code).not.toMatch(/gearVendors/);
    expect(code).not.toMatch(/account_number/);
    // The brand is the one thing about a supplier that IS public, so the
    // assertions above must not be passing simply because the strip ate
    // everything.
    expect(code).toMatch(/brand: product\.brand/);
  });
});
