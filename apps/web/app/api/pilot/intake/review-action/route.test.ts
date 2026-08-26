import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { createOrUpdateMicrosoftStaffAccount } from '@/src/server/pilot/staffProvisioning';
import { createOrUpdateAthleteAccount } from '@/src/server/pilot/auth';
import { upsertAthlete } from '@/src/server/pilot/entities';
import { assertActorCanAccessIntakeCase, createReadiness, getIntakeCaseById, updateIntakeCaseStatus } from '@/src/server/pilot/intake';
import { createShadowResearchRequirement } from '@/src/server/pilot/shadowResearch';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// Guardian provisioning is the subject; everything the promotion path touches
// on the way to it is stubbed so a failure here is about the guardian, not
// about the database.
jest.mock('@/src/server/pilot/staffProvisioning', () => ({
  createOrUpdateMicrosoftStaffAccount: jest.fn(),
}));
jest.mock('@/src/server/pilot/auth', () => ({
  createOrUpdateAthleteAccount: jest.fn(),
  createParentAccount: jest.fn(),
}));
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
// Spread the real module rather than replacing it: only the ledger-writing
// assertShadowAuthority needs stubbing. isShadowAutomationMode and
// SHADOW_AUTOMATION_MODES are pure and are what the route validates against,
// so a bare replacement would leave the route calling undefined.
jest.mock('@/src/server/pilot/shadowAuthority', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowAuthority');
  return { ...actual, assertShadowAuthority: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowEvents', () => ({ emitShadowEvent: jest.fn() }));
jest.mock('@/src/server/pilot/shadowTelemetry', () => ({ writeShadowTelemetryEvent: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/entities', () => ({ upsertAthlete: jest.fn() }));
jest.mock('@/src/server/pilot/shadow', () => ({ buildReviewResearchFields: jest.fn(() => ({})) }));
jest.mock('@/src/server/pilot/shadowResearch', () => ({ createShadowResearchRequirement: jest.fn() }));
jest.mock('@/src/server/pilot/intake', () => ({
  assertActorCanAccessIntakeCase: jest.fn(),
  getIntakeCaseById: jest.fn(),
  // Promotion refuses outright when a case has no scanned documents, so the
  // fixture supplies one that passes review.
  listIntakeDocumentsByCase: jest.fn(async () => [{ intake_document_id: 'doc-1' }]),
  isIntakeDocumentReadyForReview: jest.fn(() => true),
  bindIntakeDocumentsToOwner: jest.fn(),
  linkGuardianAthlete: jest.fn(),
  upsertGuardian: jest.fn(),
  updateIntakeCaseStatus: jest.fn(),
  createAssessment: jest.fn(),
  createAttendance: jest.fn(),
  createReadiness: jest.fn(),
  createCoachObservation: jest.fn(),
  upsertEmergencyContact: jest.fn(),
  upsertMedicalIntake: jest.fn(),
  upsertWaiver: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockStaffProvision = createOrUpdateMicrosoftStaffAccount as jest.MockedFunction<
  typeof createOrUpdateMicrosoftStaffAccount
>;
const mockAthleteAccount = createOrUpdateAthleteAccount as jest.MockedFunction<typeof createOrUpdateAthleteAccount>;
const mockGetIntakeCase = getIntakeCaseById as jest.MockedFunction<typeof getIntakeCaseById>;
const mockAuthority = assertActorCanAccessIntakeCase as jest.MockedFunction<typeof assertActorCanAccessIntakeCase>;
const mockUpdateStatus = updateIntakeCaseStatus as jest.MockedFunction<typeof updateIntakeCaseStatus>;
const mockCreateResearchRequirement = createShadowResearchRequirement as jest.MockedFunction<
  typeof createShadowResearchRequirement
>;
const mockCreateReadiness = createReadiness as jest.MockedFunction<typeof createReadiness>;
const mockUpsertAthlete = upsertAthlete as jest.MockedFunction<typeof upsertAthlete>;

function principal(): PilotPrincipal {
  return {
    accountId: 'acct-admin',
    role: 'organization_admin',
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function promoteRequest(guardian: Record<string, unknown> | undefined) {
  return new NextRequest('http://localhost/api/pilot/intake/review-action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intake_case_id: 'case-1',
      action: 'promote',
      promotion: {
        athlete: {
          athlete_id: 'ath-1',
          full_name: 'Gate Athlete',
          dob: '2011-02-10',
          weight_class: '119',
          gym_status: 'active',
          emergency_contact: 'Guardian 555-0102',
          coach_id: 'acct-admin',
        },
        ...(guardian ? { guardian } : {}),
      },
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PPBF_INTAKE_PROMOTION_ENABLED = 'true';
  mockRequirePrincipal.mockResolvedValue(principal());
  mockGetIntakeCase.mockResolvedValue({ intake_case_id: 'case-1', status: 'approved' } as never);
  mockAuthority.mockResolvedValue({ found: true, submittedByAccountId: 'acct-admin', subjectAthleteIds: [] });
  mockStaffProvision.mockResolvedValue({
    accountId: 'guardian-1',
    organizationId: 'org-real',
    role: 'parent',
    loginEmail: 'guardian@example.org',
    created: true,
  });
});

describe('intake promotion provisions guardians who can actually sign in', () => {
  const guardianBase = {
    parent_id: 'parent-1',
    account_id: 'guardian-1',
    full_name: 'Gate Guardian',
    phone: '555-0102',
    email: 'guardian@example.org',
    relationship_to_athlete: 'parent',
  };

  test('provisions the guardian as a Microsoft-authenticated parent', async () => {
    const response = await POST(promoteRequest(guardianBase));

    expect(response.status).toBe(200);
    expect(mockStaffProvision).toHaveBeenCalledWith({
      loginEmail: 'guardian@example.org',
      organizationId: 'org-real',
      role: 'parent',
      accountIdHint: 'guardian-1',
    });
  });

  test('takes the organization from the session, not the payload', async () => {
    await POST(promoteRequest({ ...guardianBase, organization_id: 'org-attacker' }));

    expect(mockStaffProvision).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-real' }),
    );
  });

  test('rejects a guardian PIN instead of silently ignoring it', async () => {
    // Accepting this used to write a local PIN account for a parent. Such an
    // account can never sign in -- PIN login admits only athletes, and
    // resolvePrincipal revokes a live local non-athlete session on sight -- so
    // a caller still sending a PIN is asking for something that cannot work.
    const response = await POST(promoteRequest({ ...guardianBase, pin: '482913' }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(String(payload.error)).toMatch(/Unsupported guardian\.pin/);
    expect(mockStaffProvision).not.toHaveBeenCalled();
  });

  test('requires an email when an account is being provisioned', async () => {
    const withoutEmail = { ...guardianBase };
    delete (withoutEmail as { email?: string }).email;

    const response = await POST(promoteRequest(withoutEmail));
    const payload = await response.json();

    // Without an email there is no identity for Microsoft sign-in to resolve,
    // so an account provisioned here could never be reached.
    expect(response.status).toBe(400);
    expect(String(payload.error)).toMatch(/Missing guardian\.email/);
    expect(mockStaffProvision).not.toHaveBeenCalled();
  });

  test('a guardian record with no account_id provisions no account', async () => {
    const recordOnly = { ...guardianBase };
    delete (recordOnly as { account_id?: string }).account_id;

    const response = await POST(promoteRequest(recordOnly));

    // Recording a guardian for contact purposes is not the same as giving them
    // a login, and must not silently create one.
    expect(response.status).toBe(200);
    expect(mockStaffProvision).not.toHaveBeenCalled();
  });

  test('promotion without a guardian still works', async () => {
    const response = await POST(promoteRequest(undefined));

    expect(response.status).toBe(200);
    expect(mockStaffProvision).not.toHaveBeenCalled();
  });

  function athletePromoteRequest(athleteExtra: Record<string, unknown>) {
    return new NextRequest('http://localhost/api/pilot/intake/review-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intake_case_id: 'case-1',
        action: 'promote',
        promotion: {
          athlete: {
            athlete_id: 'ath-1',
            full_name: 'Gate Athlete',
            dob: '2011-02-10',
            weight_class: '119',
            gym_status: 'active',
            emergency_contact: 'Guardian 555-0102',
            coach_id: 'acct-admin',
            ...athleteExtra,
          },
        },
      }),
    });
  }

  test('rejects an athlete PIN instead of silently discarding it', async () => {
    // The predecessor of this test asserted the PIN was "provisioned" -- but
    // the value it asserted on landed in createOrUpdateAthleteAccount's
    // ignored legacy parameter and was never written anywhere. The test was
    // fooled by the same signature the administrators were. The supported
    // credential flow is promote -> pin-reset (mode 'activate'), which the
    // E2E gate exercises end to end.
    const response = await POST(athletePromoteRequest({ account_id: 'athlete-1', pin: '482913' }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(String(payload.error)).toMatch(/Unsupported athlete\.pin/);
    expect(mockAthleteAccount).not.toHaveBeenCalled();
  });

  test('provisions the athlete account credential-less when account_id is given without a pin', async () => {
    const response = await POST(athletePromoteRequest({ account_id: 'athlete-1' }));

    expect(response.status).toBe(200);
    // Three-argument form: the org rides in the legacy slot, and no
    // credential is involved at promotion time.
    expect(mockAthleteAccount).toHaveBeenCalledWith('athlete-1', 'ath-1', 'org-real');
  });

  // Guards the write half of the subject_id column: the promoted athlete's id
  // must reach createShadowResearchRequirement as subjectId, not just as
  // metadata.athlete_id, or the row stays unreachable by the parent-scoped
  // filter that reads subject_id.
  test('passes the promoted athlete as the research requirement subject', async () => {
    await POST(promoteRequest(undefined));

    expect(mockCreateResearchRequirement).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: 'ath-1' }),
    );
  });
});

// promotion.readiness.score is typed `number` in IntakePromotionPayload, but
// that type is only an `as` cast on the parsed JSON body -- nothing checked
// the actual value before it reached pilot.readiness, a NOT NULL column a
// coach-facing triage board (readinessBoard.ts) reads as ground truth.
describe('promotion readiness is validated before it reaches pilot.readiness', () => {
  function readinessPromoteRequest(readiness: Record<string, unknown>) {
    return new NextRequest('http://localhost/api/pilot/intake/review-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intake_case_id: 'case-1',
        action: 'promote',
        promotion: {
          athlete: {
            athlete_id: 'ath-1',
            full_name: 'Gate Athlete',
            dob: '2011-02-10',
            weight_class: '119',
            gym_status: 'active',
            emergency_contact: 'Guardian 555-0102',
            coach_id: 'acct-admin',
          },
          readiness,
        },
      }),
    });
  }

  test('a valid readiness score promotes through unchanged', async () => {
    const response = await POST(
      readinessPromoteRequest({ score: 7.2, category: 'general', measured_at: '2026-08-17T12:00:00Z' }),
    );

    expect(response.status).toBe(200);
    expect(mockCreateReadiness).toHaveBeenCalledWith({
      organizationId: 'org-real',
      athleteId: 'ath-1',
      score: 7.2,
      category: 'general',
      measuredAt: '2026-08-17T12:00:00Z',
      method: 'staff_entered_intake',
      recordedByAccountId: 'acct-admin',
    });
  });

  test('a non-numeric readiness score is refused before it ever reaches pilot.readiness', async () => {
    const response = await POST(
      readinessPromoteRequest({ score: 'high', category: 'general', measured_at: '2026-08-17T12:00:00Z' }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(String(payload.error)).toMatch(/Unsupported promotion\.readiness\.score/);
    expect(mockCreateReadiness).not.toHaveBeenCalled();
  });

  test('a missing readiness score is refused the same way, not silently skipped', async () => {
    const response = await POST(
      readinessPromoteRequest({ category: 'general', measured_at: '2026-08-17T12:00:00Z' }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(String(payload.error)).toMatch(/Unsupported promotion\.readiness\.score/);
    expect(mockCreateReadiness).not.toHaveBeenCalled();
  });

  // The finding this pins: requireFiniteNumber used to run only at the
  // createReadiness call, after upsertAthlete and every other promotion
  // write had already committed -- so an invalid score returned a clean 400
  // that looked like nothing had happened, while most of the promotion had.
  // A caller who fixed the score and resubmitted would then re-run every
  // earlier write, duplicating the insert-only assessment/attendance rows
  // (Codex review, PR #423). Validation now runs before the first write.
  test('an invalid readiness score is refused before the athlete write, not after it', async () => {
    const response = await POST(
      readinessPromoteRequest({ score: 'high', category: 'general', measured_at: '2026-08-17T12:00:00Z' }),
    );

    expect(response.status).toBe(400);
    expect(mockUpsertAthlete).not.toHaveBeenCalled();
    expect(mockCreateReadiness).not.toHaveBeenCalled();
  });
});


describe('review-action authorizes the actor against the case before mutating it', () => {
  // The bug: the only case-authority gate was
  //   if (intakeCase.primary_athlete_id) await assertActorCanAccessAthlete(...)
  // and intake_cases.primary_athlete_id is NULL on every row, so that gate never
  // ran once -- requireRole admitted every coach in the organization and any coach
  // could reject/approve/promote any case. Authorization must resolve the case and
  // refuse an unrelated actor BEFORE the status write. The gate's own decision
  // logic runs against the real gate + a mocked DB in document-review/route.test.ts;
  // the property under test here is that this MUTATING route consults the gate at
  // all and honors a refusal before writing.
  function rejectRequest() {
    return new NextRequest('http://localhost/api/pilot/intake/review-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intake_case_id: 'case-1', action: 'reject' }),
    });
  }

  test('an actor with no relationship to the case is refused 403 and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValue({
      accountId: 'acct-coach',
      role: 'coach',
      organizationId: 'org-real',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });
    mockAuthority.mockRejectedValueOnce(
      new Error('Forbidden: actor has no relationship to this intake case'),
    );

    const response = await POST(rejectRequest());

    expect(response.status).toBe(403);
    expect(mockAuthority).toHaveBeenCalledWith(expect.anything(), 'org-real', 'case-1');
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  test('an authorized actor reject is written', async () => {
    mockAuthority.mockResolvedValue({ found: true, submittedByAccountId: 'acct-admin', subjectAthleteIds: [] });

    const response = await POST(rejectRequest());

    expect(response.status).toBe(200);
    expect(mockUpdateStatus).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// automation_mode: a closed vocabulary that every gate compares for EXACT
// equality.
//
// decideShadowAuthority refuses on `automationMode === 'automatic'` in three
// branches, and this route refuses promotion outright on the same comparison.
// The value arrived here straight off the request body with no check, typed as
// ShadowAutomationMode by an `as` cast that proves nothing at runtime -- so a
// caller declaring "Automatic" was read as a non-automatic actor by every one
// of those gates and promoted a child's record with no human-in-the-loop
// refusal, while pilot.shadow_authority_checks recorded the check as passed.
//
// The gap was already named, in shadow/medical-status/route.ts's own header:
// "the two sibling assertShadowAuthority call sites take automation_mode
// straight off the body with no check". This is one of the two.

const NEAR_MISS_AUTOMATION_MODES = [
  'Automatic',
  'AUTOMATIC',
  'aUtOmAtIc',
  'automatic ',
  ' automatic',
  'automatic\n',
];

function promoteRequestWithMode(automationMode: unknown) {
  return new NextRequest('http://localhost/api/pilot/intake/review-action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intake_case_id: 'case-1',
      action: 'promote',
      automation_mode: automationMode,
      promotion: {
        athlete: {
          athlete_id: 'ath-1',
          full_name: 'Gate Athlete',
          dob: '2011-02-10',
          weight_class: '119',
          gym_status: 'active',
          emergency_contact: 'Guardian 555-0102',
          coach_id: 'acct-admin',
        },
      },
    }),
  });
}

describe('automation_mode is held to the closed vocabulary before any gate reads it', () => {
  // A table-driven guard written over an empty list passes without ever
  // running. Pin the count so deleting the cases fails loudly.
  test('the near-miss table is not empty', () => {
    expect(NEAR_MISS_AUTOMATION_MODES.length).toBeGreaterThan(0);
  });

  test('the exact vocabulary value is still refused by the promotion gate', async () => {
    const response = await POST(promoteRequestWithMode('automatic'));

    expect(response.status).toBe(403);
    expect(mockUpsertAthlete).not.toHaveBeenCalled();
  });

  test.each(NEAR_MISS_AUTOMATION_MODES)(
    'automation_mode %p is refused rather than read as non-automatic',
    async (mode) => {
      const response = await POST(promoteRequestWithMode(mode));

      expect(response.status).toBe(400);
      // The promotion must not have begun: upsertAthlete is the first write on
      // that path, so a call here means a child's record was created past a
      // gate that never fired.
      expect(mockUpsertAthlete).not.toHaveBeenCalled();
    },
  );

  const NON_STRING_AUTOMATION_MODES: Array<[string, unknown]> = [
    ['an object', { mode: 'automatic' }],
    ['an array', ['manual']],
    ['a number', 3],
    ['a boolean', true],
    ['an empty string', ''],
  ];

  test('the non-string table is not empty', () => {
    expect(NON_STRING_AUTOMATION_MODES.length).toBeGreaterThan(0);
  });

  test.each(NON_STRING_AUTOMATION_MODES)('a %s automation_mode is refused', async (_label, mode) => {
    const response = await POST(promoteRequestWithMode(mode));

    expect(response.status).toBe(400);
    expect(mockUpsertAthlete).not.toHaveBeenCalled();
  });

  test('an omitted automation_mode still defaults to assisted and promotes', async () => {
    const response = await POST(promoteRequest(undefined));

    expect(response.status).toBe(200);
    expect(mockUpsertAthlete).toHaveBeenCalledTimes(1);
  });

  test.each(['assisted', 'manual'])('the vocabulary value %p still promotes', async (mode) => {
    const response = await POST(promoteRequestWithMode(mode));

    expect(response.status).toBe(200);
    expect(mockUpsertAthlete).toHaveBeenCalledTimes(1);
  });
});

/**
 * `admin` is the LEGACY SPELLING of organization_admin, not a lesser role.
 *
 * This route said so twice and then contradicted itself once. requireRole at
 * the top admits `admin` through roleEquals, and assertIntakeCaseAuthority
 * admits it through isOrganizationAdminRole -- but the promote branch compared
 * `principal.role !== 'organization_admin'` directly. So a legacy-admin
 * organization could approve an intake case and reject one, and was refused on
 * the single action that turns an approved case into an athlete record, by an
 * error naming the role it is supposed to be equivalent to.
 *
 * The whole file used only `organization_admin` principals, so nothing caught
 * it. These two cases pin both spellings to the same outcome.
 */
describe('legacy admin is organization_admin for promotion', () => {
  function legacyAdminPrincipal(): PilotPrincipal {
    return { ...principal(), role: 'admin' };
  }

  test('a legacy admin may promote, exactly as an organization_admin may', async () => {
    mockRequirePrincipal.mockResolvedValue(legacyAdminPrincipal());
    mockGetIntakeCase.mockResolvedValue({ intake_case_id: 'case-1', status: 'approved' } as never);

    const response = await POST(promoteRequest(undefined));

    // The assertion that matters is that the promote gate did not refuse the
    // role. A later failure in this route would be a different defect.
    const body = (await response.json()) as { error?: string };
    expect(body.error ?? '').not.toContain('only organization_admin can promote intake');
  });

  test('both spellings reach the same gate outcome', async () => {
    const outcomes: string[] = [];
    for (const role of ['organization_admin', 'admin'] as const) {
      jest.clearAllMocks();
      mockRequirePrincipal.mockResolvedValue({ ...principal(), role });
      mockGetIntakeCase.mockResolvedValue({ intake_case_id: 'case-1', status: 'approved' } as never);
      const response = await POST(promoteRequest(undefined));
      const body = (await response.json()) as { error?: string };
      outcomes.push(body.error?.includes('only organization_admin can promote intake') ? 'refused' : 'admitted');
    }
    // Guards against "fixing" this by refusing both.
    expect(outcomes).toEqual(['admitted', 'admitted']);
  });
});

/**
 * Approving a promoted case must not walk it back.
 *
 * approve had no status precondition -- it wrote 'approved' unconditionally,
 * over any prior status including 'promoted'. Promote's own precondition
 * (status must be 'approved') was therefore defeatable by another action
 * silently restoring the state it checks for: promote, approve, promote again.
 *
 * The second promote is the damage, and it is not cosmetic.
 * createOrUpdateAthleteAccount's update branch sets pin_hash = null,
 * active_flag = false and revokes every session, because re-running a review is
 * meant to re-provision. Correct for an athlete who has not activated yet;
 * catastrophic for one who already redeemed their code and chose a PIN nobody
 * else knows. They are locked out with no way to request a new activation code
 * themselves, and the admin sees ok: true.
 */
describe('approve cannot un-promote a case', () => {
  test('refuses to approve a case that is already promoted', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetIntakeCase.mockResolvedValue({ intake_case_id: 'case-1', status: 'promoted' } as never);

    const response = await POST(new NextRequest('http://localhost/api/pilot/intake/review-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intake_case_id: 'case-1', action: 'approve' }),
    }));

    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('already promoted');
    // The status write must not have happened -- a refusal that still mutates
    // is not a refusal.
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  test('an approved case can still be approved, so ordinary review is unaffected', async () => {
    // Guards against "fixing" this by refusing approve outright. Re-approving a
    // case that has not been promoted is a normal thing an admin may do.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetIntakeCase.mockResolvedValue({ intake_case_id: 'case-1', status: 'approved' } as never);

    const response = await POST(new NextRequest('http://localhost/api/pilot/intake/review-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intake_case_id: 'case-1', action: 'approve' }),
    }));

    const body = (await response.json()) as { error?: string };
    expect(body.error ?? '').not.toContain('already promoted');
    expect(mockUpdateStatus).toHaveBeenCalled();
  });

  test('a submitted case can still be approved', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetIntakeCase.mockResolvedValue({ intake_case_id: 'case-1', status: 'submitted' } as never);

    const response = await POST(new NextRequest('http://localhost/api/pilot/intake/review-action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intake_case_id: 'case-1', action: 'approve' }),
    }));

    const body = (await response.json()) as { error?: string };
    expect(body.error ?? '').not.toContain('already promoted');
  });
});
