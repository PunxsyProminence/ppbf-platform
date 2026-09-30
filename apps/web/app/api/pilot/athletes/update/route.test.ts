import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getAthleteById, upsertAthlete } from '@/src/server/pilot/entities';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotAthlete } from '@/src/server/pilot/contracts';

// Only requirePrincipal is faked here. The real jsonError is kept so the
// status assertions below exercise the actual prefix-to-status mapping, and
// the real access checks run against the fixtures.
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  getAthleteById: jest.fn(),
  upsertAthlete: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn().mockResolvedValue(undefined) };
});

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetAthleteById = getAthleteById as jest.Mock;
const mockUpsertAthlete = upsertAthlete as jest.Mock;
const mockWriteAudit = writePilotAuditEvent as jest.Mock;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'admin@punxsyprominence.org',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  };
}

function athletePayload(overrides: Partial<PilotAthlete> = {}): PilotAthlete {
  return {
    athlete_id: 'ath-001',
    full_name: 'Dawn Kellerman',
    dob: '2012-04-17',
    weight_class: '106',
    gym_status: 'training',
    emergency_contact: 'Ruth Kellerman 814-555-0143',
    active_flag: true,
    coach_id: 'coach-1',
    created_at: '2026-07-29T12:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/athletes/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/athletes/update', () => {
  test('records which fields a correction moved, and never their values', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetAthleteById.mockResolvedValueOnce(athletePayload({ dob: '2012-04-07' }));

    const response = await POST(makeRequest({ ...athletePayload({ dob: '2012-04-17' }) }));

    expect(response.status).toBe(200);
    expect(mockUpsertAthlete).toHaveBeenCalledTimes(1);

    const audit = mockWriteAudit.mock.calls[0][0];
    expect(audit.event_type).toBe('update');
    expect(audit.entity_id).toBe('ath-001');
    expect(audit.details.changed_fields).toEqual(['dob']);
    // Audit details are mirrored into SHADOW's event stream, so a minor's
    // corrected date of birth must not be copied there alongside the field name.
    expect(JSON.stringify(audit.details)).not.toContain('2012-04-17');
    expect(JSON.stringify(audit.details)).not.toContain('Dawn Kellerman');
  });

  // node-postgres parses a `date` column to a Date at local midnight while the
  // request carries a string, so a naive comparison reports dob as corrected
  // on every save and the audit trail stops meaning anything.
  test('does not report a date of birth as changed when only other fields moved', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetAthleteById.mockResolvedValueOnce(
      athletePayload({ dob: new Date(2012, 3, 17) as unknown as string, weight_class: '101' }),
    );

    const response = await POST(makeRequest({ ...athletePayload({ weight_class: '106' }) }));

    expect(response.status).toBe(200);
    expect(mockWriteAudit.mock.calls[0][0].details.changed_fields).toEqual(['weight_class']);
  });

  test('marks an offboarding distinctly from a typo fix', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetAthleteById.mockResolvedValueOnce(athletePayload({ active_flag: true }));

    const response = await POST(makeRequest({ ...athletePayload({ active_flag: false }) }));

    expect(response.status).toBe(200);
    expect(mockWriteAudit.mock.calls[0][0].details).toEqual({
      changed_fields: [],
      active_flag_change: 'deactivated',
    });
    // History stays: the write is an update to the existing row, not a delete.
    expect(mockUpsertAthlete).toHaveBeenCalledWith('org-1', expect.objectContaining({
      athlete_id: 'ath-001',
      active_flag: false,
      created_at: '2026-07-29T12:00:00.000Z',
    }));
  });

  test('refuses an athlete deactivating their own record', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(
      principal({ accountId: 'ath-account-1', role: 'athlete', athleteId: 'ath-001', authProvider: 'ppbf_local' }),
    );
    mockGetAthleteById.mockResolvedValueOnce(athletePayload({ active_flag: true }));

    const response = await POST(makeRequest({ ...athletePayload({ active_flag: false }) }));

    expect(response.status).toBe(403);
    expect(mockUpsertAthlete).not.toHaveBeenCalled();
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  // Jason 2026-09-29, Q2 A: an athlete may not change their own date of
  // birth; admins keep it; name and weight class stay the athlete's to edit.
  describe('date of birth lock for athletes', () => {
    const athletePrincipal = () =>
      principal({ accountId: 'ath-account-1', role: 'athlete', athleteId: 'ath-001', authProvider: 'ppbf_local' });

    test('refuses an athlete changing their own date of birth, with a plain 403', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
      mockGetAthleteById.mockResolvedValueOnce(athletePayload({ dob: '2012-04-17' }));

      const response = await POST(makeRequest({ ...athletePayload({ dob: '2000-04-17' }) }));

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Forbidden: athlete cannot change date of birth; ask an organization admin to correct it',
      });
      expect(mockUpsertAthlete).not.toHaveBeenCalled();
      expect(mockWriteAudit).not.toHaveBeenCalled();
    });

    test('allows an athlete save that leaves dob unchanged when the stored dob is a Date', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
      mockGetAthleteById.mockResolvedValueOnce(
        athletePayload({ dob: new Date(2012, 3, 17) as unknown as string }),
      );

      const response = await POST(makeRequest({ ...athletePayload({ dob: '2012-04-17' }) }));

      expect(response.status).toBe(200);
      expect(mockUpsertAthlete).toHaveBeenCalledTimes(1);
      expect(mockWriteAudit.mock.calls[0][0].details.changed_fields).toEqual([]);
    });

    test('allows an athlete save that leaves dob unchanged when the stored dob is a string', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
      mockGetAthleteById.mockResolvedValueOnce(athletePayload({ dob: '2012-04-17' }));

      const response = await POST(makeRequest({ ...athletePayload({ dob: '2012-04-17' }) }));

      expect(response.status).toBe(200);
      expect(mockUpsertAthlete).toHaveBeenCalledTimes(1);
    });

    test('still lets an athlete change their own name and weight class', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
      mockGetAthleteById.mockResolvedValueOnce(
        athletePayload({ dob: new Date(2012, 3, 17) as unknown as string, full_name: 'Dawn Kellermann', weight_class: '101' }),
      );

      const response = await POST(
        makeRequest({ ...athletePayload({ full_name: 'Dawn Kellerman', weight_class: '106' }) }),
      );

      expect(response.status).toBe(200);
      expect(mockUpsertAthlete).toHaveBeenCalledWith('org-1', expect.objectContaining({
        full_name: 'Dawn Kellerman',
        weight_class: '106',
        dob: '2012-04-17',
      }));
      expect(mockWriteAudit.mock.calls[0][0].details.changed_fields).toEqual(['full_name', 'weight_class']);
    });

    test('lets an organization admin correct a date of birth', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());
      mockGetAthleteById.mockResolvedValueOnce(athletePayload({ dob: '2012-04-17' }));

      const response = await POST(makeRequest({ ...athletePayload({ dob: '2012-04-07' }) }));

      expect(response.status).toBe(200);
      expect(mockUpsertAthlete).toHaveBeenCalledWith('org-1', expect.objectContaining({ dob: '2012-04-07' }));
    });

    test('lets a coach correct a date of birth, as before', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(
        principal({ accountId: 'coach-1', role: 'coach', authProvider: 'ppbf_local' }),
      );
      mockGetAthleteById.mockResolvedValueOnce(athletePayload({ dob: '2012-04-17' }));

      const response = await POST(makeRequest({ ...athletePayload({ dob: '2012-04-07' }) }));

      expect(response.status).toBe(200);
      expect(mockUpsertAthlete).toHaveBeenCalledWith('org-1', expect.objectContaining({ dob: '2012-04-07' }));
    });
  });

  test('refuses a role that may not touch athlete records at all', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'board' }));

    const response = await POST(makeRequest({ ...athletePayload() }));

    expect(response.status).toBe(403);
    expect(mockUpsertAthlete).not.toHaveBeenCalled();
  });
});
