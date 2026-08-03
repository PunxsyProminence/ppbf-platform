import { NextRequest } from 'next/server';

import { POST } from './route';
import { getAthleteById, getCoachById, insertAthleteIfAbsent } from '@/src/server/pilot/entities';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotAthlete } from '@/src/server/pilot/contracts';

// Only requirePrincipal is faked here. The real jsonError is kept so the
// status assertions below exercise the actual prefix-to-status mapping --
// a hand-rolled jsonError stub would just be asserting itself.
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  insertAthleteIfAbsent: jest.fn().mockResolvedValue(true),
  getCoachById: jest.fn().mockResolvedValue(true),
  getAthleteById: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockInsertAthleteIfAbsent = insertAthleteIfAbsent as jest.Mock;
const mockGetCoachById = getCoachById as jest.Mock;
const mockGetAthleteById = getAthleteById as jest.Mock;

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

// Every one of the ten athlete fields must be present and non-empty:
// validateAthletePayload rejects missing keys as hard as it rejects extra
// ones, so a partial fixture would fail at validation and never reach the
// duplicate guard under test.
function athletePayload(overrides: Partial<PilotAthlete> = {}): PilotAthlete {
  return {
    athlete_id: 'ath-new-1',
    full_name: 'Dawn Kellerman',
    dob: '2008-04-17',
    weight_class: '145',
    gym_status: 'active',
    emergency_contact: 'Ruth Kellerman 814-555-0143',
    active_flag: true,
    coach_id: 'coach-1',
    created_at: '2026-07-29T12:00:00.000Z',
    updated_at: '2026-07-29T12:00:00.000Z',
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/athletes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/athletes', () => {
  test('creates a roster row for an athlete_id that is not yet taken', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockInsertAthleteIfAbsent.mockResolvedValueOnce(true);

    const payload = athletePayload();
    const response = await POST(makeRequest({ ...payload }));

    expect(response.status).toBe(200);
    expect(mockInsertAthleteIfAbsent).toHaveBeenCalledWith('org-1', payload);
    await expect(response.json()).resolves.toEqual({ ok: true, athlete_id: 'ath-new-1' });
  });

  // An "on conflict do update" would happily overwrite the existing row's
  // name, dob, coach and emergency contact, so the guard failing open is
  // silent data loss -- not merely a confusing response code. The write is
  // create-only in SQL, so a taken id comes back as "not inserted".
  test('refuses to write over an athlete_id that already exists in the organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockInsertAthleteIfAbsent.mockResolvedValueOnce(false);
    mockGetAthleteById.mockResolvedValueOnce(null);

    const response = await POST(makeRequest({ ...athletePayload({ athlete_id: 'ath-existing-1' }) }));

    expect(response.status).toBe(409);
    // The id has to be echoed back: the admin typed it by hand and needs to
    // know which one collided before they retry.
    await expect(response.json()).resolves.toEqual({ error: 'Athlete record already exists: ath-existing-1' });
  });

  // "ath-014 is taken" cannot tell a typo that landed on a teammate apart from
  // a record the admin created themselves last week. The name can.
  test('names the athlete already holding a colliding athlete_id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockInsertAthleteIfAbsent.mockResolvedValueOnce(false);
    mockGetAthleteById.mockResolvedValueOnce(athletePayload({ athlete_id: 'ath-existing-1', full_name: 'Marcus Webb' }));

    const response = await POST(makeRequest({ ...athletePayload({ athlete_id: 'ath-existing-1' }) }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Athlete record already exists: ath-existing-1 belongs to Marcus Webb',
    });
  });

  test('rejects a coach attempting to create an athlete (roster management is admin-only)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-1', role: 'coach', authProvider: 'ppbf_local' }));

    const response = await POST(makeRequest({ ...athletePayload({ coach_id: 'coach-1' }) }));

    expect(response.status).toBe(403);
    expect(mockInsertAthleteIfAbsent).not.toHaveBeenCalled();
  });

  test('rejects a role that is not permitted to touch the roster', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'ath-account-1', role: 'athlete', athleteId: 'ath-1', authProvider: 'ppbf_local' }));

    const response = await POST(makeRequest({ ...athletePayload() }));

    expect(response.status).toBe(403);
    expect(mockInsertAthleteIfAbsent).not.toHaveBeenCalled();
  });

  test('rejects creation with a non-existent coach', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetCoachById.mockResolvedValueOnce(false);

    const response = await POST(makeRequest({ ...athletePayload({ coach_id: 'non-existent-coach' }) }));

    expect(response.status).toBe(404);
    expect(mockInsertAthleteIfAbsent).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('coach not found') });
  });

  test('allows creation when coach exists', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetCoachById.mockResolvedValueOnce(true);
    mockInsertAthleteIfAbsent.mockResolvedValueOnce(true);

    const payload = athletePayload();
    const response = await POST(makeRequest({ ...payload }));

    expect(response.status).toBe(200);
    expect(mockGetCoachById).toHaveBeenCalledWith('org-1', 'coach-1');
    expect(mockInsertAthleteIfAbsent).toHaveBeenCalledWith('org-1', payload);
  });
});
