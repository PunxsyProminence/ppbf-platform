import { NextRequest } from 'next/server';

import { POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  bulkUpsertSchedulerAttendance,
  getSchedulerClassById,
  listRegisteredAthleteIdsForClass,
  registerForClassTransactionally,
  upsertSchedulerAttendance,
} from '@/src/server/pilot/schedulerDb';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => ({
  assertActorCanAccessAthlete: jest.fn(),
  isOrganizationAdminRole: jest.fn((role: string) => role === 'organization_admin' || role === 'admin'),
}));

jest.mock('@/src/server/pilot/schedulerDb', () => ({
  registerForClassTransactionally: jest.fn(),
  getSchedulerClassById: jest.fn(),
  upsertSchedulerAttendance: jest.fn(),
  bulkUpsertSchedulerAttendance: jest.fn(),
  listRegisteredAthleteIdsForClass: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockRegister = registerForClassTransactionally as jest.Mock;
const mockAssertCanAct = assertActorCanAccessAthlete as jest.Mock;
const mockGetClass = getSchedulerClassById as jest.Mock;
const mockUpsertAttendance = upsertSchedulerAttendance as jest.Mock;
const mockBulkUpsertAttendance = bulkUpsertSchedulerAttendance as jest.Mock;
const mockListRegistered = listRegisteredAthleteIdsForClass as jest.Mock;

const classRecord = {
  class_id: 'class-1',
  title: 'Fundamentals',
  start_at: 'now',
  end_at: 'later',
  location: 'Main Floor',
  capacity: 20,
  scheduled_by_account_id: 'acct-coach-1',
  coach_account_id: 'acct-coach-1',
  status: 'open' as const,
  created_at: 'now',
  updated_at: 'now',
};

beforeEach(() => {
  mockAssertCanAct.mockResolvedValue(undefined);
  mockGetClass.mockResolvedValue(classRecord);
  mockUpsertAttendance.mockResolvedValue(undefined);
  mockBulkUpsertAttendance.mockResolvedValue(undefined);
  mockListRegistered.mockResolvedValue(['ATH-1', 'ATH-2', 'ATH-OUTSIDE']);
});

afterEach(() => {
  jest.clearAllMocks();
});

function athletePrincipal(): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  };
}

function principal(role: string, overrides: Record<string, unknown> = {}): PilotPrincipal {
  return {
    accountId: 'acct-caller',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  } as PilotPrincipal;
}

function registerRequest() {
  return new NextRequest('http://localhost/api/pilot/scheduler', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'register_class', class_id: 'class-1' }),
  });
}

function jsonRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/scheduler', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/pilot/scheduler register_class', () => {
  // Registering twice is a normal thing for a family to do; it has to read as
  // a conflict the UI can explain, never as a masked server error.
  test('409 with a readable reason when the athlete is already registered', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
    mockRegister.mockResolvedValueOnce({ outcome: 'already_registered' });

    const res = await POST(registerRequest());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Athlete already registered for this class' });
  });

  test('200 on a first registration', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(athletePrincipal());
    mockRegister.mockResolvedValueOnce({ outcome: 'registered' });

    const res = await POST(registerRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: 'registered' });
  });
});

describe('attendance_checkin method attribution', () => {
  // A parent checking in their own linked child was previously recorded as
  // method: 'coach_override' -- the else branch that resolveAttendanceMethod
  // replaces -- misattributing who actually made the call.
  // checked_in_by_role was always correct; only method lied.
  test('a parent checking in their own child is recorded as method "parent", not coach_override', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('parent', { accountId: 'acct-parent-1' }));

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'present' }),
    );

    expect(response.status).toBe(200);
    const [, record] = mockUpsertAttendance.mock.calls[0];
    expect(record.method).toBe('parent');
    expect(record.checked_in_by_role).toBe('parent');
  });

  test('a coach override is still recorded as coach_override', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));

    await POST(jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'absent' }));

    const [, record] = mockUpsertAttendance.mock.calls[0];
    expect(record.method).toBe('coach_override');
  });

  test('an admin override is still recorded as admin_override', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'acct-admin-1' }));

    await POST(jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'excused' }));

    const [, record] = mockUpsertAttendance.mock.calls[0];
    expect(record.method).toBe('admin_override');
  });

  test('an athlete self-checking-in is still recorded as self', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('athlete', { athleteId: 'ATH-1' }));

    await POST(jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', status: 'present' }));

    const [, record] = mockUpsertAttendance.mock.calls[0];
    expect(record.method).toBe('self');
  });
});

describe('bulk_attendance_checkin', () => {
  test('a coach marks a whole roster in one call', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [
          { athlete_id: 'ATH-1', status: 'present' },
          { athlete_id: 'ATH-2', status: 'absent', note: 'called in sick' },
        ],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, marked_count: 2 });
    expect(mockBulkUpsertAttendance).toHaveBeenCalledTimes(1);
    const [, records] = mockBulkUpsertAttendance.mock.calls[0];
    expect(records).toHaveLength(2);
    expect(records.map((r: { method: string }) => r.method)).toEqual(['coach_override', 'coach_override']);
    expect(mockAssertCanAct).toHaveBeenCalledTimes(2);
  });

  test('athlete and parent roles are refused -- bulk marking is a coach/admin action', async () => {
    for (const role of ['athlete', 'parent']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role, { athleteId: 'ATH-1' }));
      const response = await POST(
        jsonRequest({ action: 'bulk_attendance_checkin', class_id: 'class-1', entries: [{ athlete_id: 'ATH-1', status: 'present' }] }),
      );
      expect(response.status).toBe(403);
    }
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });

  test('a duplicate athlete_id in the batch is refused rather than silently overwritten', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [
          { athlete_id: 'ATH-1', status: 'present' },
          { athlete_id: 'ATH-1', status: 'absent' },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });

  test('an empty entries array is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));

    const response = await POST(jsonRequest({ action: 'bulk_attendance_checkin', class_id: 'class-1', entries: [] }));

    expect(response.status).toBe(400);
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });

  test("one athlete outside the coach's reach fails the whole batch before any write", async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockAssertCanAct
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Forbidden: coach not assigned to athlete'));

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [
          { athlete_id: 'ATH-1', status: 'present' },
          { athlete_id: 'ATH-OUTSIDE', status: 'present' },
        ],
      }),
    );

    expect(response.status).toBe(403);
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });
});

describe('coach class-ownership on attendance writes', () => {
  // Without this, a coach could overwrite another coach's attendance
  // attestations in a class they cannot even read (the summary route 403s
  // them) -- write access without read access, on a safeguarding record.
  test('a coach who does not own the class cannot bulk-mark it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-2' }));

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [{ athlete_id: 'ATH-1', status: 'absent' }],
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('does not own this class') });
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });

  test('a coach who does not own the class cannot single-mark it either', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-2' }));

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'absent' }),
    );

    expect(response.status).toBe(403);
    expect(mockUpsertAttendance).not.toHaveBeenCalled();
  });

  test('a covering coach owns the class for attendance purposes', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-covering' }));
    mockGetClass.mockResolvedValueOnce({ ...classRecord, covering_coach_account_id: 'acct-covering' });

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [{ athlete_id: 'ATH-1', status: 'present' }],
      }),
    );

    expect(response.status).toBe(200);
  });

  test('admin is not subject to class ownership', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin', { accountId: 'acct-admin-1' }));

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [{ athlete_id: 'ATH-1', status: 'present' }],
      }),
    );

    expect(response.status).toBe(200);
  });
});

describe('attendance requires registration', () => {
  // An unregistered mark counts in the org summary but appears on no class
  // roster -- a number no drill-down can explain -- and it is what let an
  // athlete self-mark 'present' in every class in the gym.
  test('single check-in for an unregistered athlete is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockListRegistered.mockResolvedValueOnce(['ATH-2']);

    const response = await POST(
      jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', athlete_id: 'ATH-1', status: 'present' }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('not registered') });
    expect(mockUpsertAttendance).not.toHaveBeenCalled();
  });

  test('an athlete cannot self-check-in to a class they are not registered for', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('athlete', { athleteId: 'ATH-1' }));
    mockListRegistered.mockResolvedValueOnce([]);

    const response = await POST(jsonRequest({ action: 'attendance_checkin', class_id: 'class-1', status: 'present' }));

    expect(response.status).toBe(400);
    expect(mockUpsertAttendance).not.toHaveBeenCalled();
  });

  test('a bulk batch containing one unregistered athlete fails whole before any write', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockListRegistered.mockResolvedValueOnce(['ATH-1']);

    const response = await POST(
      jsonRequest({
        action: 'bulk_attendance_checkin',
        class_id: 'class-1',
        entries: [
          { athlete_id: 'ATH-1', status: 'present' },
          { athlete_id: 'ATH-2', status: 'present' },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(mockBulkUpsertAttendance).not.toHaveBeenCalled();
  });
});
