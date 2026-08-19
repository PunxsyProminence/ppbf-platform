import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  createResearchSubmission,
  listResearchSubmissions,
  computeAnswerState,
} from '@/src/server/pilot/shadowResearchSubmissions';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowResearchSubmissions', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowResearchSubmissions');
  return {
    ...actual,
    createResearchSubmission: jest.fn(),
    listResearchSubmissions: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockReadiness = assertShadowRuntimeReadiness as jest.MockedFunction<typeof assertShadowRuntimeReadiness>;
const mockCreate = createResearchSubmission as jest.MockedFunction<typeof createResearchSubmission>;
const mockList = listResearchSubmissions as jest.MockedFunction<typeof listResearchSubmissions>;

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: role === 'athlete' ? 'ath-1' : null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/shadow/research-submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(search = '') {
  return new NextRequest(`http://localhost/api/pilot/shadow/research-submissions${search}`, { method: 'GET' });
}

const validSubmission = {
  research_requirement_id: 1,
  source_id: 'src-abc',
  doi: '10.1000/xyz123',
  provider_provenance: 'Penn State Library',
  why_this_source: 'Directly addresses the knowledge gap',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockReadiness.mockResolvedValue(undefined as never);
  mockCreate.mockResolvedValue({
    submission_id: 'sub-1',
    organization_id: 'org-1',
    research_requirement_id: 1,
    source_id: 'src-abc',
    submitted_by_account_id: 'acct-1',
    submitted_by_role: 'organization_admin',
    doi: '10.1000/xyz123',
    pmid: null,
    provider_provenance: 'Penn State Library',
    why_this_source: 'Directly addresses the knowledge gap',
    review_verdict: null,
    reviewed_by_account_id: null,
    reviewed_at: null,
    metadata: {},
    created_at: '2026-08-19T00:00:00Z',
  });
  mockList.mockResolvedValue([]);
});

describe('POST /api/pilot/shadow/research-submissions', () => {
  it('creates a submission for an authorized curator', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    const res = await POST(postRequest(validSubmission));
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; submission: { submission_id: string } };
    expect(body.ok).toBe(true);
    expect(body.submission.submission_id).toBe('sub-1');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        researchRequirementId: 1,
        sourceId: 'src-abc',
      }),
    );
  });

  it('rejects when source_id is missing', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    const res = await POST(postRequest({ research_requirement_id: 1 }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.error).toMatch(/source_id/);
  });

  it('rejects when research_requirement_id is missing', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    const res = await POST(postRequest({ source_id: 'src-abc' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.error).toMatch(/research_requirement_id/);
  });

  it('rejects an invalid domain_classification', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    const res = await POST(postRequest({ ...validSubmission, domain_classification: 'made_up' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.error).toMatch(/domain_classification/);
  });

  it('accepts a valid domain_classification', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    const res = await POST(postRequest({ ...validSubmission, domain_classification: 'boxing_athlete_development' }));
    expect(res.status).toBe(201);
  });

  it('returns 403 for a non-curator role (athlete)', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('athlete'));
    const res = await POST(postRequest(validSubmission));
    expect(res.status).toBe(403);
  });
});

describe('GET /api/pilot/shadow/research-submissions', () => {
  it('lists submissions for an authorized curator', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; items: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('filters by research_requirement_id when provided', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    await GET(getRequest('?research_requirement_id=42'));
    expect(mockList).toHaveBeenCalledWith('org-1', { researchRequirementId: 42 });
  });

  it('rejects an invalid research_requirement_id', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    const res = await GET(getRequest('?research_requirement_id=abc'));
    expect(res.status).toBe(400);
  });
});

describe('computeAnswerState', () => {
  const open = { status: 'open' as const };
  const resolved = { status: 'resolved' as const };

  it('returns resolved when requirement is resolved regardless of submissions', () => {
    expect(computeAnswerState(resolved, [{ review_verdict: null }])).toBe('resolved');
  });

  it('returns needs_evidence when no submissions exist', () => {
    expect(computeAnswerState(open, [])).toBe('needs_evidence');
  });

  it('returns sources_submitted when all submissions are pending review', () => {
    expect(computeAnswerState(open, [{ review_verdict: null }, { review_verdict: null }])).toBe('sources_submitted');
  });

  it('returns evidence_under_review when mix of reviewed and pending', () => {
    expect(computeAnswerState(open, [{ review_verdict: 'irrelevant' }, { review_verdict: null }])).toBe('evidence_under_review');
  });

  it('returns partially_answered when at least one relevant verdict exists', () => {
    expect(computeAnswerState(open, [{ review_verdict: 'relevant' }, { review_verdict: null }])).toBe('partially_answered');
  });

  it('returns partially_answered for partial verdict', () => {
    expect(computeAnswerState(open, [{ review_verdict: 'partial' }])).toBe('partially_answered');
  });

  // The structural non-reach guarantee from the issue spec: a resolved state
  // is unreachable for an open requirement regardless of how many submissions
  // or what verdicts they carry.
  it.each([
    [[]],
    [[{ review_verdict: null }]],
    [[{ review_verdict: 'relevant' }]],
    [[{ review_verdict: 'relevant' }, { review_verdict: 'partial' }]],
  ] as Array<[Array<{ review_verdict: string | null }>]>)(
    'never returns resolved for an open requirement (%#)',
    (submissions) => {
      expect(computeAnswerState(open, submissions)).not.toBe('resolved');
    },
  );
});
