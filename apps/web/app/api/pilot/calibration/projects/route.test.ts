import type { NextRequest } from 'next/server';

import { BOXING_ONTOLOGY_VERSION_0_1 } from '@/src/server/pilot/calibration/ontology';
import {
  createCalibrationProject,
  listCalibrationProjects,
} from '@/src/server/pilot/calibration/projects';
import { requirePrincipal } from '@/src/server/pilot/http';

import { writeCalibrationAuditEvent } from '../annotatorGate';
import { GET, POST } from './route';

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
  createCalibrationProject: jest.fn(),
}));

// Doubled so this suite exercises the ROUTE. The helper forces
// shadow_mirror: false on every calibration write; annotatorGate.ts owns that.
jest.mock('../annotatorGate', () => {
  const actual = jest.requireActual('../annotatorGate');
  return { ...actual, writeCalibrationAuditEvent: jest.fn() };
});

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockList = listCalibrationProjects as jest.Mock;
const mockCreateProject = createCalibrationProject as jest.Mock;
const mockAudit = writeCalibrationAuditEvent as jest.Mock;

const COACH = {
  accountId: 'coach-1',
  role: 'coach',
  organizationId: 'org-1',
  athleteId: null,
  sessionToken: 'token',
  authProvider: 'ppbf_local',
};

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

test('the list says which vocabulary new studies use and which ones can be labelled', async () => {
  // The cut page disables any study it cannot label. A 0.2 in the labellable
  // list before 0.2's rules and screen exist would let a coach cut clips into
  // a study nobody can open.
  mockPrincipal.mockResolvedValueOnce({ accountId: 'coach-1', role: 'coach', organizationId: 'org-1' });
  mockList.mockResolvedValueOnce([]);

  const body = await (await GET(request())).json();

  expect(body.supported_ontology_version).toBe('boxing-ontology-0.1');
  expect(body.annotatable_ontology_versions).toEqual(['boxing-ontology-0.1']);
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

/*
 * STARTING A STUDY.
 *
 * This route's own docblock used to say creating one was "an operator act" and
 * that it "deliberately offers no way to create" a study. That was true, and it
 * was the defect: the only path was a hand-run script holding a production
 * connection string, so no coach could open a study and the teaching loop
 * stopped before it began.
 */

const CREATED_PROJECT = {
  organization_id: 'org-1',
  calibration_project_id: 'proj-new',
  name: 'Calibration round 2',
  ontology_version: 'boxing-ontology-0.1',
  status: 'draft',
};

function postProject(body: unknown): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as NextRequest;
}

describe('POST /api/pilot/calibration/projects', () => {
  test('401 when unauthenticated, and nothing is written', async () => {
    mockPrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    expect((await POST(postProject({ name: 'X' }))).status).toBe(401);
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner'])(
    'a %s cannot start a study',
    async (role) => {
      mockPrincipal.mockResolvedValueOnce({ ...COACH, role });

      expect((await POST(postProject({ name: 'X' }))).status).toBe(403);
      expect(mockCreateProject).not.toHaveBeenCalled();
    },
  );

  test('a coach starts a study, stamped with this build\'s vocabulary', async () => {
    mockPrincipal.mockResolvedValueOnce(COACH);
    mockCreateProject.mockResolvedValueOnce(CREATED_PROJECT);

    const response = await POST(postProject({ name: '  Calibration round 2  ' }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, project: { name: 'Calibration round 2' } });
    /*
     * THE ONTOLOGY VERSION AND THE STATUS ARE NOT PARAMETERS. A caller-supplied
     * version would open a study this UI cannot honestly label; a
     * caller-supplied status would let one open straight into 'adjudicating',
     * making createCalibrationProject's own claim -- that every study begins
     * unsettled -- false.
     */
    expect(mockCreateProject).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      name: 'Calibration round 2',
      ontologyVersion: BOXING_ONTOLOGY_VERSION_0_1,
      createdByAccountId: 'coach-1',
    }));
    expect(mockCreateProject.mock.calls[0]![0]).not.toHaveProperty('status');
  });

  test.each([['absent', {}], ['blank', { name: '   ' }]])(
    'a %s name is a 400 before anything is written',
    async (_label, body) => {
      mockPrincipal.mockResolvedValueOnce(COACH);

      expect((await POST(postProject(body))).status).toBe(400);
      expect(mockCreateProject).not.toHaveBeenCalled();
    },
  );

  test('a name already used is a 409 that names it, not a raw constraint violation', async () => {
    // "duplicate key value violates unique constraint" is not a sentence to
    // put in front of a coach who has just typed a name.
    mockPrincipal.mockResolvedValueOnce(COACH);
    mockCreateProject.mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'pilot_calibration_projects_name_uq',
    }));

    const response = await POST(postProject({ name: 'Calibration round 2' }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.reason).toBe('CALIBRATION_PROJECT_NAME_TAKEN');
    expect(body.error).toContain('Calibration round 2');
  });

  test('a DIFFERENT unique violation is not reported as a name collision', async () => {
    mockPrincipal.mockResolvedValueOnce(COACH);
    mockCreateProject.mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'pilot_calibration_projects_pkey',
    }));

    expect((await POST(postProject({ name: 'X' }))).status).not.toBe(409);
  });

  test('a failed audit write is reported, and names the study that survived it', async () => {
    /*
     * The study exists and a name is unique per organization, so a caller told
     * only "failed" would try again with the same name and hit a collision
     * with a row nobody knew existed. The message must survive jsonError,
     * which replaces anything it does not recognise with "Internal server
     * error" -- so this path returns rather than throws.
     */
    mockPrincipal.mockResolvedValueOnce(COACH);
    mockCreateProject.mockResolvedValueOnce(CREATED_PROJECT);
    mockAudit.mockRejectedValueOnce(new Error('audit table unavailable'));

    const response = await POST(postProject({ name: 'Calibration round 2' }));
    const body = await response.json();

    expect(response.status).not.toBe(201);
    expect(body.error).toContain('Calibration round 2');
    expect(body.error).toContain('still exists');
  });
});
