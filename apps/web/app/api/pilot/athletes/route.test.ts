import { NextRequest } from 'next/server';

import { POST } from './route';
import { insertAthleteIfAbsent } from '@/src/server/pilot/entities';
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
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockInsertAthleteIfAbsent = insertAthleteIfAbsent as jest.Mock;

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

// Every one of the eight caller-supplied athlete fields must be present and
// non-empty: validateAthleteCreatePayload rejects missing keys as hard as it
// rejects extra ones, so a partial fixture would fail at validation and never
// reach the duplicate guard under test. created_at and updated_at are not the
// caller's to send; the route stamps them from the server clock.
type AthleteBody = Omit<PilotAthlete, 'created_at' | 'updated_at'>;

const SERVER_NOW = '2026-10-03T15:00:00.000Z';

function athletePayload(overrides: Partial<PilotAthlete> = {}): AthleteBody & Partial<PilotAthlete> {
  return {
    athlete_id: 'ath-new-1',
    full_name: 'Dawn Kellerman',
    dob: '2008-04-17',
    weight_class: '145',
    gym_status: 'active',
    emergency_contact: 'Ruth Kellerman 814-555-0143',
    active_flag: true,
    coach_id: 'coach-1',
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

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(SERVER_NOW), doNotFake: ['nextTick', 'setImmediate'] });
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('POST /api/pilot/athletes', () => {
  test('creates a roster row for an athlete_id that is not yet taken', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockInsertAthleteIfAbsent.mockResolvedValueOnce(true);

    const payload = athletePayload();
    const response = await POST(makeRequest({ ...payload }));

    expect(response.status).toBe(200);
    expect(mockInsertAthleteIfAbsent).toHaveBeenCalledWith('org-1', {
      ...payload,
      created_at: SERVER_NOW,
      updated_at: SERVER_NOW,
    });
    await expect(response.json()).resolves.toEqual({ ok: true, athlete_id: 'ath-new-1' });
  });

  // The reused-id check compares the roster row's created_at with a
  // submission's time, so a device clock running slow or fast must not reach
  // the row. A People tab opened before the page stopped sending them still
  // sends both: they are dropped, not refused, so that tab keeps working.
  test('stamps created_at and updated_at from the server clock, dropping any the caller sent', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockInsertAthleteIfAbsent.mockResolvedValueOnce(true);

    const response = await POST(makeRequest({
      ...athletePayload(),
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2031-01-01T00:00:00.000Z',
    }));

    expect(response.status).toBe(200);
    expect(mockInsertAthleteIfAbsent).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ created_at: SERVER_NOW, updated_at: SERVER_NOW }),
    );
  });

  test('still refuses a field the roster row does not have', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(makeRequest({ ...athletePayload(), shoe_size: '9' }));

    expect(response.status).toBe(400);
    expect(mockInsertAthleteIfAbsent).not.toHaveBeenCalled();
  });

  // An "on conflict do update" would happily overwrite the existing row's
  // name, dob, coach and emergency contact, so the guard failing open is
  // silent data loss -- not merely a confusing response code. The write is
  // create-only in SQL, so a taken id comes back as "not inserted".
  test('refuses to write over an athlete_id that already exists in the organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockInsertAthleteIfAbsent.mockResolvedValueOnce(false);

    const response = await POST(makeRequest({ ...athletePayload({ athlete_id: 'ath-existing-1' }) }));

    expect(response.status).toBe(409);
    // The id has to be echoed back: the admin typed it by hand and needs to
    // know which one collided before they retry.
    await expect(response.json()).resolves.toEqual({ error: 'Athlete record already exists: ath-existing-1' });
  });

  test('rejects a coach creating an athlete assigned to a different coach', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-1', role: 'coach', authProvider: 'ppbf_local' }));

    const response = await POST(makeRequest({ ...athletePayload({ coach_id: 'coach-2' }) }));

    expect(response.status).toBe(403);
    expect(mockInsertAthleteIfAbsent).not.toHaveBeenCalled();
  });

  test('allows a coach to create an athlete assigned to themselves', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'coach-1', role: 'coach', authProvider: 'ppbf_local' }));
    mockInsertAthleteIfAbsent.mockResolvedValueOnce(true);

    const response = await POST(makeRequest({ ...athletePayload({ coach_id: 'coach-1' }) }));

    expect(response.status).toBe(200);
    expect(mockInsertAthleteIfAbsent).toHaveBeenCalledTimes(1);
  });

  test('rejects a role that is not permitted to touch the roster', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'ath-account-1', role: 'athlete', athleteId: 'ath-1', authProvider: 'ppbf_local' }));

    const response = await POST(makeRequest({ ...athletePayload() }));

    expect(response.status).toBe(403);
    expect(mockInsertAthleteIfAbsent).not.toHaveBeenCalled();
  });
});
