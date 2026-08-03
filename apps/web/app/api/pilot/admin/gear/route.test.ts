import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { upsertGearProduct } from '@/src/server/pilot/gearCatalog';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/gearCatalog', () => {
  const actual = jest.requireActual('@/src/server/pilot/gearCatalog');
  return { ...actual, upsertGearProduct: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockUpsert = upsertGearProduct as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const VALID_BODY = {
  product_id: 'gloves-12oz',
  name: 'Training gloves',
  description: '',
  category: 'gloves',
  wholesale_cost_cents: 2000,
  retail_price_cents: 4000,
  listed_publicly: true,
  availability: 'in_stock',
  checkout_url: 'https://checkout.example.test/gloves',
};

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'admin-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function post(overrides: Record<string, unknown> = {}) {
  return POST(
    new NextRequest('http://localhost/api/pilot/admin/gear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, ...overrides }),
    }),
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockUpsert.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
});

test.each([
  ['wholesale_cost_cents', 12.5],
  ['retail_price_cents', 99.5],
])('rejects fractional cents in %s', async (field, value) => {
  const response = await post({ [field]: value });
  const body = await response.json();

  expect(response.status).toBe(400);
  expect(body.error).toMatch(/whole number of cents/i);
  expect(mockUpsert).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

test('writes whole cents only to the organization from the session', async () => {
  const response = await post();
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toEqual({ ok: true, product_id: 'gloves-12oz' });
  expect(mockUpsert).toHaveBeenCalledWith(
    'org-1',
    expect.objectContaining({
      wholesale_cost_cents: 2000,
      retail_price_cents: 4000,
    }),
  );
  expect(mockAudit).toHaveBeenCalledTimes(1);
});

test('refuses the platform owner and does not write', async () => {
  mockRequirePrincipal.mockResolvedValue(
    principal({
      accountId: 'platform-owner',
      role: 'platform_owner',
      organizationId: 'platform',
    }),
  );

  const response = await post();

  expect(response.status).toBe(403);
  expect(mockUpsert).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});
