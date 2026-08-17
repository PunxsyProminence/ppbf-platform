import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { createOrUpdateMicrosoftStaffAccount } from '@/src/server/pilot/staffProvisioning';
import { createOrUpdateAthleteAccount } from '@/src/server/pilot/auth';
import { createReadiness, getIntakeCaseById } from '@/src/server/pilot/intake';
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
jest.mock('@/src/server/pilot/shadowAuthority', () => ({ assertShadowAuthority: jest.fn() }));
jest.mock('@/src/server/pilot/shadowEvents', () => ({ emitShadowEvent: jest.fn() }));
jest.mock('@/src/server/pilot/shadowTelemetry', () => ({ writeShadowTelemetryEvent: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/entities', () => ({ upsertAthlete: jest.fn() }));
jest.mock('@/src/server/pilot/shadow', () => ({ buildReviewResearchFields: jest.fn(() => ({})) }));
jest.mock('@/src/server/pilot/shadowResearch', () => ({ createShadowResearchRequirement: jest.fn() }));
jest.mock('@/src/server/pilot/intake', () => ({
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
const mockCreateResearchRequirement = createShadowResearchRequirement as jest.MockedFunction<
  typeof createShadowResearchRequirement
>;
const mockCreateReadiness = createReadiness as jest.MockedFunction<typeof createReadiness>;

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
});
