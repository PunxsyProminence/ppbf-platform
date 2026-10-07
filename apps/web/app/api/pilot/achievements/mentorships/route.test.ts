import { NextRequest } from 'next/server';

import { DELETE } from './route';
import { endMentorship, getMentorshipAthleteIds } from '@/src/server/pilot/achievements';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/achievements', () => ({
  ...jest.requireActual('@/src/server/pilot/achievements'),
  getMentorshipAthleteIds: jest.fn(),
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
const mockGet = getMentorshipAthleteIds as jest.Mock;
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

/** The access mock refuses exactly the named athletes, the way the real
 * check throws for an athlete outside the coach's reach. */
function reachEverythingExcept(...refused: string[]) {
  mockAccess.mockImplementation(async (_p: unknown, athleteId: string) => {
    if (refused.includes(athleteId)) throw new Error('Forbidden: not your athlete');
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
  // authorization must resolve the athletes via a read-only lookup and run
  // BEFORE any write.
  test('a coach with no relationship to the mentor athlete cannot end the pairing, and nothing is written', async () => {
    mockGet.mockResolvedValueOnce({ mentor_athlete_id: 'ath-victim', mentee_athlete_id: 'ath-mine' });
    reachEverythingExcept('ath-victim');

    const response = await DELETE(request());

    expect(response.status).toBe(403);
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ath-victim');
    expect(mockEnd).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  // The second bug (route survey 2026-10-07, B1): only the mentor side was
  // authorized. A coach who reaches the mentor but not the mentee could end
  // the mentee's pairing. POST already checks both ends; DELETE must too.
  test('a coach who reaches the mentor but NOT the mentee cannot end the pairing, and nothing is written', async () => {
    mockGet.mockResolvedValueOnce({ mentor_athlete_id: 'ath-mine', mentee_athlete_id: 'ath-not-mine' });
    reachEverythingExcept('ath-not-mine');

    const response = await DELETE(request());

    expect(response.status).toBe(403);
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ath-mine');
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ath-not-mine');
    expect(mockEnd).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('a mentorship id with no matching record is a 404 before any write', async () => {
    mockGet.mockResolvedValueOnce(null);

    const response = await DELETE(request());

    expect(response.status).toBe(404);
    expect(mockEnd).not.toHaveBeenCalled();
    expect(mockAccess).not.toHaveBeenCalled();
  });

  test('a coach who reaches BOTH athletes ends the pairing and it is audited', async () => {
    mockGet.mockResolvedValueOnce({ mentor_athlete_id: 'ath-mine', mentee_athlete_id: 'ath-also-mine' });
    mockEnd.mockResolvedValueOnce({ mentorship_id: 'm-1', mentor_athlete_id: 'ath-mine', ended_on: '2026-08-25' });

    const response = await DELETE(request());

    expect(response.status).toBe(200);
    expect(mockAccess).toHaveBeenCalledTimes(2);
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ath-mine');
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ath-also-mine');
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(writePilotAuditEvent).toHaveBeenCalledTimes(1);
  });
});
