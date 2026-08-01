// The unlocks endpoint had no client for months (audit E1), so nothing
// exercised it end to end. The admin panel now calls it, which makes two
// things worth pinning: who may change a capability's activation mode, and
// that the change leaves an audit trail with a before/after.

import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  evaluateShadowUnlockState,
  listShadowThresholds,
  updateShadowThreshold,
} from '@/src/server/pilot/shadowUnlocks';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/shadowUnlocks', () => ({
  evaluateShadowUnlockState: jest.fn(),
  listShadowThresholds: jest.fn(),
  updateShadowThreshold: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockList = jest.mocked(listShadowThresholds);
const mockUpdate = jest.mocked(updateShadowThreshold);
const mockEvaluate = jest.mocked(evaluateShadowUnlockState);

const EXISTING_ROW = {
  organizationId: 'org-1',
  featureKey: 'aggressive_research_generation',
  metricKey: 'org_resolved_scout_reports',
  minValue: 12,
  activationMode: 'observation',
  description: 'Enable stronger research-intake generation.',
};

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/shadow/unlocks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  featureKey: 'aggressive_research_generation',
  metricKey: 'org_resolved_scout_reports',
  minValue: 12,
  activationMode: 'enabled',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal.mockResolvedValue({
    accountId: 'admin-1', organizationId: 'org-1', role: 'organization_admin',
  } as never);
  mockList.mockResolvedValue([EXISTING_ROW] as never);
  mockUpdate.mockResolvedValue(undefined as never);
  mockEvaluate.mockResolvedValue({ organizationId: 'org-1', features: {} } as never);
  mockAudit.mockResolvedValue(undefined as never);
});

describe('POST unlocks thresholds', () => {
  test('flipping activation mode is audited with a before and after', async () => {
    // Activation mode decides whether a capability can EVER unlock. Before
    // this, the only trace of a change was updated_by_account_id on the row.
    const response = await POST(post(VALID_BODY));

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      featureKey: 'aggressive_research_generation',
      activationMode: 'enabled',
      actorAccountId: 'admin-1',
    }));

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'update',
      actor_account_id: 'admin-1',
      organization_id: 'org-1',
      entity_type: 'shadow_feature_threshold',
      entity_id: 'aggressive_research_generation',
      details: expect.objectContaining({
        from: expect.objectContaining({ activationMode: 'observation', minValue: 12 }),
        to: expect.objectContaining({ activationMode: 'enabled', minValue: 12 }),
      }),
    }));
  });

  test('the before-state is read prior to the write, not after', async () => {
    // Reading it afterwards would record the new value as the old one, which
    // is worse than no audit at all -- it reads as a change that never
    // happened.
    const order: string[] = [];
    mockList.mockImplementation(async () => { order.push('list'); return [EXISTING_ROW] as never; });
    mockUpdate.mockImplementation(async () => { order.push('update'); });

    await POST(post(VALID_BODY));

    expect(order[0]).toBe('list');
    expect(order.indexOf('list')).toBeLessThan(order.indexOf('update'));
  });

  test('a first-time threshold with no prior row records from: null', async () => {
    mockList.mockResolvedValueOnce([] as never);

    await POST(post(VALID_BODY));

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ from: null }),
    }));
  });

  test('a coach cannot change activation mode', async () => {
    // The GET is readable by coaches; granting a capability is not.
    mockPrincipal.mockResolvedValue({
      accountId: 'coach-1', organizationId: 'org-1', role: 'coach',
    } as never);

    const response = await POST(post(VALID_BODY));

    expect(response.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an athlete cannot change activation mode', async () => {
    mockPrincipal.mockResolvedValue({
      accountId: 'ath-1', organizationId: 'org-1', role: 'athlete',
    } as never);

    const response = await POST(post(VALID_BODY));

    expect(response.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('an incomplete body is rejected before any write or audit', async () => {
    const response = await POST(post({ featureKey: 'aggressive_research_generation' }));

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('minValue of 0 is a real value, not a missing one', async () => {
    // `!body.minValue` would treat 0 as absent; the guard uses == null.
    await POST(post({ ...VALID_BODY, minValue: 0 }));

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ minValue: 0 }));
  });
});

describe('GET unlocks thresholds', () => {
  test('returns thresholds and evaluated state together', async () => {
    const request = new NextRequest('http://localhost/api/pilot/shadow/unlocks');
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      thresholds: [expect.objectContaining({ featureKey: 'aggressive_research_generation' })],
    });
  });

  test('a coach may read the state', async () => {
    mockPrincipal.mockResolvedValue({
      accountId: 'coach-1', organizationId: 'org-1', role: 'coach',
    } as never);

    const response = await GET(new NextRequest('http://localhost/api/pilot/shadow/unlocks'));

    expect(response.status).toBe(200);
  });
});
