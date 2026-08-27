import type { NextRequest } from 'next/server';

import { listCalibrationProjects } from '@/src/server/pilot/calibration/projects';
import { requirePrincipal } from '@/src/server/pilot/http';

import { GET } from './route';

// The study list. Small surface, two things worth pinning: who may see it, and
// that it is scoped to the caller's own gym rather than to anything the caller
// can name.
//
// jsonError is NOT mocked anywhere in this directory's tests. The mapping from
// message prefix to status ('Forbidden' -> 403, 'Missing ' -> 400, 'Not found'
// -> 404, anything else -> 500 with the message withheld) is the contract these
// routes rely on to report refusals, and a hand-written stand-in would test the
// stand-in.

jest.mock('@/src/server/pilot/calibration/projects', () => ({
  listCalibrationProjects: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockList = listCalibrationProjects as jest.Mock;

function request(): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/projects') as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('a coach sees the studies their own organization is running', async () => {
  mockPrincipal.mockResolvedValueOnce({ accountId: 'coach-1', role: 'coach', organizationId: 'org-1' });
  mockList.mockResolvedValueOnce([{ calibration_project_id: 'proj-1', name: 'Pilot' }]);

  const response = await GET(request());
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.projects).toEqual([{ calibration_project_id: 'proj-1', name: 'Pilot' }]);
  expect(mockList).toHaveBeenCalledWith('org-1');
});

test('the organization comes from the session, never from the request', async () => {
  mockPrincipal.mockResolvedValueOnce({ accountId: 'admin-1', role: 'organization_admin', organizationId: 'org-2' });
  mockList.mockResolvedValueOnce([]);

  await GET(new Request(
    'http://localhost/api/pilot/calibration/projects?organization_id=org-1',
  ) as NextRequest);

  expect(mockList).toHaveBeenCalledWith('org-2');
});

test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner'])(
  'a %s is refused without the list being read',
  async (role) => {
    mockPrincipal.mockResolvedValueOnce({ accountId: 'who-1', role, organizationId: 'org-1' });

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  },
);

test('the legacy admin role is the same person as organization_admin', async () => {
  mockPrincipal.mockResolvedValueOnce({ accountId: 'admin-1', role: 'admin', organizationId: 'org-1' });
  mockList.mockResolvedValueOnce([]);

  const response = await GET(request());

  expect(response.status).toBe(200);
});
