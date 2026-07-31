import { NextRequest } from 'next/server';

import { GET, PATCH } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  getFilmStudyProposal,
  listFilmStudyProposals,
  resolveFilmStudyProposal,
} from '@/src/server/pilot/shadowFilmStudyProposals';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/shadowFilmStudyProposals', () => ({
  getFilmStudyProposal: jest.fn(),
  listFilmStudyProposals: jest.fn(),
  resolveFilmStudyProposal: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockAccess = jest.mocked(assertActorCanAccessAthlete);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockGet = jest.mocked(getFilmStudyProposal);
const mockList = jest.mocked(listFilmStudyProposals);
const mockResolve = jest.mocked(resolveFilmStudyProposal);

const PROPOSAL_ID = '9f1b0f6e-2b8a-4f22-9c4d-6a2f9b0c1d3e';

const pendingProposal = {
  proposal_id: PROPOSAL_ID,
  organization_id: 'org-1',
  athlete_id: 'ATH-1',
  video_session_id: 'vs-1',
  job_id: null,
  observation_text: 'Lead hand returns low after the jab.',
  evidence_id: 'film:vs-1',
  model_deployment: 'gpt-5-vision-shadow',
  frames_analyzed: 6,
  review_state: 'pending_review' as const,
  reviewed_by_account_id: null,
  reviewed_by_role: null,
  reviewed_at: null,
  review_notes: null,
  created_at: '2026-07-31T12:00:00.000Z',
  updated_at: '2026-07-31T12:00:00.000Z',
};

function req(method: 'GET' | 'PATCH', body?: Record<string, unknown>, search = ''): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/shadow/film-study/proposals${search}`, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal.mockResolvedValue({
    accountId: 'coach-1',
    organizationId: 'org-1',
    role: 'coach',
  } as never);
  mockAccess.mockResolvedValue(undefined as never);
  mockAudit.mockResolvedValue(undefined as never);
  mockGet.mockResolvedValue(pendingProposal as never);
  mockList.mockResolvedValue([pendingProposal] as never);
  mockResolve.mockResolvedValue({
    ...pendingProposal,
    review_state: 'accepted',
    reviewed_by_account_id: 'coach-1',
    reviewed_by_role: 'coach',
    reviewed_at: '2026-07-31T12:30:00.000Z',
  } as never);
});

describe('GET film study proposals', () => {
  test('returns the pending queue for a coach', async () => {
    const response = await GET(req('GET'));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.proposals).toHaveLength(1);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      state: 'pending',
    }));
  });

  test('narrowing to an athlete takes the per-athlete access check', async () => {
    await GET(req('GET', undefined, '?athlete_id=ATH-1'));
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ATH-1');
  });

  // Omega is broader in breadth but strictly NARROWER in depth
  // (shadowRoleSets.ts), and a per-athlete observation is depth.
  test('platform_owner is refused', async () => {
    mockPrincipal.mockResolvedValue({
      accountId: 'omega-1', organizationId: 'org-1', role: 'platform_owner',
    } as never);
    const response = await GET(req('GET'));
    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('an athlete cannot read the coach review queue', async () => {
    mockPrincipal.mockResolvedValue({
      accountId: 'ath-1', organizationId: 'org-1', role: 'athlete',
    } as never);
    const response = await GET(req('GET'));
    expect(response.status).toBe(403);
  });
});

describe('PATCH film study proposal verdict', () => {
  test('accepting settles the proposal and writes the attestation audit row', async () => {
    const response = await PATCH(req('PATCH', {
      proposal_id: PROPOSAL_ID,
      verdict: 'accepted',
      notes: 'Matches what I saw live.',
    }));

    expect(response.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({
      proposalId: PROPOSAL_ID,
      verdict: 'accepted',
      reviewerAccountId: 'coach-1',
      reviewerRole: 'coach',
    }));
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      entity_type: 'shadow_film_study_proposal',
      entity_id: PROPOSAL_ID,
      details: expect.objectContaining({ action: 'film_study_proposal_verdict', verdict: 'accepted' }),
    });
  });

  test('rejecting works exactly as well as accepting -- the queue always has an exit', async () => {
    mockResolve.mockResolvedValue({
      ...pendingProposal, review_state: 'rejected',
      reviewed_by_account_id: 'coach-1', reviewed_by_role: 'coach',
      reviewed_at: '2026-07-31T12:30:00.000Z',
    } as never);

    const response = await PATCH(req('PATCH', { proposal_id: PROPOSAL_ID, verdict: 'rejected' }));

    expect(response.status).toBe(200);
    expect((await response.json()).proposal.review_state).toBe('rejected');
  });

  test('access is checked against the proposal\'s real athlete, not caller input', async () => {
    await PATCH(req('PATCH', {
      proposal_id: PROPOSAL_ID,
      verdict: 'accepted',
      athlete_id: 'ATH-SOMEBODY-ELSE',
    }));
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ATH-1');
  });

  test('an already-settled proposal answers 409, not a hidden 404', async () => {
    mockGet.mockResolvedValue({ ...pendingProposal, review_state: 'accepted' } as never);
    mockResolve.mockResolvedValue(null as never);

    const response = await PATCH(req('PATCH', { proposal_id: PROPOSAL_ID, verdict: 'rejected' }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.review_state).toBe('accepted');
    expect(String(payload.error)).toMatch(/already/i);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an unknown verdict is refused before anything is written', async () => {
    const response = await PATCH(req('PATCH', { proposal_id: PROPOSAL_ID, verdict: 'maybe' }));
    expect(response.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('a malformed proposal id is refused', async () => {
    const response = await PATCH(req('PATCH', { proposal_id: 'not-a-uuid', verdict: 'accepted' }));
    expect(response.status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('a missing proposal is a 404', async () => {
    mockGet.mockResolvedValue(null as never);
    const response = await PATCH(req('PATCH', { proposal_id: PROPOSAL_ID, verdict: 'accepted' }));
    expect(response.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
