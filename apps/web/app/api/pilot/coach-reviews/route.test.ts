import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { getCoachReviewById, getSessionAthleteId, upsertCoachReview } from '@/src/server/pilot/entities';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { validateCoachReviewPayload } from '@/src/server/pilot/validation';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));
jest.mock('@/src/server/pilot/entities', () => ({
  getCoachReviewById: jest.fn(),
  getSessionAthleteId: jest.fn(),
  upsertCoachReview: jest.fn(),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/src/server/pilot/validation', () => ({ validateCoachReviewPayload: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockGetReview = getCoachReviewById as jest.Mock;
const mockGetSessionAthleteId = getSessionAthleteId as jest.Mock;
const mockUpsert = upsertCoachReview as jest.Mock;
const mockValidate = validateCoachReviewPayload as jest.Mock;

const PAYLOAD = {
  review_id: 'rev-1',
  session_id: 'sess-A',
  coach_id: 'acct-coach',
  decision: 'approved',
  notes: 'looks good',
  approved_flag: true,
  created_at: '2026-08-25T00:00:00Z',
  updated_at: '2026-08-25T00:00:00Z',
};

function principal() {
  return {
    accountId: 'acct-coach',
    role: 'coach',
    organizationId: 'org-a',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function request() {
  return new NextRequest('http://localhost/api/pilot/coach-reviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(PAYLOAD),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockValidate.mockReturnValue(PAYLOAD);
  mockAccess.mockResolvedValue(undefined);
  mockGetSessionAthleteId.mockResolvedValue('ath-A');
  mockGetReview.mockResolvedValue(null);
  mockUpsert.mockResolvedValue(undefined);
});

describe('coach-reviews create authorizes the STORED review owner before overwriting it', () => {
  // The bug: the create route authorized only the PAYLOAD's session athlete, then
  // called an UPDATE-first upsert keyed on (organization_id, review_id). So a coach
  // with access to their own athlete could supply an EXISTING review_id belonging to
  // another athlete's session and overwrite that athlete's review-clearance record.
  // The create path must resolve the STORED review's owner and authorize it (and
  // compare-and-set on it) before any write -- the same shape the update route and
  // #624's session/goal create routes already use.
  test('a coach cannot overwrite another athlete’s review by supplying its id; nothing is written', async () => {
    mockGetReview.mockResolvedValue({
      review_id: 'rev-1',
      session_id: 'sess-B',
      coach_id: 'acct-other',
      decision: 'approved',
      notes: '',
      approved_flag: true,
      created_at: 'x',
      updated_at: 'x',
    });
    mockGetSessionAthleteId.mockImplementation(async (_org: string, sid: string) =>
      sid === 'sess-A' ? 'ath-A' : 'ath-B',
    );
    mockAccess.mockImplementation(async (_p: unknown, athleteId: string) => {
      if (athleteId === 'ath-B') throw new Error('Forbidden: not your athlete');
    });

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ath-B');
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('a genuinely new review is create-only and audited', async () => {
    mockGetReview.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith('org-a', PAYLOAD, { mode: 'create' });
    expect(writePilotAuditEvent).toHaveBeenCalledTimes(1);
  });

  test('overwriting a review the coach CAN reach is a compare-and-set on the stored session', async () => {
    mockGetReview.mockResolvedValue({
      review_id: 'rev-1',
      session_id: 'sess-A2',
      coach_id: 'acct-coach',
      decision: 'pending',
      notes: '',
      approved_flag: false,
      created_at: 'x',
      updated_at: 'x',
    });
    mockGetSessionAthleteId.mockResolvedValue('ath-A');

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith('org-a', PAYLOAD, { mode: 'update', expectedSessionId: 'sess-A2' });
  });
});
