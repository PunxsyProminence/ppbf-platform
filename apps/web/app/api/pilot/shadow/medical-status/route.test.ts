import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowAuthority } from '@/src/server/pilot/shadowAuthority';
import {
  getLatestMedicalAdministrativeStatus,
  setMedicalAdministrativeStatus,
} from '@/src/server/pilot/shadowMedicalStatus';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// This route is the ONLY writer of pilot.shadow_medical_administrative_status,
// the table contactClearanceGate.ts and assertMedicalStatusAllowsRecommendation
// read to decide whether a child may take contact -- and it had no test file at
// all, and no assertShadowAuthority call, while three lesser SHADOW routes had
// both. These tests pin the authority check at the write and the expiry the
// gates now read.
//
// What they deliberately do NOT change: who may call this route. The role gate
// still admits any coach with access to the athlete. That is an escalated
// authorization question for the owner; the coach case below is pinned as
// CURRENT behaviour so narrowing it later is a visible, deliberate test change
// rather than a silent one.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowAuthority', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowAuthority');
  return { ...actual, assertShadowAuthority: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowMedicalStatus', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowMedicalStatus');
  return {
    ...actual,
    getLatestMedicalAdministrativeStatus: jest.fn(),
    setMedicalAdministrativeStatus: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockAuthority = assertShadowAuthority as jest.Mock;
const mockSetStatus = setMedicalAdministrativeStatus as jest.Mock;
const mockGetStatus = getLatestMedicalAdministrativeStatus as jest.Mock;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function statusRow(overrides: Record<string, unknown> = {}) {
  return {
    status_id: 'status-1',
    organization_id: 'org-1',
    athlete_id: 'ath-1',
    status: 'cleared',
    restriction_flags: {},
    source_reference: 'physician-note-123',
    set_by_account_id: 'acct-coach-1',
    set_by_role: 'coach',
    effective_at: '2026-08-18T10:00:00.000Z',
    expires_at: null,
    created_at: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/shadow/medical-status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const getRequest = (athleteId: string) =>
  new NextRequest(
    `http://localhost/api/pilot/shadow/medical-status?athleteId=${encodeURIComponent(athleteId)}`,
    { method: 'GET' },
  );

/** A year out, so the fixture never rots into a past date and starts failing. */
function futureIso(): string {
  return new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  jest.clearAllMocks();
  // Implementations, not just call records: clearAllMocks leaves a
  // mockRejectedValue from an earlier test in place, which would make every
  // later test in this file assert the refusal path by accident.
  mockAccess.mockResolvedValue(undefined);
  mockGetStatus.mockResolvedValue(null);
  mockSetStatus.mockResolvedValue(statusRow());
  mockAuthority.mockResolvedValue(undefined);
});

describe('the write calls assertShadowAuthority', () => {
  test('the authority check runs, and describes the action it is actually authorizing', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await POST(postRequest({ athleteId: 'ath-1', status: 'cleared' }));

    expect(response.status).toBe(200);
    expect(mockAuthority).toHaveBeenCalledTimes(1);
    expect(mockAuthority).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({ accountId: 'acct-coach-1', role: 'coach' }),
      organizationId: 'org-1',
      // The status is IN the action name on purpose: shadowAuthority.ts's
      // forbidden-automatic-action list matches on 'clear', so an automatic
      // actor proposing a clearance is refused by name.
      action: 'shadow.medical_administrative_status.set.cleared',
      automationMode: 'manual',
      // Both false, and both load-bearing: they are what refuse an automatic
      // actor whatever status it proposes. Passing true here is what left the
      // sibling call sites unable to deny anything.
      lowRisk: false,
      reversible: false,
      withinApprovedOptions: true,
      restrictionConflict: false,
    }));
  });

  test('the authority check runs BEFORE the write, not alongside it', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    const order: string[] = [];
    mockAuthority.mockImplementation(async () => { order.push('authority'); });
    mockSetStatus.mockImplementation(async () => { order.push('write'); return statusRow(); });

    await POST(postRequest({ athleteId: 'ath-1', status: 'cleared' }));

    expect(order).toEqual(['authority', 'write']);
  });

  test('a denied authority check blocks the write entirely', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAuthority.mockRejectedValue(
      new Error('SHADOW authority denied: Automatic clearance and medical authority actions are prohibited.'),
    );

    const response = await POST(postRequest({ athleteId: 'ath-1', status: 'cleared' }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  test('the metadata carries no free text -- only whether a source reference was given', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    await POST(postRequest({
      athleteId: 'ath-1',
      status: 'cleared',
      sourceReference: 'Dr Ruiz cleared, no concussion symptoms since 8/2',
    }));

    const [{ metadata }] = mockAuthority.mock.calls[0];
    expect(metadata).toMatchObject({ athlete_id: 'ath-1', status: 'cleared', source_reference_present: true });
    expect(JSON.stringify(metadata)).not.toContain('Ruiz');
  });

  test('a self-contradictory write -- cleared WITH restriction flags -- is reported as a restriction conflict', async () => {
    // No reader anywhere consults restriction_flags; every gate compares
    // `status` only. So "cleared with limits" reads as "fully cleared" to the
    // gates, and the decider is told about the contradiction rather than the
    // route hardcoding restrictionConflict: false the way its siblings do.
    mockRequirePrincipal.mockResolvedValue(principal());

    await POST(postRequest({
      athleteId: 'ath-1',
      status: 'cleared',
      restrictionFlags: { no_sparring: true },
    }));

    expect(mockAuthority).toHaveBeenCalledWith(expect.objectContaining({ restrictionConflict: true }));
  });

  test('restriction flags on a RESTRICTED record are not a conflict -- they agree with it', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    await POST(postRequest({
      athleteId: 'ath-1',
      status: 'restricted',
      restrictionFlags: { no_sparring: true },
    }));

    expect(mockAuthority).toHaveBeenCalledWith(expect.objectContaining({
      action: 'shadow.medical_administrative_status.set.restricted',
      restrictionConflict: false,
    }));
  });
});

describe('the automation mode is validated, not taken on trust', () => {
  test('an explicit automatic mode reaches the decider as automatic', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    await POST(postRequest({ athleteId: 'ath-1', status: 'cleared', automationMode: 'automatic' }));

    expect(mockAuthority).toHaveBeenCalledWith(expect.objectContaining({ automationMode: 'automatic' }));
  });

  // The evasion the audit found at the sibling call sites: automation_mode is
  // taken verbatim there, so "Automatic" slips past the one branch that can
  // deny. Here an unrecognised mode is refused outright, before any write.
  test.each(['Automatic', 'AUTOMATIC', 'auto', '', 'automatic '])(
    'the unrecognised mode %p is a 400, not a silently-downgraded pass',
    async (mode) => {
      mockRequirePrincipal.mockResolvedValue(principal());

      const response = await POST(postRequest({ athleteId: 'ath-1', status: 'cleared', automationMode: mode }));

      expect(response.status).toBe(400);
      expect(mockAuthority).not.toHaveBeenCalled();
      expect(mockSetStatus).not.toHaveBeenCalled();
    },
  );

  test('an omitted mode defaults to manual -- a human on a PHI session recorded this', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    await POST(postRequest({ athleteId: 'ath-1', status: 'cleared' }));

    expect(mockAuthority).toHaveBeenCalledWith(expect.objectContaining({ automationMode: 'manual' }));
  });
});

describe('the expiry the write may state', () => {
  test('a future expiry is passed through to the record', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    const expiresAt = futureIso();

    const response = await POST(postRequest({ athleteId: 'ath-1', status: 'cleared', expiresAt }));

    expect(response.status).toBe(200);
    expect(mockSetStatus).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }));
  });

  test('an omitted expiry writes null -- no interval is invented here', async () => {
    // The clinical validity window for a clearance is an open research
    // question in this repository (docs/HANDOFF_RESEARCH.md item 1). This test
    // exists to fail if someone later quietly fills in a default.
    mockRequirePrincipal.mockResolvedValue(principal());

    await POST(postRequest({ athleteId: 'ath-1', status: 'cleared' }));

    expect(mockSetStatus).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: null }));
  });

  test.each(['2020-01-01T00:00:00.000Z', 'next tuesday', '', 12345])(
    'the invalid expiry %p is a 400 with nothing written',
    async (expiresAt) => {
      mockRequirePrincipal.mockResolvedValue(principal());

      const response = await POST(postRequest({ athleteId: 'ath-1', status: 'cleared', expiresAt }));

      expect(response.status).toBe(400);
      expect(mockSetStatus).not.toHaveBeenCalled();
    },
  );
});

describe('legitimate writes still succeed, and the role gate is unchanged', () => {
  test('a coach records a clearance and gets the stored record back', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockSetStatus.mockResolvedValue(statusRow({ source_reference: 'physician-note-123' }));

    const response = await POST(postRequest({
      athleteId: 'ath-1',
      status: 'cleared',
      sourceReference: 'physician-note-123',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, effectiveStatus: 'cleared' });
    expect(payload.status).toMatchObject({ status: 'cleared', athlete_id: 'ath-1' });
    expect(mockSetStatus).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      athleteId: 'ath-1',
      status: 'cleared',
      sourceReference: 'physician-note-123',
      setByAccountId: 'acct-coach-1',
      setByRole: 'coach',
    }));
  });

  test.each(['organization_admin', 'admin'])('%s may still write', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

    const response = await POST(postRequest({ athleteId: 'ath-1', status: 'restricted' }));

    expect(response.status).toBe(200);
    expect(mockSetStatus).toHaveBeenCalledTimes(1);
  });

  test.each(['parent', 'athlete', 'volunteer', 'staff', 'platform_owner'])(
    '%s is refused before the authority check or the write',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

      const response = await POST(postRequest({ athleteId: 'ath-1', status: 'cleared' }));

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mockAuthority).not.toHaveBeenCalled();
      expect(mockSetStatus).not.toHaveBeenCalled();
    },
  );

  test('an athlete the actor cannot access is refused before the authority check', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAccess.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));

    const response = await POST(postRequest({ athleteId: 'ath-other-org', status: 'cleared' }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockAuthority).not.toHaveBeenCalled();
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  test.each([
    { athleteId: 'ath-1' },
    { athleteId: 'ath-1', status: 'maybe' },
    { status: 'cleared' },
    { athleteId: 'ath-1', status: 'cleared', restrictionFlags: ['no_sparring'] },
  ])('the invalid payload %p is a 400 with nothing written', async (body) => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await POST(postRequest(body));

    expect(response.status).toBe(400);
    expect(mockSetStatus).not.toHaveBeenCalled();
  });
});

describe('the read reports the effective status alongside the stored row', () => {
  test('a lapsed clearance still returns the stored row, and reports as expired', async () => {
    // The record of who cleared this athlete and when must not vanish -- but a
    // caller acting on it needs to be told it is no longer in force.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetStatus.mockResolvedValue(statusRow({ expires_at: '2026-01-01T00:00:00.000Z' }));

    const response = await GET(getRequest('ath-1'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toMatchObject({ status: 'cleared' });
    expect(payload.effectiveStatus).toBe('cleared_expired');
  });

  test('a current clearance reports as cleared', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetStatus.mockResolvedValue(statusRow({ expires_at: futureIso() }));

    const payload = await (await GET(getRequest('ath-1'))).json();

    expect(payload.effectiveStatus).toBe('cleared');
  });

  test('no record at all reports as no_record', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetStatus.mockResolvedValue(null);

    const payload = await (await GET(getRequest('ath-1'))).json();

    expect(payload.status).toBeNull();
    expect(payload.effectiveStatus).toBe('no_record');
  });
});
