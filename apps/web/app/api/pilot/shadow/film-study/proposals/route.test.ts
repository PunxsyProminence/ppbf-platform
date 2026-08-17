import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  createCoachReportedObservation,
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
  createCoachReportedObservation: jest.fn(),
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
const mockCreateCoachReport = jest.mocked(createCoachReportedObservation);

const PROPOSAL_ID = '9f1b0f6e-2b8a-4f22-9c4d-6a2f9b0c1d3e';
const COACH_REPORT_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const pendingProposal = {
  proposal_id: PROPOSAL_ID,
  organization_id: 'org-1',
  athlete_id: 'ATH-1',
  video_session_id: 'vs-1',
  job_id: null,
  origin: 'model_proposed' as const,
  observation_text: 'Lead hand returns low after the jab.',
  evidence_id: 'film:vs-1',
  model_deployment: 'gpt-5-vision-shadow',
  frames_analyzed: 6,
  reported_by_account_id: null,
  review_state: 'pending_review' as const,
  corrected_observation_text: null,
  reviewed_by_account_id: null,
  reviewed_by_role: null,
  reviewed_at: null,
  review_notes: null,
  created_at: '2026-07-31T12:00:00.000Z',
  updated_at: '2026-07-31T12:00:00.000Z',
};

// A coach-entered missed detection: no inference run to describe, so the model
// provenance columns are null and the coach is named instead.
const coachReported = {
  ...pendingProposal,
  proposal_id: COACH_REPORT_ID,
  origin: 'coach_reported' as const,
  observation_text: 'Model missed the head staying still on the slip.',
  model_deployment: null,
  frames_analyzed: null,
  reported_by_account_id: 'coach-1',
};

function req(
  method: 'GET' | 'PATCH' | 'POST',
  body?: Record<string, unknown>,
  search = '',
): NextRequest {
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
  mockCreateCoachReport.mockResolvedValue(coachReported as never);
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

  test('correcting is a third exit, and carries the replacement wording', async () => {
    // Before this, a coach who was nearly in agreement had only rejection,
    // which discarded what they knew.
    mockResolve.mockResolvedValue({
      ...pendingProposal,
      review_state: 'corrected',
      corrected_observation_text: 'Lead hand drops in round three only.',
      reviewed_by_account_id: 'coach-1',
      reviewed_by_role: 'coach',
      reviewed_at: '2026-07-31T12:30:00.000Z',
    } as never);

    const response = await PATCH(req('PATCH', {
      proposal_id: PROPOSAL_ID,
      verdict: 'corrected',
      corrected_observation_text: 'Lead hand drops in round three only.',
    }));

    expect(response.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: 'corrected',
        correctedObservationText: 'Lead hand drops in round three only.',
      }),
    );
    // The audit row shows a correction happened without reproducing an
    // observation about a minor into the audit log.
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ verdict: 'corrected', corrected: true }),
      }),
    );
  });
});

describe('POST a coach-reported missed detection', () => {
  test('a coach records what the model never proposed', async () => {
    const response = await POST(req('POST', {
      athlete_id: 'ATH-1',
      video_session_id: 'vs-1',
      observation_text: 'Model missed the head staying still on the slip.',
    }));

    expect(response.status).toBe(201);
    expect(mockCreateCoachReport).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        athleteId: 'ATH-1',
        videoSessionId: 'vs-1',
        reportedByAccountId: 'coach-1',
      }),
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: true, proposal: expect.objectContaining({ origin: 'coach_reported' }) }),
    );
  });

  test('writing an observation about an athlete takes the per-athlete access check', async () => {
    await POST(req('POST', {
      athlete_id: 'ATH-1',
      video_session_id: 'vs-1',
      observation_text: 'Something the model missed.',
    }));
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ATH-1');
  });

  test('access is checked BEFORE anything is written', async () => {
    mockAccess.mockRejectedValue(new Error('Forbidden: athlete') as never);
    const response = await POST(req('POST', {
      athlete_id: 'ATH-OTHER',
      video_session_id: 'vs-1',
      observation_text: 'Not mine to write about.',
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockCreateCoachReport).not.toHaveBeenCalled();
  });

  test('an athlete cannot enter observations about themselves', async () => {
    mockPrincipal.mockResolvedValue({
      accountId: 'ath-1',
      organizationId: 'org-1',
      role: 'athlete',
    } as never);
    const response = await POST(req('POST', {
      athlete_id: 'ATH-1',
      video_session_id: 'vs-1',
      observation_text: 'Self-reported.',
    }));
    expect(response.status).toBe(403);
    expect(mockCreateCoachReport).not.toHaveBeenCalled();
  });

  test('platform_owner is refused, same as everywhere else in this queue', async () => {
    mockPrincipal.mockResolvedValue({
      accountId: 'owner-1',
      organizationId: 'org-1',
      role: 'platform_owner',
    } as never);
    const response = await POST(req('POST', {
      athlete_id: 'ATH-1',
      video_session_id: 'vs-1',
      observation_text: 'Depth is not breadth.',
    }));
    expect(response.status).toBe(403);
    expect(mockCreateCoachReport).not.toHaveBeenCalled();
  });

  test.each([
    ['athlete_id', { video_session_id: 'vs-1', observation_text: 'x' }],
    ['video_session_id', { athlete_id: 'ATH-1', observation_text: 'x' }],
    ['observation_text', { athlete_id: 'ATH-1', video_session_id: 'vs-1' }],
  ])('a missing %s is refused before anything is written', async (_field, body) => {
    const response = await POST(req('POST', body));
    expect(response.status).toBe(400);
    expect(mockCreateCoachReport).not.toHaveBeenCalled();
  });

  test('a blank observation is refused', async () => {
    const response = await POST(req('POST', {
      athlete_id: 'ATH-1',
      video_session_id: 'vs-1',
      observation_text: '    ',
    }));
    expect(response.status).toBe(400);
    expect(mockCreateCoachReport).not.toHaveBeenCalled();
  });
});
