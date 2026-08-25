import { NextRequest } from 'next/server';

import { DELETE } from './route';
import { endMentorship, getMentorshipById } from '@/src/server/pilot/achievements';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/achievements', () => ({
  ...jest.requireActual('@/src/server/pilot/achievements'),
  getMentorshipById: jest.fn(),
  endMentorship: jest.fn(),
}));

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn().mockResolvedValue(undefined) }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGet = getMentorshipById as jest.Mock;
const mockEnd = endMentorship as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;

function principal() {
  return { accountId: 'acct-coach', role: 'coach', organizationId: 'org-a', athleteId: null };
}

function request() {
  return new NextRequest('https://ppbf.example/api/pilot/achievements/mentorships?mentorship_id=m-1', {
    method: 'DELETE',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockAccess.mockResolvedValue(undefined);
});

describe('DELETE /api/pilot/achievements/mentorships', () => {
  // The bug: endMentorship writes the end date, and the access check ran on
  // its result -- so a coach with no relationship to the athlete ended the
  // pairing and only then was refused, with the row already mutated. The
  // authorization must resolve the athlete via a read-only lookup and run
  // BEFORE any write.
  test('a coach with no relationship to the mentor athlete cannot end the pairing, and nothing is written', async () => {
    mockGet.mockResolvedValueOnce({ mentorship_id: 'm-1', mentor_athlete_id: 'ath-victim' });
    mockAccess.mockImplementation(async (_p: unknown, athleteId: string) => {
      if (athleteId === 'ath-victim') throw new Error('Forbidden: not your athlete');
    });

    const response = await DELETE(request());

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ath-victim');
    expect(mockEnd).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('a missing mentorship id is a not-found before any write', async () => {
    mockGet.mockResolvedValueOnce(null);

    const response = await DELETE(request());

    expect(response.status).toBe(404);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  test('an authorized coach ends the pairing and it is audited', async () => {
    mockGet.mockResolvedValueOnce({ mentorship_id: 'm-1', mentor_athlete_id: 'ath-mine' });
    mockEnd.mockResolvedValueOnce({ mentorship_id: 'm-1', mentor_athlete_id: 'ath-mine', ended_on: '2026-08-25' });

    const response = await DELETE(request());

    expect(response.status).toBe(200);
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(writePilotAuditEvent).toHaveBeenCalledTimes(1);
  });
});
