import { NextRequest } from 'next/server';

import { GET } from './route';
import {
  getClassAttendanceRoster,
  getOrganizationAttendanceSummary,
} from '@/src/server/pilot/attendanceReporting';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getSchedulerClassById } from '@/src/server/pilot/schedulerDb';

jest.mock('@/src/server/pilot/attendanceReporting', () => ({
  getOrganizationAttendanceSummary: jest.fn(),
  getClassAttendanceRoster: jest.fn(),
}));

jest.mock('@/src/server/pilot/schedulerDb', () => ({
  getSchedulerClassById: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  requirePrincipal: jest.fn(),
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith('Unauthorized')
      ? 401
      : message.startsWith('Forbidden')
        ? 403
        : message.startsWith('Missing')
          ? 400
          : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  },
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockSummary = jest.mocked(getOrganizationAttendanceSummary);
const mockRoster = jest.mocked(getClassAttendanceRoster);
const mockGetClass = jest.mocked(getSchedulerClassById);

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-caller',
    role,
    organizationId: 'org-a',
    athleteId: null,
    ...overrides,
  } as never;
}

function request(url: string): NextRequest {
  return new NextRequest(`https://ppbf.example${url}`);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/scheduler/attendance-summary', () => {
  test('organization_admin gets an org-wide summary with no coach filter', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockSummary.mockResolvedValueOnce([]);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary'));

    expect(response.status).toBe(200);
    expect(mockSummary).toHaveBeenCalledWith('org-a', { coachAccountId: undefined, sinceIso: undefined });
  });

  test('coach gets a summary scoped to their own account', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-1' }));
    mockSummary.mockResolvedValueOnce([]);

    await GET(request('/api/pilot/scheduler/attendance-summary'));

    expect(mockSummary).toHaveBeenCalledWith('org-a', { coachAccountId: 'acct-coach-1', sinceIso: undefined });
  });

  test('athlete, parent, and board are refused -- this is an ops surface, not self-service', async () => {
    for (const role of ['athlete', 'parent', 'board']) {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));
      const response = await GET(request('/api/pilot/scheduler/attendance-summary'));
      expect(response.status).toBe(403);
    }
    expect(mockSummary).not.toHaveBeenCalled();
  });

  test('a class_id query returns that class roster instead of the org summary', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetClass.mockResolvedValueOnce({
      class_id: 'class-1',
      coach_account_id: 'acct-coach-1',
      scheduled_by_account_id: 'acct-coach-1',
      covering_coach_account_id: undefined,
    } as never);
    mockRoster.mockResolvedValueOnce([]);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?class_id=class-1'));

    expect(response.status).toBe(200);
    expect(mockRoster).toHaveBeenCalledWith('org-a', 'class-1');
    expect(mockSummary).not.toHaveBeenCalled();
  });

  test('a coach who does not own the requested class is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-coach-2' }));
    mockGetClass.mockResolvedValueOnce({
      class_id: 'class-1',
      coach_account_id: 'acct-coach-1',
      scheduled_by_account_id: 'acct-coach-1',
      covering_coach_account_id: undefined,
    } as never);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?class_id=class-1'));

    expect(response.status).toBe(403);
    expect(mockRoster).not.toHaveBeenCalled();
  });

  test('a coach who covers the class is allowed even without owning it', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach', { accountId: 'acct-covering' }));
    mockGetClass.mockResolvedValueOnce({
      class_id: 'class-1',
      coach_account_id: 'acct-coach-1',
      scheduled_by_account_id: 'acct-coach-1',
      covering_coach_account_id: 'acct-covering',
    } as never);
    mockRoster.mockResolvedValueOnce([]);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?class_id=class-1'));

    expect(response.status).toBe(200);
  });

  test('a class_id with no matching class is a 400 Missing error, not a 500', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockGetClass.mockResolvedValueOnce(null);

    const response = await GET(request('/api/pilot/scheduler/attendance-summary?class_id=nope'));

    expect(response.status).toBe(400);
    expect(mockRoster).not.toHaveBeenCalled();
  });
});
