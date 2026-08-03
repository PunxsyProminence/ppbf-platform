import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { upsertGearProduct } from '@/src/server/pilot/gearCatalog';
import { getVendorForOrganization } from '@/src/server/pilot/gearVendors';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * The vendor half of the gear route. #190's own boundary (the wholesale cost)
 * is covered by gearCatalog.pg.test.ts and the public store's route test; what
 * is new here is the brand, which is public, and the vendor id, which points
 * at a confidential record and must never point outside the caller's gym.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/gearCatalog', () => {
  const actual = jest.requireActual('@/src/server/pilot/gearCatalog');
  return { ...actual, upsertGearProduct: jest.fn(), listGearForOrganization: jest.fn() };
});

jest.mock('@/src/server/pilot/gearVendors', () => ({ getVendorForOrganization: jest.fn() }));

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockUpsert = upsertGearProduct as jest.Mock;
const mockGetVendor = getVendorForOrganization as jest.Mock;
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

const GLOVES = {
  product_id: 'gloves-12oz',
  name: 'Training gloves 12oz',
  brand: 'Everlast',
  description: 'Club stock',
  category: 'gloves',
  vendor_id: 'everlast',
  wholesale_cost_cents: 2000,
  retail_price_cents: 4000,
  listed_publicly: true,
  availability: 'in_stock',
  checkout_url: 'https://checkout.example.test/gloves',
};

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/admin/gear', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockUpsert.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
  mockGetVendor.mockResolvedValue({ vendor_id: 'everlast', vendor_name: 'Everlast' });
});

describe('brand and supplier on a product', () => {
  it('saves both, and looks the supplier up within the gym', async () => {
    const response = await post(GLOVES);

    expect(response.status).toBe(200);
    expect(mockGetVendor).toHaveBeenCalledWith('org-1', 'everlast');
    expect(mockUpsert).toHaveBeenCalledWith('org-1', expect.objectContaining({
      brand: 'Everlast',
      vendor_id: 'everlast',
    }));
  });

  it('accepts a product with no supplier recorded', async () => {
    // A normal state -- most of the catalogue predates the vendor table, and a
    // gym may know what it has before it records where it came from.
    await post({ ...GLOVES, vendor_id: '' });

    expect(mockGetVendor).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledWith('org-1', expect.objectContaining({ vendor_id: null }));
  });

  it('accepts a product with no brand', async () => {
    await post({ ...GLOVES, brand: '' });

    expect(mockUpsert).toHaveBeenCalledWith('org-1', expect.objectContaining({ brand: '' }));
  });

  it('refuses a brand long enough to be a description', async () => {
    const response = await post({ ...GLOVES, brand: 'E'.repeat(200) });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/^Unsupported brand/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe('a product cannot name another gym supplier account', () => {
  it('refuses a vendor that is not this gym own, with a reason rather than a 500', async () => {
    // The composite foreign key is the real boundary. This is the named
    // refusal in front of it: a raw foreign-key violation reaches jsonError()
    // with no recognized prefix and comes back as "Internal server error",
    // which tells the admin nothing.
    mockGetVendor.mockResolvedValue(null);

    const response = await post(GLOVES);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/^Unsupported vendor/);
    expect(payload.error).not.toMatch(/internal server error/i);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('looks the supplier up against the session gym, never a gym named in the body', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-2' }));

    await post({ ...GLOVES, organization_id: 'org-1' });

    expect(mockGetVendor).toHaveBeenCalledWith('org-2', 'everlast');
    expect(mockUpsert.mock.calls[0]?.[0]).toBe('org-2');
  });
});

describe('who is refused', () => {
  it.each(['platform_owner', 'coach'] as const)('refuses %s', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));

    const response = await post(GLOVES);

    expect(response.status).toBe(403);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockGetVendor).not.toHaveBeenCalled();
  });
});

describe('the audit trail', () => {
  it('records the supplier id and nothing behind it', async () => {
    await post(GLOVES);

    const event = mockAudit.mock.calls[0][0];

    // The id is the point of the record. The account number, tier and terms
    // live in gear_vendors and are never written into an audit detail -- see
    // gear-vendors/route.ts.
    expect(event.details).toMatchObject({ action: 'gear_product_saved', vendor_id: 'everlast' });
    expect(JSON.stringify(event)).not.toMatch(/account_number|discount_tier|net_terms/);
  });
});
