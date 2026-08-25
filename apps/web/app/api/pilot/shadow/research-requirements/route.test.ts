import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import {
  createShadowResearchRequirement,
  getShadowResearchRequirementById,
  listShadowResearchRequirements,
  resolveShadowResearchRequirement,
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
  getShadowResearchRequirementById: jest.fn(),
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
const mockGetById = getShadowResearchRequirementById as jest.MockedFunction<typeof getShadowResearchRequirementById>;
const mockResolve = resolveShadowResearchRequirement as jest.MockedFunction<typeof resolveShadowResearchRequirement>;

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


// ---------------------------------------------------------------------------
// POST { action: 'resolve' } -- the athlete scope on the WRITE
// ---------------------------------------------------------------------------
//
// THE BUG. The resolve branch set an athlete scope for exactly ONE of the
// roles it admits:
//
//     let athleteScope: string[] | undefined;
//     if (principal.role === 'parent') { athleteScope = ...; }
//     await resolveShadowResearchRequirement({ ..., athleteIds: athleteScope });
//
// For every other admitted role -- coach, athlete, volunteer, staff,
// organization_admin -- athleteScope stayed undefined, resolveShadowResearch-
// Requirement computed hasAthleteScope = false, and its UPDATE's athlete
// predicate (`$4::boolean = false or subject_id = any($5)`) short-circuited to
// true. What was left bounding the write was organization + id + status.
//
// research_requirement_id is `bigserial primary key`. It is not a token that
// has to leak before it can be used -- it is reached by counting. So a coach
// with no assignment at all, an athlete, a volunteer or a staff account could
// POST a guessed number and mark ANY child's requirement resolved.
//
// The rows this reaches are intake-derived. The three writers in
// app/api/pilot/intake/review-action/route.ts file one per approve/reject/
// promote decision, carrying the child's id and the reviewer's free-text
// notes, and shadowLibrary's claim-gap path files one per unsupported claim
// about a named athlete. Resolving one says a safeguarding-adjacent follow-up
// about a child was handled. That is an INTEGRITY defect, not a disclosure
// one: the attacker does not need to read anything, and the read fix (#652)
// does not touch it, because this path never reads.
//
// The fix is the house shape (#624, #630, #648): resolve the STORED record's
// owner, authorize THAT owner, and carry the authorized owner into the
// write's WHERE so authorize-and-write is one statement.
describe('POST /api/pilot/shadow/research-requirements (resolve) athlete scope', () => {
  function stored(overrides: Partial<ShadowResearchRequirementRow> = {}): ShadowResearchRequirementRow {
    return {
      research_requirement_id: 4171,
      organization_id: 'org-real',
      source_event_name: 'SHADOW_INTAKE_CASE_REJECTED',
      source_entity_type: 'intake_case',
      source_entity_id: 'case-other',
      research_requirement: 'Confirm the guardian disclosure against policy.',
      knowledge_gap: 'Reviewer note not yet corroborated.',
      evidence_label: null,
      source_status: 'observed',
      source_confidence_tier: 'LIMITED',
      source_verification_state: 'unknown',
      status: 'open',
      created_by_account_id: 'acct-admin',
      created_by_role: 'organization_admin',
      metadata: { action: 'reject', notes: 'REJECTED: prior head injury disclosed', athlete_id: 'ath-other' },
      created_at: '2026-08-25T00:00:00Z',
      resolved_at: null,
      subject_id: 'ath-other',
      ...overrides,
    };
  }

  // The legacy writer shape, and the reason the owner resolution cannot key on
  // the subject_id column alone. The subject_id migration's backfill reads
  // metadata.subject_id, evidence_label and source_entity_id -- never
  // metadata.athlete_id -- so every intake-review row written before its
  // application companion still names its child ONLY in metadata, with the
  // column NULL. Those are exactly the rows carrying a reviewer's free-text
  // note on a child's intake case.
  function storedLegacy(): ShadowResearchRequirementRow {
    return stored({
      research_requirement_id: 4172,
      source_event_name: 'SHADOW_INTAKE_CASE_PROMOTED',
      source_entity_id: 'case-legacy',
      subject_id: null,
      metadata: { action: 'promote', notes: 'PROMOTED: safeguarding note on file', athlete_id: 'ath-other' },
    });
  }

  // A capability-coverage gap is about the gym's doctrine, not about a child.
  function storedOrgWide(): ShadowResearchRequirementRow {
    return stored({
      research_requirement_id: 10,
      source_event_name: 'SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED',
      source_entity_type: 'shadow_library_capability_map',
      source_entity_id: 'capability.readiness',
      subject_id: null,
      metadata: {},
    });
  }

  const REFUSED = new Error('Forbidden: coach not assigned to athlete');

  beforeEach(() => {
    mockGetById.mockResolvedValue(stored());
    mockResolve.mockResolvedValue(true);
  });

  // THE ATTACK. Each of these roles is admitted by ORGANIZATION_MEMBER_ROLES
  // and holds nothing whatsoever about ath-other: no assignment, no coverage
  // grant, no guardian link, not that athlete's own account. Each POSTs a
  // requirement id it enumerated. Each must be refused, and nothing may be
  // written.
  test.each(['coach', 'athlete', 'volunteer', 'staff'] as const)(
    'a %s with no relationship to the child cannot resolve that child requirement',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue({ ...principal(role), athleteId: role === 'athlete' ? 'ath-mine' : null });
      mockAssertAthlete.mockRejectedValue(REFUSED);

      const response = await POST(postRequest({ action: 'resolve', research_requirement_id: 4171 }));

      expect(response.status).toBe(404);
      expect(mockResolve).not.toHaveBeenCalled();
      // The gate was consulted about the STORED row's child, not about
      // anything the request body said.
      expect(mockAssertAthlete).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'acct-1', organizationId: 'org-real', role }),
        'ath-other',
      );
    },
  );

  // Same attack against the pre-migration row shape. If the owner resolution
  // read only the subject_id column this row would resolve to "names no
  // athlete" and sail straight through -- leaving precisely the safeguarding
  // rows unprotected.
  test('the legacy metadata-only row is protected too', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockGetById.mockResolvedValue(storedLegacy());
    mockAssertAthlete.mockRejectedValue(REFUSED);

    const response = await POST(postRequest({ action: 'resolve', research_requirement_id: 4172 }));

    expect(response.status).toBe(404);
    expect(mockAssertAthlete).toHaveBeenCalledWith(expect.anything(), 'ath-other');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  // A refused id and an absent id must be indistinguishable. With sequential
  // ids a distinct 403 would hand an enumerating caller a map of which ids
  // exist and which name a child.
  test('a refusal is indistinguishable from an id that does not exist', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAssertAthlete.mockRejectedValue(REFUSED);
    const refused = await POST(postRequest({ action: 'resolve', research_requirement_id: 4171 }));

    jest.clearAllMocks();
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockGetById.mockResolvedValue(null);
    const absent = await POST(postRequest({ action: 'resolve', research_requirement_id: 999999 }));

    expect(absent.status).toBe(refused.status);
    expect(await absent.json()).toEqual(await refused.json());
    expect(mockResolve).not.toHaveBeenCalled();
  });

  // Coverage is the reason this is decided on every write rather than once.
  // assertActorCanAccessAthlete admits a covering coach only while
  // `starts_at <= now() and expires_at > now()`, so a grant that has lapsed --
  // or been cut short by revokeCoachCoverage, which forces expires_at to
  // now() -- stops admitting the substitute here at the same moment it stops
  // admitting them everywhere else.
  test('a substitute coach whose coverage grant has lapsed can no longer resolve', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAssertAthlete.mockRejectedValue(REFUSED);

    const lapsed = await POST(postRequest({ action: 'resolve', research_requirement_id: 4171 }));

    expect(lapsed.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();

    // While the grant is live the same coach is admitted, through the same
    // single gate.
    mockAssertAthlete.mockReset();
    mockAssertAthlete.mockResolvedValue(undefined);

    const covered = await POST(postRequest({ action: 'resolve', research_requirement_id: 4171 }));

    expect(covered.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  // AUTHORIZE-AND-WRITE IS ONE STATEMENT. The subject just authorized is
  // handed to the UPDATE and bound in its WHERE, so a row whose subject
  // changed between the read and the write matches nothing.
  test('the authorized owner is carried into the write', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    await POST(postRequest({ action: 'resolve', research_requirement_id: 4171 }));

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-real',
        researchRequirementId: 4171,
        expectedSubjectAthleteId: 'ath-other',
      }),
    );
  });

  test('the authorized owner of a legacy row is the one metadata names', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockGetById.mockResolvedValue(storedLegacy());

    await POST(postRequest({ action: 'resolve', research_requirement_id: 4172 }));

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSubjectAthleteId: 'ath-other' }),
    );
  });

  // RESOLVING IS CLOSING, NOT RE-FILING. `metadata` is merged into the stored
  // row, and two of its keys are read by the subject resolution. Unguarded, a
  // caller entitled to the row could push it into another family's view --
  // notes and all -- or unbind it into org-wide data every volunteer and staff
  // account may read.
  test('resolve metadata cannot repoint the requirement at another child', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await POST(postRequest({
      action: 'resolve',
      research_requirement_id: 4171,
      metadata: { athlete_id: 'ath-mine' },
    }));

    expect(response.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('resolve metadata cannot unbind a legacy row into organization-wide data', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockGetById.mockResolvedValue(storedLegacy());

    const response = await POST(postRequest({
      action: 'resolve',
      research_requirement_id: 4172,
      metadata: { athlete_id: null },
    }));

    expect(response.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  // The gate runs first, so a caller with no entitlement gets the same 404
  // whatever they sent -- the metadata 400 must not become an oracle telling
  // them the row exists and what its subject is not.
  test('an unauthorized caller sending repointing metadata still gets the same 404', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAssertAthlete.mockRejectedValue(REFUSED);

    const response = await POST(postRequest({
      action: 'resolve',
      research_requirement_id: 4171,
      metadata: { athlete_id: 'ath-mine' },
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'Requirement not found' });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('restating the subject the row already has is allowed', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await POST(postRequest({
      action: 'resolve',
      research_requirement_id: 4171,
      metadata: { subject_id: 'ath-other', resolved_from: 'research_page' },
    }));

    expect(response.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  // THE LEGITIMATE PATH, PART 1. A parent closing their own child's
  // requirement. Both bounds are present: the guardian's linked-athlete list
  // the route always sent, AND the stored row's authorized owner.
  test('a parent still resolves their own child requirement', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('parent'));
    mockGuardianAthleteIds.mockResolvedValue(['ath-mine']);
    mockGetById.mockResolvedValue(stored({ subject_id: 'ath-mine', metadata: { athlete_id: 'ath-mine' } }));

    const response = await POST(postRequest({
      action: 'resolve',
      research_requirement_id: 4171,
      metadata: { resolved_from: 'research_page' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, resolved: true });
    expect(mockAssertAthlete).toHaveBeenCalledWith(expect.anything(), 'ath-mine');
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        athleteIds: ['ath-mine'],
        expectedSubjectAthleteId: 'ath-mine',
        resolvedByAccountId: 'acct-1',
        resolvedByRole: 'parent',
        metadata: { resolved_from: 'research_page' },
      }),
    );
  });

  // THE LEGITIMATE PATH, PART 2. An organization admin administers the whole
  // gym's records; assertActorCanAccessAthlete admits them for any athlete of
  // their own organization, so acting within their remit still works.
  test('an organization admin still resolves a requirement in their organization', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));

    const response = await POST(postRequest({ action: 'resolve', research_requirement_id: 4171 }));

    expect(response.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSubjectAthleteId: 'ath-other', resolvedByRole: 'organization_admin' }),
    );
  });

  // A row that names no athlete is the gym's own operational backlog and
  // stays closable by the in-organization roles this route admits.
  test('an organization-wide requirement is still resolvable, with no athlete gate', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockGetById.mockResolvedValue(storedOrgWide());

    const response = await POST(postRequest({ action: 'resolve', research_requirement_id: 10 }));

    expect(response.status).toBe(200);
    expect(mockAssertAthlete).not.toHaveBeenCalled();
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSubjectAthleteId: null }),
    );
  });

  // Preserved exactly as it was: a guardian's athleteIds scope has only ever
  // matched on subject_id, which never matches a subject-less row, and the
  // list they read is scoped the same way. Widening a guardian to the gym's
  // doctrine backlog is not this fix's business.
  test('a parent is still refused an organization-wide requirement', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('parent'));
    mockGuardianAthleteIds.mockResolvedValue(['ath-mine']);
    mockGetById.mockResolvedValue(storedOrgWide());

    const response = await POST(postRequest({ action: 'resolve', research_requirement_id: 10 }));

    expect(response.status).toBe(404);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('a parent with no linked athletes is refused without reading anything', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('parent'));
    mockGuardianAthleteIds.mockResolvedValue([]);

    const response = await POST(postRequest({ action: 'resolve', research_requirement_id: 4171 }));

    expect(response.status).toBe(404);
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('a missing research_requirement_id is still a 400', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await POST(postRequest({ action: 'resolve' }));

    expect(response.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  // platform_owner is excluded from this route's write role set outright:
  // Omega observes knowledge gaps, it does not author or close them.
  test('platform_owner cannot resolve at all', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('platform_owner'));

    const response = await POST(postRequest({ action: 'resolve', research_requirement_id: 4171 }));

    expect(response.status).toBe(403);
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST (create) -- metadata names a child too
// ---------------------------------------------------------------------------
//
// The create gate ran assertActorCanAccessAthlete only for the top-level
// subject_id. But the subject resolution ALSO reads metadata.subject_id and
// metadata.athlete_id -- it has to, because the writers that predate the
// subject_id column name their athlete only there -- and `metadata` is
// caller-supplied on this route. So a caller could file a requirement against
// a child they have no relationship with simply by putting the id in metadata
// and omitting subject_id: free-text research_requirement and knowledge_gap,
// attributed to that child, and (after #652) hidden from the author while
// visible to that child's own circle.
describe('POST /api/pilot/shadow/research-requirements (create) metadata subject', () => {
  test('an athlete named only in metadata is authorized too', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAssertAthlete.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    const response = await POST(postRequest({ ...validBody, metadata: { athlete_id: 'ath-not-theirs' } }));

    expect(response.status).toBe(403);
    expect(mockAssertAthlete).toHaveBeenCalledWith(expect.anything(), 'ath-not-theirs');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('metadata.subject_id is authorized too', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAssertAthlete.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    const response = await POST(postRequest({ ...validBody, metadata: { subject_id: 'ath-not-theirs' } }));

    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // Every athlete the row will name, not just the first: subject_id naming a
  // child the caller may reach must not smuggle a second one in past the gate.
  test('a second athlete named in metadata is authorized as well as the column', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    await POST(postRequest({ ...validBody, subject_id: 'ath-mine', metadata: { athlete_id: 'ath-other' } }));

    expect(mockAssertAthlete).toHaveBeenCalledWith(expect.anything(), 'ath-mine');
    expect(mockAssertAthlete).toHaveBeenCalledWith(expect.anything(), 'ath-other');
  });

  // The legitimate shape written by shadowLibrary and the intake reviewers:
  // the metadata key restates the athlete the column already names.
  test('metadata restating the authorized subject still creates', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await POST(postRequest({
      ...validBody,
      subject_id: 'ath-mine',
      metadata: { athlete_id: 'ath-mine', created_from: 'research_page' },
    }));

    expect(response.status).toBe(200);
    expect(mockAssertAthlete).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 'ath-mine' }));
  });

  test('metadata that names no athlete still needs no per-athlete check', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await POST(postRequest({ ...validBody, metadata: { created_from: 'research_page' } }));

    expect(response.status).toBe(200);
    expect(mockAssertAthlete).not.toHaveBeenCalled();
  });
});
