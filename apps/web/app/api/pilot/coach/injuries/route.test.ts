import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  accessibleAthleteIds,
  assertAthleteBelongsToOrganization,
  assertCoachAssignedToAthlete,
} from '@/src/server/pilot/access';
import {
  getInjuryById,
  listInjuriesForAthlete,
  listLinkCandidates,
  markInjuryEnteredInError,
  recordInjury,
  updateInjury,
} from '@/src/server/pilot/athleteInjuries';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  accessibleAthleteIds: jest.fn(),
  assertAthleteBelongsToOrganization: jest.fn(),
  assertCoachAssignedToAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/athleteInjuries', () => ({
  ...jest.requireActual('@/src/server/pilot/athleteInjuries'),
  getInjuryById: jest.fn(),
  listInjuriesForAthlete: jest.fn(),
  listLinkCandidates: jest.fn(),
  markInjuryEnteredInError: jest.fn(),
  recordInjury: jest.fn(),
  updateInjury: jest.fn(),
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockCoachAssigned = assertCoachAssignedToAthlete as jest.Mock;
const mockBelongs = assertAthleteBelongsToOrganization as jest.Mock;
const mockAccessible = accessibleAthleteIds as jest.Mock;
const mockGetById = getInjuryById as jest.Mock;
const mockList = listInjuriesForAthlete as jest.Mock;
const mockCandidates = listLinkCandidates as jest.Mock;
const mockMark = markInjuryEnteredInError as jest.Mock;
const mockRecord = recordInjury as jest.Mock;
const mockUpdate = updateInjury as jest.Mock;

const ORG = 'org-1';
// A different athlete from the one any request body names, so the standing
// check is proven to use the INJURY's athlete, not one the caller supplies.
const INJURY = { injury_id: '11111111-1111-4111-8111-111111111111', athlete_id: 'ATH-9', staff_note: 'x' };

function as(role: string, accountId = `acct-${role}`) {
  mockPrincipal.mockResolvedValue({ accountId, role, organizationId: ORG, athleteId: null });
}

function getReq(athleteId = 'ATH-1') {
  return new NextRequest(`http://localhost/api/pilot/coach/injuries?athlete_id=${athleteId}`);
}

function postReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/coach/injuries', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const RECORD = {
  action: 'record',
  athlete_id: 'ATH-1',
  injury_date: '2026-09-01',
  body_area: 'wrist',
  injury_type: 'sprain_strain',
  context: 'training',
  reported_by: 'athlete',
  staff_note: '  Said it twisted.  ',
};

const moduleCalls = () =>
  [mockList, mockCandidates, mockRecord, mockUpdate, mockMark, mockGetById, mockAccessible].reduce((n, m) => n + m.mock.calls.length, 0);

beforeEach(() => {
  jest.resetAllMocks();
  mockCoachAssigned.mockResolvedValue(undefined);
  mockBelongs.mockResolvedValue(undefined);
  mockList.mockResolvedValue([INJURY]);
  mockCandidates.mockResolvedValue({ holds: [], plans: [], clearances: [], painReports: [] });
  mockRecord.mockResolvedValue(INJURY);
  mockUpdate.mockResolvedValue(INJURY);
  mockMark.mockResolvedValue(undefined);
  mockGetById.mockResolvedValue(INJURY);
});

describe.each(['platform_owner', 'board', 'athlete', 'parent', 'volunteer', 'staff'])(
  'role %s is refused before anything is read or written',
  (role) => {
    test('GET', async () => {
      as(role);
      const res = await GET(getReq());
      expect(res.status).toBe(403);
      expect(moduleCalls()).toBe(0);
    });

    test.each(['accessible_athletes', 'record', 'update', 'mark_entered_in_error'])('POST %s', async (action) => {
      as(role);
      const res = await POST(postReq({ ...RECORD, action, injury_id: INJURY.injury_id, athlete_ids: ['ATH-1'] }));
      expect(res.status).toBe(403);
      expect(moduleCalls()).toBe(0);
    });
  },
);

describe('a coach without standing with the athlete', () => {
  beforeEach(() => {
    as('coach');
    mockCoachAssigned.mockRejectedValue(new Error('Forbidden: coach is not assigned to athlete'));
  });

  test('cannot list or see link candidates', async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCandidates).not.toHaveBeenCalled();
  });

  test('cannot record', async () => {
    const res = await POST(postReq(RECORD));
    expect(res.status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test.each(['update', 'mark_entered_in_error'])('gets the same 404 as a missing injury on %s', async (action) => {
    const res = await POST(postReq({ ...RECORD, action, injury_id: INJURY.injury_id }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Injury record not found.' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
  });
});

describe('an assigned coach', () => {
  beforeEach(() => as('coach', 'acct-coach-1'));

  test('lists injuries and link candidates for the athlete, through the assignment gate', async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ ok: true, injuries: [INJURY], candidates: { holds: [] } });
    expect(mockCoachAssigned).toHaveBeenCalledWith('acct-coach-1', 'ATH-1', ORG);
    expect(mockBelongs).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalledWith(ORG, 'ATH-1');
  });

  test('records with the signed-in organization and recorder; the body cannot supply them', async () => {
    const res = await POST(
      postReq({
        ...RECORD,
        organizationId: 'org-evil',
        organization_id: 'org-evil',
        recordedByAccountId: 'someone-else',
        athleteId: 'ATH-OTHER',
      }),
    );
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const input = mockRecord.mock.calls[0][0];
    expect(input).toMatchObject({
      organizationId: ORG,
      athleteId: 'ATH-1',
      recordedByAccountId: 'acct-coach-1',
      recordedByRole: 'coach',
      injuryDate: '2026-09-01',
      bodyArea: 'wrist',
      staffNote: 'Said it twisted.',
    });
    expect(Object.keys(input)).not.toContain('organization_id');
  });

  test('edits and marks only after naming the injury and checking standing with its athlete', async () => {
    let res = await POST(postReq({ ...RECORD, action: 'update', injury_id: INJURY.injury_id, returned_on: '2026-09-10' }));
    expect(res.status).toBe(200);
    expect(mockGetById).toHaveBeenCalledWith(ORG, INJURY.injury_id);
    expect(mockCoachAssigned.mock.calls).toEqual([['acct-coach-1', 'ATH-9', ORG]]);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        injuryId: INJURY.injury_id,
        updatedByAccountId: 'acct-coach-1',
        fields: expect.objectContaining({ returnedOn: '2026-09-10' }),
      }),
    );

    mockCoachAssigned.mockClear();
    res = await POST(postReq({ action: 'mark_entered_in_error', injury_id: INJURY.injury_id, athlete_id: 'ATH-1' }));
    expect(res.status).toBe(200);
    expect(mockCoachAssigned.mock.calls).toEqual([['acct-coach-1', 'ATH-9', ORG]]);
    expect(mockMark).toHaveBeenCalledWith({ organizationId: ORG, injuryId: INJURY.injury_id, updatedByAccountId: 'acct-coach-1' });
  });

  test('a missing injury is a 404 and nothing is written', async () => {
    mockGetById.mockResolvedValue(null);
    const res = await POST(postReq({ ...RECORD, action: 'update', injury_id: INJURY.injury_id }));
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a failure that is not a refusal surfaces, not a 404', async () => {
    mockCoachAssigned.mockRejectedValue(new Error('connection reset'));
    const res = await POST(postReq({ action: 'mark_entered_in_error', injury_id: INJURY.injury_id }));
    expect(res.status).toBe(500);
    expect(mockMark).not.toHaveBeenCalled();
  });

  test('accessible_athletes returns only the ids this principal may open, decided by accessibleAthleteIds', async () => {
    mockAccessible.mockResolvedValue(new Set(['ATH-1']));
    const res = await POST(postReq({ action: 'accessible_athletes', athlete_ids: ['ATH-1', 'ATH-2'] }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ ok: true, athlete_ids: ['ATH-1'] });
    expect(mockAccessible).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-coach-1', role: 'coach', organizationId: ORG }),
      ['ATH-1', 'ATH-2'],
    );
  });

  test('accessible_athletes refuses a malformed list', async () => {
    for (const athlete_ids of ['ATH-1', [1], Array.from({ length: 1001 }, (_, i) => `A${i}`)]) {
      expect((await POST(postReq({ action: 'accessible_athletes', athlete_ids }))).status).toBe(400);
    }
    expect(mockAccessible).not.toHaveBeenCalled();
  });

  test('missing athlete_id and unknown actions are 400', async () => {
    expect((await GET(new NextRequest('http://localhost/api/pilot/coach/injuries'))).status).toBe(400);
    expect((await POST(postReq({ action: 'delete', injury_id: INJURY.injury_id }))).status).toBe(400);
    expect((await POST(postReq({ ...RECORD, athlete_id: '' }))).status).toBe(400);
  });
});

describe.each(['organization_admin', 'admin'])('%s', (role) => {
  test('reaches any live athlete in the organization through the organization check', async () => {
    as(role);
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(mockBelongs).toHaveBeenCalledWith(ORG, 'ATH-1');
    expect(mockCoachAssigned).not.toHaveBeenCalled();
  });

  test("edits and marks through the organization check on the injury's own athlete", async () => {
    as(role);
    expect((await POST(postReq({ ...RECORD, action: 'update', injury_id: INJURY.injury_id }))).status).toBe(200);
    expect((await POST(postReq({ action: 'mark_entered_in_error', injury_id: INJURY.injury_id }))).status).toBe(200);
    expect(mockBelongs.mock.calls).toEqual([
      [ORG, 'ATH-9'],
      [ORG, 'ATH-9'],
    ]);
    expect(mockCoachAssigned).not.toHaveBeenCalled();
  });

  test("another organization's injury is the same 404 as a missing one", async () => {
    as(role);
    mockBelongs.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));
    const res = await POST(postReq({ action: 'mark_entered_in_error', injury_id: INJURY.injury_id }));
    expect(res.status).toBe(404);
    expect(mockMark).not.toHaveBeenCalled();
  });

  test('is refused an athlete outside the organization', async () => {
    as(role);
    mockBelongs.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));
    expect((await POST(postReq(RECORD))).status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
