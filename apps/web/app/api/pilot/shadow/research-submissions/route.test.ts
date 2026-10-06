import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { accessibleAthleteIds } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getShadowResearchRequirementById } from '@/src/server/pilot/shadowResearch';
import {
  createResearchSubmission,
  getAnswerStates,
  getRequirementStatusesInOrg,
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

// The subject gate's two collaborators. accessibleAthleteIds is the ONE
// central relationship gate; mocking it here keeps these tests about the
// route's use of it rather than about guardian_links SQL, which
// softDeletedAthleteAccess.pg.test.ts already covers against real Postgres.
jest.mock('@/src/server/pilot/shadowResearch', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowResearch');
  return { ...actual, getShadowResearchRequirementById: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, accessibleAthleteIds: jest.fn(async () => new Set<string>()) };
});

jest.mock('@/src/server/pilot/shadowResearchSubmissions', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowResearchSubmissions');
  return {
    ...actual,
    createResearchSubmission: jest.fn(),
    listSubmissionsForRequirement: jest.fn(),
    reviewResearchSubmission: jest.fn(),
    getRequirementStatusInOrg: jest.fn(),
    getRequirementStatusesInOrg: jest.fn(),
    getAnswerStates: jest.fn(),
    sourceExistsInOrg: jest.fn(),
    documentExistsInOrg: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetRequirement = getShadowResearchRequirementById as jest.Mock;
const mockAccessibleAthleteIds = accessibleAthleteIds as jest.Mock;
const mockCreate = createResearchSubmission as jest.Mock;
const mockList = listSubmissionsForRequirement as jest.Mock;
const mockReview = reviewResearchSubmission as jest.Mock;
const mockRequirementStatus = getRequirementStatusInOrg as jest.Mock;
const mockSourceExists = sourceExistsInOrg as jest.Mock;
const mockDocumentExists = documentExistsInOrg as jest.Mock;

beforeEach(() => {
  /* Default: a requirement that names NO child, which is the org-wide
     operational case and the shape every pre-existing test in this file was
     written against. Tests about the subject gate override it. Without a
     default the gate would 404 them all, which would look like the gate
     working and would actually be the fixture missing. */
  mockGetRequirement.mockResolvedValue({
    research_requirement_id: 7, organization_id: 'org-1', subject_id: null, metadata: {},
  });
});

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

// OD-2026-10-02-013 answer 1B and OD-2026-10-02-015 D3, through
// libraryShelf.ts: filing a source against a requirement and reviewing that
// link are Library writes, so the platform owner does them on the platform
// shelf and no longer on a gym's. Reads (GET) are unchanged.
describe('the shelf (OD-2026-10-02-015 D3)', () => {
  const owner = () => principal({ role: 'platform_owner' });

  test('platform_owner is refused a gym-shelf submission before any existence check', async () => {
    for (const body of [
      { research_requirement_id: 7, source_id: 'src-1' },
      { research_requirement_id: 7, source_id: 'src-1', shelf: 'gym' },
    ]) {
      mockRequirePrincipal.mockResolvedValueOnce(owner());
      expect((await POST(postRequest(body))).status).toBe(403);
    }
    expect(mockRequirementStatus).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('platform_owner is refused a gym-shelf review', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(owner());

    const response = await PATCH(patchRequest({ submission_id: 's-1', applicability_state: 'responsive' }));

    expect(response.status).toBe(403);
    expect(mockReview).not.toHaveBeenCalled();
  });

  test('platform_owner files and reviews on the platform shelf, and every existence check reads that shelf', async () => {
    mockRequirePrincipal.mockResolvedValue(owner());
    mockRequirementStatus.mockResolvedValue('open');
    mockSourceExists.mockResolvedValue(true);
    mockDocumentExists.mockResolvedValue(true);
    mockCreate.mockResolvedValue({ submission_id: 's-p' });
    mockReview.mockResolvedValue({ submission_id: 's-p', applicability_state: 'responsive' });

    const post = await POST(postRequest({
      research_requirement_id: 7, source_id: 'src-p', document_id: 'doc-p', shelf: 'platform', organization_id: 'org-attacker',
    }));
    expect(post.status).toBe(200);
    expect(mockRequirementStatus).toHaveBeenCalledWith('__platform__', 7);
    expect(mockSourceExists).toHaveBeenCalledWith('__platform__', 'src-p');
    expect(mockDocumentExists).toHaveBeenCalledWith('__platform__', 'doc-p');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '__platform__' }));

    const patch = await PATCH(patchRequest({ submission_id: 's-p', applicability_state: 'responsive', shelf: 'platform' }));
    expect(patch.status).toBe(200);
    expect(mockReview).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '__platform__' }));
  });

  test.each(['organization_admin', 'admin'] as const)('%s gets 403 for shelf: platform on both writes', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));

    expect((await POST(postRequest({ research_requirement_id: 7, source_id: 'src-1', shelf: 'platform' }))).status).toBe(403);
    expect((await PATCH(patchRequest({ submission_id: 's-1', applicability_state: 'responsive', shelf: 'platform' }))).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockReview).not.toHaveBeenCalled();
  });

  test('a gym admin naming no shelf still files under its own organization', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockRequirementStatus.mockResolvedValue('open');
    mockSourceExists.mockResolvedValue(true);
    mockCreate.mockResolvedValue({ submission_id: 's-1' });

    await POST(postRequest({ research_requirement_id: 7, source_id: 'src-1' }));

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
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

// The blank-string trap the review caught: '' is falsy for the tenancy check
// but survives `?? null` into an FK insert. Normalization must catch it.
test('a blank document_id means no document, not an empty-string FK value', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockRequirementStatus.mockResolvedValue('open');
  mockSourceExists.mockResolvedValue(true);
  mockCreate.mockResolvedValue({ submission_id: 's-1' });

  await POST(postRequest({ research_requirement_id: 7, source_id: '  src-1  ', document_id: '   ' }));

  expect(mockDocumentExists).not.toHaveBeenCalled();
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    sourceId: 'src-1',
    documentId: null,
  }));
});

// Batch mode: the workspace list asks for every requirement's ladder in one
// request. Ids outside the organization are silently absent -- the same
// hidden-not-found doctrine as the single read, in map form.
describe('GET batch answer states', () => {
  test('returns a state per in-org id and omits the rest', async () => {
    const { getRequirementStatusesInOrg, getAnswerStates } = jest.requireMock('@/src/server/pilot/shadowResearchSubmissions');
    mockRequirePrincipal.mockResolvedValue(principal({}));
    (getRequirementStatusesInOrg as jest.Mock).mockResolvedValue([
      { research_requirement_id: 7, status: 'open' },
    ]);
    (getAnswerStates as jest.Mock).mockResolvedValue(new Map([[7, 'needs_evidence']]));

    const payload = await (await GET(getRequest('research_requirement_ids=7,999'))).json();

    expect(getRequirementStatusesInOrg).toHaveBeenCalledWith('org-1', [7, 999]);
    expect(payload.answer_states).toEqual({ '7': 'needs_evidence' });
  });

  test('a malformed id list is a 400, not a query', async () => {
    const { getRequirementStatusesInOrg } = jest.requireMock('@/src/server/pilot/shadowResearchSubmissions');
    mockRequirePrincipal.mockResolvedValue(principal({}));

    expect((await GET(getRequest('research_requirement_ids=7,soon'))).status).toBeGreaterThanOrEqual(400);
    expect(getRequirementStatusesInOrg).not.toHaveBeenCalled();
  });
});

/* ── THE SUBJECT GATE ─────────────────────────────────────────────────────
   A requirement can NAME a child, and the submissions hanging off it carry
   submission_note and review_note -- a reviewer's free text about that
   child's intake case. This route scoped on organization_id alone, while its
   sibling (research-requirements) has scoped reads to reachable subjects
   since #623. A guardian could name any research_requirement_id and read
   another family's staff notes. */
describe('the subject gate on a requirement that names a child', () => {
  const guardian = () => principal({ accountId: 'acct-parent', role: 'parent', athleteId: null });

  function requirementAbout(athleteId: string | null) {
    return { research_requirement_id: 7, organization_id: 'org-1', subject_id: athleteId, metadata: {} };
  }

  test('a guardian is refused a requirement about a child they do not hold', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(guardian());
    mockGetRequirement.mockResolvedValueOnce(requirementAbout('ath-other'));
    mockAccessibleAthleteIds.mockResolvedValueOnce(new Set<string>());

    const response = await GET(getRequest('research_requirement_id=7'));

    expect(response.status).toBe(404);
    // The staff notes are never read, not merely never returned.
    expect(mockList).not.toHaveBeenCalled();
    expect(mockRequirementStatus).not.toHaveBeenCalled();
  });

  test('a guardian reads a requirement about their own child', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(guardian());
    mockGetRequirement.mockResolvedValueOnce(requirementAbout('ath-mine'));
    mockAccessibleAthleteIds.mockResolvedValueOnce(new Set(['ath-mine']));
    mockRequirementStatus.mockResolvedValueOnce('open');
    mockList.mockResolvedValueOnce([]);

    const response = await GET(getRequest('research_requirement_id=7'));

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalled();
  });

  // CL-A3 (Jason 2026-10-06, "Staff only"): a requirement about nobody is the
  // gym's research backlog, often a member's own question. Its submissions and
  // review notes are for staff and for whoever filed it.
  test('a guardian reads the submissions on a question they filed about nobody', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(guardian());
    mockGetRequirement.mockResolvedValueOnce({ ...requirementAbout(null), created_by_account_id: 'acct-parent' });
    mockRequirementStatus.mockResolvedValueOnce('open');
    mockList.mockResolvedValueOnce([]);

    const response = await GET(getRequest('research_requirement_id=7'));

    expect(response.status).toBe(200);
    expect(mockAccessibleAthleteIds).not.toHaveBeenCalled();
  });

  test.each([
    ['parent', 'acct-parent'],
    ['athlete', 'acct-athlete'],
    ['volunteer', 'acct-vol'],
    ['staff', 'acct-staff'],
    ['platform_owner', 'acct-owner'],
  ] as const)('a %s is refused the submissions on someone else\'s question about nobody', async (role, accountId) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId, role, athleteId: null }));
    mockGetRequirement.mockResolvedValueOnce({ ...requirementAbout(null), created_by_account_id: 'acct-other-family' });

    const response = await GET(getRequest('research_requirement_id=7'));

    expect(response.status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockRequirementStatus).not.toHaveBeenCalled();
  });

  test('a coach reads the submissions on anyone\'s question about nobody', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockGetRequirement.mockResolvedValueOnce({ ...requirementAbout(null), created_by_account_id: 'acct-other-family' });
    mockRequirementStatus.mockResolvedValueOnce('open');
    mockList.mockResolvedValueOnce([]);

    expect((await GET(getRequest('research_requirement_id=7'))).status).toBe(200);
  });

  // The platform shelf is the platform owner's own Library; it stays readable
  // there whoever filed the row.
  test('platform_owner reads the submissions on a platform-shelf question about nobody', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'acct-owner', role: 'platform_owner' }));
    mockGetRequirement.mockResolvedValueOnce({
      ...requirementAbout(null), organization_id: '__platform__', created_by_account_id: 'acct-someone',
    });
    mockRequirementStatus.mockResolvedValueOnce('open');
    mockList.mockResolvedValueOnce([]);

    const response = await GET(getRequest('research_requirement_id=7&shelf=platform'));

    expect(response.status).toBe(200);
    expect(mockGetRequirement).toHaveBeenCalledWith('__platform__', 7);
  });

  test('the batch read drops other people\'s questions about nobody for a non-staff caller', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'acct-athlete', role: 'athlete', athleteId: 'ath-1' }));
    mockGetRequirement
      .mockResolvedValueOnce({ ...requirementAbout(null), research_requirement_id: 7, created_by_account_id: 'acct-athlete' })
      .mockResolvedValueOnce({ ...requirementAbout(null), research_requirement_id: 8, created_by_account_id: 'acct-other' });
    (getRequirementStatusesInOrg as jest.Mock).mockResolvedValueOnce(new Map());
    (getAnswerStates as jest.Mock).mockResolvedValueOnce(new Map());

    await GET(getRequest('research_requirement_ids=7,8'));

    expect(getRequirementStatusesInOrg as jest.Mock).toHaveBeenCalledWith('org-1', [7]);
  });

  test('an organization admin is not narrowed, and costs no extra read', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockRequirementStatus.mockResolvedValueOnce('open');
    mockList.mockResolvedValueOnce([]);

    const response = await GET(getRequest('research_requirement_id=7'));

    expect(response.status).toBe(200);
    expect(mockGetRequirement).not.toHaveBeenCalled();
  });

  /* THE ENUMERATION ORACLE. The batch parameter takes 200 ids per request, so
     leaking mere existence here is worth more to a caller than the single-id
     read. Unreachable ids must be absent from the answer, not reported. */
  test('the batch read drops ids whose subject the guardian cannot reach', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(guardian());
    mockGetRequirement
      .mockResolvedValueOnce(requirementAbout('ath-mine'))
      .mockResolvedValueOnce(requirementAbout('ath-other'));
    mockAccessibleAthleteIds
      .mockResolvedValueOnce(new Set(['ath-mine']))
      .mockResolvedValueOnce(new Set<string>());
    (getRequirementStatusesInOrg as jest.Mock).mockResolvedValueOnce(new Map());
    (getAnswerStates as jest.Mock).mockResolvedValueOnce(new Map());

    await GET(getRequest('research_requirement_ids=7,8'));

    // Only the reachable id reaches the status read.
    expect(getRequirementStatusesInOrg as jest.Mock).toHaveBeenCalledWith('org-1', [7]);
  });
});
