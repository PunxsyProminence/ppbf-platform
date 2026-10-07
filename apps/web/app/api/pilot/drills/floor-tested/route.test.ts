import { NextRequest } from 'next/server';

import { POST } from './route';
import { FLOOR_VALIDATOR_ROLES, markDrillFloorTested } from '@/src/server/pilot/drillFloorValidations';
import fs from 'node:fs';
import path from 'node:path';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// The route's contract: who may mark, that the organization is the session's,
// that another gym's drill reads as absent, and that the mark is audited. The
// write itself is proven against real PostgreSQL in
// drillFloorValidations.pg.test.ts.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drillFloorValidations', () => {
  const actual = jest.requireActual('@/src/server/pilot/drillFloorValidations');
  return { ...actual, markDrillFloorTested: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockMark = markDrillFloorTested as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const REFERENCE_ID = 'drl_reference_1';

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function mark(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    validation_id: 'dfv_1',
    drill_id: REFERENCE_ID,
    validated_by_account_id: 'coach-1',
    validated_by_role: 'coach',
    validated_at: '2026-10-07T00:00:00.000Z',
    note: '',
    ...overrides,
  };
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/drills/floor-tested', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockMark.mockResolvedValue(mark());
});

describe('who may mark a reference drill floor-tested (OD-2026-10-06-026 ruling 3)', () => {
  test('rejects an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const res = await POST(request({ reference_drill_id: REFERENCE_ID }));

    expect(res.status).toBe(401);
    expect(mockMark).not.toHaveBeenCalled();
  });

  // The two roles the owner named, and nobody else: not an athlete or parent,
  // and not the platform owner, who is not of the gym. (A legacy 'admin' row
  // is the gym's admin under roleAlias.ts and is admitted below.)
  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner'])(
    'refuses %s',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: role as PilotPrincipal['role'] }));

      const res = await POST(request({ reference_drill_id: REFERENCE_ID }));

      expect(res.status).toBe(403);
      expect(mockMark).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  test.each(['coach', 'organization_admin'])('%s marks a drill for the session organization, and it is audited', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: role as PilotPrincipal['role'], accountId: 'acct-9' }));
    mockMark.mockResolvedValueOnce(mark({ validated_by_account_id: 'acct-9', validated_by_role: role }));

    const res = await POST(request({ organization_id: 'org-2', reference_drill_id: ` ${REFERENCE_ID} `, note: ' Tried Tuesday ' }));

    expect(res.status).toBe(201);
    expect(mockMark).toHaveBeenCalledWith({
      organizationId: 'org-1',
      drillId: REFERENCE_ID,
      validatedByAccountId: 'acct-9',
      validatedByRole: role,
      note: 'Tried Tuesday',
    });
    expect(await res.json()).toEqual({
      ok: true,
      organization_id: 'org-1',
      floor_tested: mark({ validated_by_account_id: 'acct-9', validated_by_role: role }),
    });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'update',
      actor_account_id: 'acct-9',
      organization_id: 'org-1',
      entity_type: 'reference_drill',
      entity_id: REFERENCE_ID,
      details: { action: 'floor_tested', validation_id: 'dfv_1' },
    }));
  });
  test("a legacy 'admin' account is the gym's admin, and its mark is stored as organization_admin", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'admin' as PilotPrincipal['role'] }));

    const res = await POST(request({ reference_drill_id: REFERENCE_ID }));

    expect(res.status).toBe(201);
    expect(mockMark).toHaveBeenCalledWith(expect.objectContaining({ validatedByRole: 'organization_admin' }));
  });

});

describe('the role list is declared once in meaning', () => {
  test("the route's own literal equals the module's FLOOR_VALIDATOR_ROLES, which the table CHECK mirrors", () => {
    const source = fs.readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
    const declared = source.match(/const FLOOR_VALIDATOR_ROLES = \[([^\]]*)\] as const;/)?.[1] ?? '';
    const literals = Array.from(declared.matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
    expect(literals).toEqual([...FLOOR_VALIDATOR_ROLES]);
  });
});

describe('what it refuses', () => {
  test("another gym's reference drill reads as a plain not-found, and nothing is audited", async () => {
    mockMark.mockResolvedValueOnce(null);

    const res = await POST(request({ reference_drill_id: 'drl_elsewhere' }));

    expect(res.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('refuses a missing reference_drill_id before any write', async () => {
    const res = await POST(request({ note: 'x' }));

    expect(res.status).toBe(400);
    expect(mockMark).not.toHaveBeenCalled();
  });

  test('refuses a note that is not text', async () => {
    const res = await POST(request({ reference_drill_id: REFERENCE_ID, note: 42 }));

    expect(res.status).toBe(400);
    expect(mockMark).not.toHaveBeenCalled();
  });
});
