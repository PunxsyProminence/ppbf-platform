import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import {
  ensurePpbfAssessmentProtocols,
  listAthleteAssessmentHistory,
  recordJumpResult,
  recordSkillRatings,
} from '@/src/server/pilot/assessmentResults';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/assessmentResults', () => {
  const actual = jest.requireActual('@/src/server/pilot/assessmentResults');
  return {
    ...actual,
    ensurePpbfAssessmentProtocols: jest.fn(),
    listAthleteAssessmentHistory: jest.fn(),
    recordJumpResult: jest.fn(),
    recordSkillRatings: jest.fn(),
  };
});

const principalMock = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const accessMock = assertActorCanAccessAthlete as jest.MockedFunction<typeof assertActorCanAccessAthlete>;
const ensureMock = ensurePpbfAssessmentProtocols as jest.MockedFunction<typeof ensurePpbfAssessmentProtocols>;
const historyMock = listAthleteAssessmentHistory as jest.MockedFunction<typeof listAthleteAssessmentHistory>;
const jumpMock = recordJumpResult as jest.MockedFunction<typeof recordJumpResult>;
const ratingsMock = recordSkillRatings as jest.MockedFunction<typeof recordSkillRatings>;

function principal(role: PilotPrincipal['role']): PilotPrincipal {
  return {
    accountId: 'acct-coach',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal;
}

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/coach/assessments${query}`);
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/pilot/coach/assessments', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  principalMock.mockResolvedValue(principal('coach'));
  accessMock.mockResolvedValue(undefined);
  ensureMock.mockResolvedValue(undefined);
  historyMock.mockResolvedValue([]);
});

describe('GET /api/pilot/coach/assessments', () => {
  test('returns the catalog and the one athlete\'s history after the access gate', async () => {
    const response = await GET(getRequest('?athlete_id=ath-1'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(accessMock).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'ath-1');
    expect(historyMock).toHaveBeenCalledWith('org-1', 'ath-1');
    expect(body.jump_protocols.map((p: { protocol_id: string }) => p.protocol_id)).toEqual([
      'ppbf-jump-cmj-height',
      'ppbf-jump-broad-distance',
    ]);
    expect(body.skill_families).toHaveLength(12);
    expect(body.rating_levels.map((l: { label: string }) => l.label)).toEqual([
      'Learning', 'Developing', 'Solid', 'Applies', 'Sharp',
    ]);
  });

  test('an athlete the coach may not reach is refused before any read', async () => {
    accessMock.mockRejectedValue(new Error('Forbidden: coach is not assigned to athlete'));
    const response = await GET(getRequest('?athlete_id=ath-other'));
    expect(response.status).toBe(403);
    expect(historyMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  test('missing athlete_id is a 400', async () => {
    const response = await GET(getRequest(''));
    expect(response.status).toBe(400);
  });

  test('an athlete or parent role is refused', async () => {
    principalMock.mockResolvedValue(principal('athlete'));
    const response = await GET(getRequest('?athlete_id=ath-1'));
    expect(response.status).toBe(403);
    expect(accessMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/coach/assessments', () => {
  test('records a jump for an authorized athlete', async () => {
    jumpMock.mockResolvedValue({} as never);
    const response = await POST(postRequest({
      athlete_id: 'ath-1', kind: 'jump', protocol_id: 'ppbf-jump-cmj-height', value_cm: 40,
    }));
    expect(response.status).toBe(201);
    expect(jumpMock).toHaveBeenCalledWith(
      { organizationId: 'org-1', accountId: 'acct-coach', role: 'coach' },
      expect.objectContaining({ athleteId: 'ath-1', protocolId: 'ppbf-jump-cmj-height', valueCm: 40 }),
    );
  });

  test('records a rating sheet', async () => {
    ratingsMock.mockResolvedValue([]);
    const ratings = [{ skill_family_id: 'SKILL-01', level: 3 }];
    const response = await POST(postRequest({ athlete_id: 'ath-1', kind: 'skill_ratings', ratings }));
    expect(response.status).toBe(201);
    expect(ratingsMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ratings }));
  });

  test('an unreachable athlete is refused before any write', async () => {
    accessMock.mockRejectedValue(new Error('Forbidden: coach is not assigned to athlete'));
    const response = await POST(postRequest({
      athlete_id: 'ath-other', kind: 'jump', protocol_id: 'ppbf-jump-cmj-height', value_cm: 40,
    }));
    expect(response.status).toBe(403);
    expect(jumpMock).not.toHaveBeenCalled();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  test('an unknown kind is a 400 and writes nothing', async () => {
    const response = await POST(postRequest({ athlete_id: 'ath-1', kind: 'ranking' }));
    expect(response.status).toBe(400);
    expect(jumpMock).not.toHaveBeenCalled();
    expect(ratingsMock).not.toHaveBeenCalled();
  });
});
