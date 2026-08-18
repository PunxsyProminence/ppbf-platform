import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { createShadowResearchRequirement } from '@/src/server/pilot/shadowResearch';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/guardianAccess', () => ({ guardianAthleteIds: jest.fn() }));
jest.mock('@/src/server/pilot/shadowResearch', () => ({
  createShadowResearchRequirement: jest.fn(),
  listShadowResearchRequirements: jest.fn(),
  resolveShadowResearchRequirement: jest.fn(),
}));

// requireRole stays real so the role sets are exercised; only the per-athlete
// check is mocked, because its real implementation reaches the database for
// coach and organization-admin actors.
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockCreate = createShadowResearchRequirement as jest.MockedFunction<typeof createShadowResearchRequirement>;
const mockAssertAthlete = assertActorCanAccessAthlete as jest.MockedFunction<typeof assertActorCanAccessAthlete>;

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/shadow/research-requirements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  source_event_name: 'manual_review',
  source_entity_type: 'manual',
  source_entity_id: 'entry-1',
  research_requirement: 'Confirm technique doctrine.',
  knowledge_gap: 'No authoritative source cited yet.',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockCreate.mockResolvedValue(101);
  mockAssertAthlete.mockResolvedValue(undefined);
});

describe('POST /api/pilot/shadow/research-requirements (create)', () => {
  test('rejects a non-string subject_id', async () => {
    const response = await POST(postRequest({ ...validBody, subject_id: 42 }));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('runs the per-athlete check when subject_id is supplied', async () => {
    await POST(postRequest({ ...validBody, subject_id: 'ath-9' }));

    expect(mockAssertAthlete).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-real' }),
      'ath-9',
    );
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 'ath-9' }));
  });

  test('skips the per-athlete check when no subject_id is supplied', async () => {
    await POST(postRequest(validBody));

    expect(mockAssertAthlete).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ subjectId: null }));
  });

  test('treats a blank subject_id as absent rather than as a subject', async () => {
    await POST(postRequest({ ...validBody, subject_id: '   ' }));

    expect(mockAssertAthlete).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ subjectId: null }));
  });

  test('refuses a caller not linked to the named athlete', async () => {
    mockAssertAthlete.mockRejectedValueOnce(new Error('Forbidden: parent not linked to athlete'));

    const response = await POST(postRequest({ ...validBody, subject_id: 'ath-not-theirs' }));

    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
