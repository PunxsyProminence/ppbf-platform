import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  countProductsByVendor,
  listVendorsForOrganization,
  upsertGearVendor,
} from '@/src/server/pilot/gearVendors';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/gearVendors', () => {
  // The validators stay real: their message prefixes are what decide whether a
  // refusal reaches the admin as a 400 or as a masked 500, and mocking them
  // would test nothing.
  const actual = jest.requireActual('@/src/server/pilot/gearVendors');
  return {
    ...actual,
    listVendorsForOrganization: jest.fn(),
    countProductsByVendor: jest.fn(),
    upsertGearVendor: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listVendorsForOrganization as jest.Mock;
const mockCounts = countProductsByVendor as jest.Mock;
const mockUpsert = upsertGearVendor as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

function principal(over: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'admin-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...over,
  } as PilotPrincipal;
}

const VENDOR = {
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
};

function get() {
  return GET(new NextRequest('http://localhost/api/pilot/admin/gear-vendors'));
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/admin/gear-vendors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockList.mockResolvedValue([{ ...VENDOR, created_at: 'then', updated_at: 'now' }]);
  mockCounts.mockResolvedValue([{ vendor_id: 'everlast', product_count: 3 }]);
  mockUpsert.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
});

describe('the gym administrator', () => {
  it('reads its own suppliers, with how much has been bought from each', async () => {
    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.organization_id).toBe('org-1');
    expect(body.vendors[0].account_number).toBe('EVL-99887766');
    expect(body.vendors[0].product_count).toBe(3);
  });

  it('saves a supplier account', async () => {
    const response = await post(VENDOR);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, vendor_id: 'everlast' });
    expect(mockUpsert).toHaveBeenCalledWith('org-1', expect.objectContaining({
      vendor_id: 'everlast',
      account_number: 'EVL-99887766',
      net_terms_days: 30,
    }));
  });

  it('treats a missing terms field as not recorded rather than as zero days', async () => {
    // Different facts. Storing 0 for "we have not asked" would tell a
    // Treasurer the invoice is due on receipt.
    await post({ ...VENDOR, net_terms_days: undefined });

    expect(mockUpsert).toHaveBeenCalledWith('org-1', expect.objectContaining({ net_terms_days: null }));
  });
});

/**
 * The same boundary as the wholesale cost next door, for the same reason. An
 * account number and a negotiated discount tier are the gym's commercial
 * position -- not the platform owner's to read across gyms, and not a coach's
 * either.
 */
describe('who is refused', () => {
  it.each(['platform_owner', 'coach', 'board', 'parent', 'athlete'] as const)(
    'refuses %s on the read',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));

      const response = await get();

      expect(response.status).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
    },
  );

  it.each(['platform_owner', 'coach', 'board', 'parent', 'athlete'] as const)(
    'refuses %s on the write',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));

      const response = await post(VENDOR);

      expect(response.status).toBe(403);
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  it('answers 401 to a caller with no session', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    expect((await get()).status).toBe(401);
    expect((await post(VENDOR)).status).toBe(401);
  });
});

describe('one gym cannot reach another gym suppliers', () => {
  it('takes the organization from the session and never from the body', async () => {
    await post({ ...VENDOR, organization_id: 'org-2' });

    expect(mockUpsert).toHaveBeenCalledWith('org-1', expect.anything());
    // Not merely "not org-2": the whole call is asserted against the session's
    // gym, so a future refactor that starts honoring a body field fails here.
    expect(mockUpsert.mock.calls[0][0]).toBe('org-1');
  });

  it('reads only the gym in the session', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-2' }));

    await get();

    expect(mockList).toHaveBeenCalledWith('org-2');
    expect(mockCounts).toHaveBeenCalledWith('org-2');
  });
});

/**
 * jsonError() maps a message to a status by its prefix. An unprefixed
 * validation message comes back as a masked 500 that tells the admin the
 * server broke, which is both wrong and unactionable.
 */
describe('a bad field is a 400 that says what is wrong', () => {
  it.each([
    [{ ...VENDOR, vendor_id: '' }, /vendor id/i],
    [{ ...VENDOR, vendor_name: '' }, /vendor name/i],
    [{ ...VENDOR, net_terms_days: -5 }, /net terms/i],
    [{ ...VENDOR, net_terms_days: 'thirty' }, /net terms/i],
    [{ ...VENDOR, portal_url: 'http://orders.example' }, /portal link/i],
    [{ ...VENDOR, rep_email: 'not-an-address' }, /email/i],
  ])('refuses %#, with the reason', async (body, expected) => {
    const response = await post(body as Record<string, unknown>);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(expected);
    expect(payload.error).not.toMatch(/internal server error/i);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

/**
 * A supplier login stored here would be a credential nobody rotates, readable
 * by anyone with an organization admin session, in a database built to hold
 * youth records.
 */
describe('no supplier password reaches the database', () => {
  it.each(['password', 'portal_password', 'api_key', 'access_token', 'login'])(
    'refuses a body carrying %s instead of dropping it',
    async (key) => {
      const response = await post({ ...VENDOR, [key]: 'hunter2' });
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error).toContain(key);
      expect(mockUpsert).not.toHaveBeenCalled();
      // And nothing is recorded as saved, so the audit trail does not imply a
      // credential was accepted.
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  it('never echoes the offered secret back to the caller', async () => {
    const response = await post({ ...VENDOR, portal_password: 'hunter2' });
    const payload = await response.json();

    expect(JSON.stringify(payload)).not.toContain('hunter2');
  });
});

describe('the audit trail', () => {
  it('records that the record changed without recording what is in it', async () => {
    await post(VENDOR);

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const event = mockAudit.mock.calls[0][0];

    expect(event).toMatchObject({
      event_type: 'update',
      organization_id: 'org-1',
      entity_type: 'gear_vendor',
      entity_id: 'everlast',
    });

    // Audit events are read on screens with wider audiences than this route
    // has. The account number, the tier, the terms and the rep's details are
    // the whole reason this table is confidential; presence flags carry the
    // useful signal without carrying the values.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('EVL-99887766');
    expect(serialized).not.toContain('Tier 2');
    expect(serialized).not.toContain('Dana Reyes');
    expect(serialized).not.toContain('dana.reyes@everlast.example');
    expect(serialized).not.toContain('814-555-0142');
    expect(event.details).toMatchObject({
      action: 'gear_vendor_saved',
      has_account_number: true,
      has_portal_link: true,
      has_rep_contact: true,
    });
  });
});

describe('the anonymous surface does not grow', () => {
  it('exports no verb beyond the two the Treasurer needs', async () => {
    const route = await import('./route');

    expect(typeof route.GET).toBe('function');
    expect(typeof route.POST).toBe('function');
    expect((route as Record<string, unknown>).DELETE).toBeUndefined();
    expect((route as Record<string, unknown>).PUT).toBeUndefined();
  });
});
