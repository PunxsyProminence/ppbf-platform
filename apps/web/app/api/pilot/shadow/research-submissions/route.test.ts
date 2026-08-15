import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createResearchSubmission,
  documentExistsInOrg,
  getRequirementStatusInOrg,
  listSubmissionsForRequirement,
  reviewResearchSubmission,
  sourceExistsInOrg,
} from '@/src/server/pilot/shadowResearchSubmissions';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowResearchSubmissions', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowResearchSubmissions');
  return {
    ...actual,
    createResearchSubmission: jest.fn(),
    listSubmissionsForRequirement: jest.fn(),
    reviewResearchSubmission: jest.fn(),
    getRequirementStatusInOrg: jest.fn(),
    sourceExistsInOrg: jest.fn(),
    documentExistsInOrg: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCreate = createResearchSubmission as jest.Mock;
const mockList = listSubmissionsForRequirement as jest.Mock;
const mockReview = reviewResearchSubmission as jest.Mock;
const mockRequirementStatus = getRequirementStatusInOrg as jest.Mock;
const mockSourceExists = sourceExistsInOrg as jest.Mock;
const mockDocumentExists = documentExistsInOrg as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query: string) =>
  new NextRequest(`http://localhost/api/pilot/shadow/research-submissions?${query}`);

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/shadow/research-submissions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const patchRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/shadow/research-submissions', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('roles', () => {
  test('a coach may read but not submit or review — curation is the library-write authority', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
    mockRequirementStatus.mockResolvedValue('open');
    mockList.mockResolvedValue([]);

    expect((await GET(getRequest('research_requirement_id=7'))).status).toBe(200);
    expect((await POST(postRequest({ research_requirement_id: 7, source_id: 'src-1' }))).status).toBeGreaterThanOrEqual(400);
    expect((await PATCH(patchRequest({ submission_id: 's-1', applicability_state: 'responsive' }))).status).toBeGreaterThanOrEqual(400);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockReview).not.toHaveBeenCalled();
  });
});

describe('GET answer state', () => {
  test('returns submissions plus the computed ladder for the requirement', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockRequirementStatus.mockResolvedValue('open');
    mockList.mockResolvedValue([{ applicability_state: 'unreviewed' }]);

    const payload = await (await GET(getRequest('research_requirement_id=7'))).json();

    expect(mockRequirementStatus).toHaveBeenCalledWith('org-1', 7);
    expect(payload.answer_state).toBe('sources_submitted');
  });

  test('a requirement outside the organization is a hidden not-found', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockRequirementStatus.mockResolvedValue(null);

    expect((await GET(getRequest('research_requirement_id=7'))).status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST org isolation', () => {
  beforeEach(() => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
  });

  test('a source from another organization is a hidden not-found, not a link', async () => {
    mockRequirementStatus.mockResolvedValue('open');
    mockSourceExists.mockResolvedValue(false);

    const response = await POST(postRequest({ research_requirement_id: 7, source_id: 'src-other-org' }));

    expect(response.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a valid link is filed under the submitter', async () => {
    mockRequirementStatus.mockResolvedValue('open');
    mockSourceExists.mockResolvedValue(true);
    mockDocumentExists.mockResolvedValue(true);
    mockCreate.mockResolvedValue({ submission_id: 's-1' });

    await POST(postRequest({
      research_requirement_id: 7,
      source_id: 'src-1',
      document_id: 'doc-1',
      provenance: { doi: '10.1000/x' },
    }));

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      researchRequirementId: 7,
      sourceId: 'src-1',
      documentId: 'doc-1',
      submittedByAccountId: 'acct-1',
    }));
  });

  test('a duplicate link answers 409 with the corroboration rule stated', async () => {
    mockRequirementStatus.mockResolvedValue('open');
    mockSourceExists.mockResolvedValue(true);
    mockCreate.mockRejectedValue(new Error('RESEARCH_SUBMISSION_DUPLICATE_LINK: already linked'));

    const response = await POST(postRequest({ research_requirement_id: 7, source_id: 'src-1' }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toMatch(/not corroboration/i);
  });
});

describe('PATCH review', () => {
  beforeEach(() => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
  });

  test("'unreviewed' is not a verdict a reviewer can hand down", async () => {
    const response = await PATCH(patchRequest({ submission_id: 's-1', applicability_state: 'unreviewed' }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockReview).not.toHaveBeenCalled();
  });

  test('a verdict is attributed to the caller', async () => {
    mockReview.mockResolvedValue({ submission_id: 's-1' });

    await PATCH(patchRequest({ submission_id: 's-1', applicability_state: 'not_responsive' }));

    expect(mockReview).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      submissionId: 's-1',
      applicabilityState: 'not_responsive',
      reviewedByAccountId: 'acct-1',
    }));
  });
});
