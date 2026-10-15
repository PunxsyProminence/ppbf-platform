import { NextRequest } from 'next/server';

import { GET } from './route';
import { listGuardianCopiesOfAthleteMessages } from '@/src/server/pilot/athleteCoachMessages';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/guardianAccess', () => ({
  guardianAthleteIds: jest.fn(),
}));

// The guardian copy read itself (minors only, own children only, other gym
// never) is proved on Postgres in athleteCoachMessages.pg.test.ts. Here: the
// role, and that the scope is the guardian's own, resolved on this request.
// (#1542, FC-06 Q-2 B)
jest.mock('@/src/server/pilot/athleteCoachMessages', () => ({
  listGuardianCopiesOfAthleteMessages: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockScope = jest.mocked(guardianAthleteIds);
const mockList = jest.mocked(listGuardianCopiesOfAthleteMessages);

function principal(role = 'parent') {
  return { accountId: 'parent-1', role, organizationId: 'org-1', athleteId: null, sessionToken: 'token', authProvider: 'microsoft' } as never;
}

const COPY = { note_id: 'n1', athlete_id: 'ath-1', note_text: 'Great work on the jab.', created_at: '2026-10-13T22:00:00.000Z', from_name: 'Coach Pat Smith' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/parent/athlete-messages (#1542, FC-06 Q-2 B)', () => {
  test("a guardian reads the copies for the children linked to them now, ignoring any athlete in the request", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockScope.mockResolvedValue(['ath-1']);
    mockList.mockResolvedValue([COPY]);

    const response = await GET(new NextRequest('http://localhost/api/pilot/parent/athlete-messages?athlete_id=ath-other'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, items: [COPY] });
    expect(mockScope).toHaveBeenCalledWith('org-1', 'parent-1');
    expect(mockList).toHaveBeenCalledWith('org-1', ['ath-1']);
  });

  test.each(['athlete', 'coach', 'organization_admin', 'admin', 'board', 'platform_owner'])('%s is refused and nothing is read', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await GET(new NextRequest('http://localhost/api/pilot/parent/athlete-messages'));

    expect(response.status).toBe(403);
    expect(mockScope).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });
});
