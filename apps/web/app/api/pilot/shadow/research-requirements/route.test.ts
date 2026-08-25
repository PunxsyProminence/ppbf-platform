import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import {
  createShadowResearchRequirement,
  listShadowResearchRequirements,
  type ShadowResearchRequirementRow,
} from '@/src/server/pilot/shadowResearch';
import { accessibleAthleteIds, assertActorCanAccessAthlete } from '@/src/server/pilot/access';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/guardianAccess', () => ({ guardianAthleteIds: jest.fn() }));
jest.mock('@/src/server/pilot/shadowResearch', () => ({
  createShadowResearchRequirement: jest.fn(),
  listShadowResearchRequirements: jest.fn(),
  resolveShadowResearchRequirement: jest.fn(),
}));

// requireRole stays real so the role sets are exercised; only the per-athlete
// check is mocked, because its real implementation reaches the database for
// coach and organization-admin actors.
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn(), accessibleAthleteIds: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockCreate = createShadowResearchRequirement as jest.MockedFunction<typeof createShadowResearchRequirement>;
const mockAssertAthlete = assertActorCanAccessAthlete as jest.MockedFunction<typeof assertActorCanAccessAthlete>;
const mockAccessibleAthleteIds = accessibleAthleteIds as jest.MockedFunction<typeof accessibleAthleteIds>;
const mockList = listShadowResearchRequirements as jest.MockedFunction<typeof listShadowResearchRequirements>;
const mockGuardianAthleteIds = guardianAthleteIds as jest.MockedFunction<typeof guardianAthleteIds>;

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/shadow/research-requirements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  source_event_name: 'manual_review',
  source_entity_type: 'manual',
  source_entity_id: 'entry-1',
  research_requirement: 'Confirm technique doctrine.',
  knowledge_gap: 'No authoritative source cited yet.',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockCreate.mockResolvedValue(101);
  mockAssertAthlete.mockResolvedValue(undefined);
});

describe('POST /api/pilot/shadow/research-requirements (create)', () => {
  test('rejects a non-string subject_id', async () => {
    const response = await POST(postRequest({ ...validBody, subject_id: 42 }));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('runs the per-athlete check when subject_id is supplied', async () => {
    await POST(postRequest({ ...validBody, subject_id: 'ath-9' }));

    expect(mockAssertAthlete).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-real' }),
      'ath-9',
    );
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 'ath-9' }));
  });

  test('skips the per-athlete check when no subject_id is supplied', async () => {
    await POST(postRequest(validBody));

    expect(mockAssertAthlete).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ subjectId: null }));
  });

  test('treats a blank subject_id as absent rather than as a subject', async () => {
    await POST(postRequest({ ...validBody, subject_id: '   ' }));

    expect(mockAssertAthlete).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ subjectId: null }));
  });

  test('refuses a caller not linked to the named athlete', async () => {
    mockAssertAthlete.mockRejectedValueOnce(new Error('Forbidden: parent not linked to athlete'));

    const response = await POST(postRequest({ ...validBody, subject_id: 'ath-not-theirs' }));

    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/pilot/shadow/research-requirements -- the athlete scope
// ---------------------------------------------------------------------------
//
// THE BUG. handleList applied an athlete scope for exactly ONE of the roles it
// admits. requireRole allows SHADOW_PROJECTION_READ_ROLES -- every seat in the
// organization (organization_admin, admin, coach, athlete, parent, volunteer,
// staff) plus platform_owner -- but only `principal.role === 'parent'` ever set
// `athleteScope`. For every other role `athleteScope` stayed undefined, so
// listShadowResearchRequirements evaluated `hasAthleteScope = false` and its
// WHERE collapsed to `organization_id = $1` alone: every row in the gym.
//
// The rows are not neutral. The three intake review writers in
// app/api/pilot/intake/review-action/route.ts file a requirement per
// approve/reject/promote decision carrying the athlete id and the reviewer's
// free-text `notes`, and shadowLibrary's claim-gap flow files the verbatim
// question a coach asked SHADOW about a named athlete. So:
//
//   * a coach read every child's intake-review note regardless of assignment
//     or coverage -- the same intake_case/intake_document family #623 refused
//     a coach org-wide in the audit reader, "left to the dedicated route whose
//     own gate adjudicates it". This IS that dedicated route.
//   * an athlete read every OTHER athlete's rows;
//   * volunteer and staff -- roles assertActorCanAccessAthlete refuses for any
//     athlete record at all -- read all of them;
//   * platform_owner, which assertActorCanAccessAthlete refuses outright and
//     which shadowRoleSets.ts documents must never reach an organization's
//     athlete depth, read them in every gym it can sign into.
//
// The POST on this same route already runs assertActorCanAccessAthlete before
// storing a subject_id, so the write was bounded while the read was not.
describe('GET /api/pilot/shadow/research-requirements athlete scope', () => {
  function requirement(overrides: Partial<ShadowResearchRequirementRow>): ShadowResearchRequirementRow {
    return {
      research_requirement_id: 1,
      organization_id: 'org-real',
      source_event_name: 'SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED',
      source_entity_type: 'shadow_library_capability_map',
      source_entity_id: 'capability.readiness',
      research_requirement: 'Strengthen coverage.',
      knowledge_gap: 'No verified source.',
      evidence_label: null,
      source_status: 'missing',
      source_confidence_tier: 'INSUFFICIENT',
      source_verification_state: 'unknown',
      status: 'open',
      created_by_account_id: 'acct-admin',
      created_by_role: 'organization_admin',
      metadata: {},
      created_at: '2026-08-25T00:00:00Z',
      resolved_at: null,
      subject_id: null,
      ...overrides,
    };
  }

  // Genuinely org-wide: a capability-coverage gap is about the gym's doctrine,
  // not about any child. Every role allowed on this route keeps reading it.
  const ORG_WIDE = requirement({ research_requirement_id: 10 });

  const MINE = requirement({
    research_requirement_id: 11,
    source_event_name: 'SHADOW_INTAKE_CASE_APPROVED',
    source_entity_type: 'intake_case',
    source_entity_id: 'case-mine',
    subject_id: 'ath-mine',
    metadata: { action: 'approve', notes: 'mine', athlete_id: 'ath-mine' },
  });

  // The current writer shape: subject_id populated.
  const INTAKE_OTHER = requirement({
    research_requirement_id: 12,
    source_event_name: 'SHADOW_INTAKE_CASE_REJECTED',
    source_entity_type: 'intake_case',
    source_entity_id: 'case-other',
    subject_id: 'ath-other',
    metadata: { action: 'reject', notes: 'REJECTED: guardian disclosed a prior head injury', athlete_id: 'ath-other' },
  });

  // The LEGACY writer shape, and the reason the scope cannot key on the column
  // alone: the subject_id migration's backfill reads metadata.subject_id,
  // evidence_label and source_entity_id -- never metadata.athlete_id -- so
  // every intake-review row written before that migration's application
  // companion still names its child only in metadata, with subject_id NULL.
  const LEGACY_INTAKE_OTHER = requirement({
    research_requirement_id: 13,
    source_event_name: 'SHADOW_INTAKE_CASE_PROMOTED',
    source_entity_type: 'intake_case',
    source_entity_id: 'case-legacy',
    subject_id: null,
    metadata: { action: 'promote', notes: 'PROMOTED: safeguarding note on file', athlete_id: 'ath-other' },
  });

  const ALL_ROWS = [ORG_WIDE, MINE, INTAKE_OTHER, LEGACY_INTAKE_OTHER];

  function getRequest() {
    return new NextRequest('http://localhost/api/pilot/shadow/research-requirements');
  }

  async function idsFrom(response: Response): Promise<number[]> {
    const body = (await response.json()) as { items: ShadowResearchRequirementRow[] };
    return body.items.map((item) => item.research_requirement_id);
  }

  beforeEach(() => {
    mockList.mockResolvedValue(ALL_ROWS);
  });

  test('a coach reads only the requirements of athletes they can reach', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAccessibleAthleteIds.mockResolvedValue(new Set(['ath-mine']));

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(await idsFrom(response)).toEqual([10, 11]);

    // The gate is consulted with every athlete the page names, including the
    // one named only in metadata.
    expect(mockAccessibleAthleteIds).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1', organizationId: 'org-real', role: 'coach' }),
      expect.arrayContaining(['ath-mine', 'ath-other']),
    );
  });

  test('an unrelated child intake-review note never reaches a coach, in either writer shape', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAccessibleAthleteIds.mockResolvedValue(new Set(['ath-mine']));

    const response = await GET(getRequest());
    const raw = JSON.stringify(await response.json());

    expect(raw).not.toContain('ath-other');
    expect(raw).not.toContain('prior head injury');
    expect(raw).not.toContain('safeguarding note on file');
    expect(raw).not.toContain('case-other');
    expect(raw).not.toContain('case-legacy');
  });

  // The coverage arm of the gate is the whole reason this is re-evaluated on
  // every read rather than resolved once: a substitute admitted by a
  // coach_coverage grant must stop reading the covered child the moment that
  // grant lapses or is cut short by revokeCoachCoverage. accessibleAthleteIds
  // is the only thing that decides it, and it compares against now() in SQL.
  test('a coach whose coverage grant has lapsed reads no covered athlete rows', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAccessibleAthleteIds.mockResolvedValue(new Set());

    const response = await GET(getRequest());

    expect(await idsFrom(response)).toEqual([10]);
  });

  test('an athlete cannot read another athlete requirements', async () => {
    mockRequirePrincipal.mockResolvedValue({ ...principal('athlete'), athleteId: 'ath-mine' });
    mockAccessibleAthleteIds.mockResolvedValue(new Set(['ath-mine']));

    const response = await GET(getRequest());

    expect(await idsFrom(response)).toEqual([10, 11]);
  });

  // assertActorCanAccessAthlete refuses volunteer and staff for every athlete
  // record, and accessibleAthleteIds mirrors that with an empty set. Neither
  // may read a row about a named child here either.
  test.each(['volunteer', 'staff'] as const)('a %s reads only rows that name no athlete', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockAccessibleAthleteIds.mockResolvedValue(new Set());

    const response = await GET(getRequest());

    expect(await idsFrom(response)).toEqual([10]);
  });

  // Omega is broader in BREADTH and strictly narrower in DEPTH
  // (shadowRoleSets.ts). It keeps the organization's doctrine gaps and gets no
  // athlete depth at all -- the same answer assertActorCanAccessAthlete gives
  // it unconditionally.
  test('platform_owner keeps organization doctrine rows and gets no athlete depth', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('platform_owner'));
    mockAccessibleAthleteIds.mockResolvedValue(new Set());

    const response = await GET(getRequest());

    expect(await idsFrom(response)).toEqual([10]);
  });

  // THE LEGITIMATE PATH, PART 1. An organization admin administers the whole
  // gym's records, so the organization predicate the query already carries IS
  // their reach. They are never post-filtered and never consult the
  // relationship gate.
  test('an organization admin still reads every requirement in the organization', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));

    const response = await GET(getRequest());

    expect(await idsFrom(response)).toEqual([10, 11, 12, 13]);
    expect(mockAccessibleAthleteIds).not.toHaveBeenCalled();
  });

  // THE LEGITIMATE PATH, PART 2. The parent branch's existing SQL scope is
  // untouched: it still resolves the guardian's own linked athletes and still
  // short-circuits to [] when there are none. This filter narrows; it never
  // widens a parent to the org-wide rows they could not see before.
  test('a parent still reads their own linked athlete requirements', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('parent'));
    mockGuardianAthleteIds.mockResolvedValue(['ath-mine']);
    mockAccessibleAthleteIds.mockResolvedValue(new Set(['ath-mine']));
    mockList.mockResolvedValue([MINE]);

    const response = await GET(getRequest());

    expect(mockList).toHaveBeenCalledWith('org-real', { athleteIds: ['ath-mine'] });
    expect(await idsFrom(response)).toEqual([11]);
  });

  test('a parent with no linked athletes reads nothing and never queries', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('parent'));
    mockGuardianAthleteIds.mockResolvedValue([]);

    const response = await GET(getRequest());

    expect(await idsFrom(response)).toEqual([]);
    expect(mockList).not.toHaveBeenCalled();
  });
});
