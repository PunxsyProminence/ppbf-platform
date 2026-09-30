import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { createOrUpdateMicrosoftStaffAccount } from '@/src/server/pilot/staffProvisioning';
import { createOrUpdateAthleteAccount } from '@/src/server/pilot/auth';
import { upsertAthlete } from '@/src/server/pilot/entities';
import {
  assertActorCanAccessIntakeCase,
  assertGuardianAccountUnchanged,
  createReadiness,
  getIntakeCaseById,
  linkGuardianAthlete,
  updateIntakeCaseStatus,
  upsertGuardian,
  upsertWaiver,
} from '@/src/server/pilot/intake';
import { ConflictError } from '@/src/server/pilot/errors';
import { queryOne } from '@/src/server/pilot/db';
import { createShadowResearchRequirement } from '@/src/server/pilot/shadowResearch';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// Guardian provisioning is the subject; everything the promotion path touches
// on the way to it is stubbed so a failure here is about the guardian, not
// about the database.
//
// Except the pre-write login checks (guardian and athlete), which run for real
// against a stubbed pilot.accounts lookup: the refusals they are tested for
// have to be the route's own behaviour, not a mock's.
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn(), withTransaction: jest.fn() }));
jest.mock('@/src/server/pilot/staffProvisioning', () => ({
  assertGuardianLoginProvisionable:
    jest.requireActual('@/src/server/pilot/staffProvisioning').assertGuardianLoginProvisionable,
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
  assertAthleteAccountIdProvisionable:
    jest.requireActual('@/src/server/pilot/intake').assertAthleteAccountIdProvisionable,
  assertGuardianAccountUnchanged: jest.fn(),
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
const mockAssertGuardianUnchanged = assertGuardianAccountUnchanged as jest.MockedFunction<
  typeof assertGuardianAccountUnchanged
>;
const mockUpsertGuardian = upsertGuardian as jest.MockedFunction<typeof upsertGuardian>;
const mockLinkGuardianAthlete = linkGuardianAthlete as jest.MockedFunction<typeof linkGuardianAthlete>;
const mockQueryOne = queryOne as jest.Mock;
const mockUpsertWaiver = upsertWaiver as jest.MockedFunction<typeof upsertWaiver>;

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

function promoteRequest(
  guardian: Record<string, unknown> | undefined,
  athleteExtra: Record<string, unknown> = {},
) {
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
        ...(guardian ? { guardian } : {}),
      },
    }),
  });
}

// Answers the pre-write pilot.accounts lookups by what they ask for rather
// than by call order, so a test states the accounts that exist and nothing
// else. Anything not named does not exist.
function stubAccounts(accounts: {
  byEmail?: Record<string, Record<string, unknown>>;
  byId?: Record<string, Record<string, unknown>>;
}) {
  mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    const key = String(params?.[0]);
    if (sql.includes('lower(login_email) = $1')) return accounts.byEmail?.[key] ?? null;
    if (sql.includes('where account_id = $1')) return accounts.byId?.[key] ?? null;
    return null;
  });
}

// The promotion's writes, in order: the athlete record, the athlete's account,
// the guardian's login, the guardian record and its link, and the case status.
// A refusal has to come before every one of them.
function expectNothingWritten() {
  expect(mockUpsertAthlete).not.toHaveBeenCalled();
  expect(mockAthleteAccount).not.toHaveBeenCalled();
  expect(mockStaffProvision).not.toHaveBeenCalled();
  expect(mockUpsertGuardian).not.toHaveBeenCalled();
  expect(mockLinkGuardianAthlete).not.toHaveBeenCalled();
  expect(mockUpdateStatus).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset, not only clearAllMocks: a refusal test leaves a queued
  // lookup result behind, and clearAllMocks would carry it into the next test.
  // Reset, it answers "no such account" -- a new guardian login.
  mockQueryOne.mockReset();
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
      // R5: provisioning itself also refuses to re-role an existing account,
      // and to reactivate a deleted one.
      refuseRoleChange: true,
      refuseDeletedLogin: true,
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

  // It used to be refused only after upsertAthlete and the athlete's account
  // had been written, so the admin saw a 400 for a promotion that had half
  // happened.
  test('a guardian PIN is refused before the athlete record or any account is written', async () => {
    const response = await POST(promoteRequest({ ...guardianBase, pin: '482913' }, { account_id: 'athlete-1' }));

    expect(response.status).toBe(400);
    expectNothingWritten();
  });

  test('requires an email when an account is being provisioned', async () => {
    const withoutEmail = { ...guardianBase };
    delete (withoutEmail as { email?: string }).email;

    const response = await POST(promoteRequest(withoutEmail, { account_id: 'athlete-1' }));
    const payload = await response.json();

    // Without an email there is no identity for Microsoft sign-in to resolve,
    // so an account provisioned here could never be reached.
    expect(response.status).toBe(400);
    expect(String(payload.error)).toMatch(/Missing guardian\.email/);
    // Refused before the first write, not after the athlete record and the
    // athlete's account.
    expectNothingWritten();
  });

  // Otherwise the athlete account is created under the id and guardian
  // provisioning then refuses it as taken, after the athlete writes.
  test('a guardian account_id equal to the athlete account_id is refused before anything is written', async () => {
    const response = await POST(promoteRequest(guardianBase, { account_id: ' guardian-1 ' }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe(
      'Unsupported guardian.account_id: it is the same as athlete.account_id. '
      + 'The athlete and the guardian each need their own login.',
    );
    expectNothingWritten();
  });

  // pilot.parents.parent_id and full_name are NOT NULL. Missing either used to
  // pass every pre-write check; the athlete record, the athlete's account and
  // an active parent login were written; and upsertGuardian then failed on the
  // constraint, which reached the admin as "Internal server error".
  test.each([
    ['parent_id', 'Missing guardian.parent_id'],
    ['full_name', 'Missing guardian.full_name'],
  ])('a guardian without %s is refused 400 before anything is written', async (field, message) => {
    const withoutField: Record<string, unknown> = { ...guardianBase };
    delete withoutField[field];

    const response = await POST(promoteRequest(withoutField, { account_id: 'athlete-1' }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe(message);
    expectNothingWritten();
  });

  test.each(['parent_id', 'full_name'])('a blank guardian %s is refused like a missing one', async (field) => {
    const response = await POST(promoteRequest({ ...guardianBase, [field]: '   ' }));

    expect(response.status).toBe(400);
    expectNothingWritten();
  });

  test('the guardian record is written, checked and linked under the trimmed parent_id and full_name', async () => {
    const response = await POST(promoteRequest({ ...guardianBase, parent_id: ' parent-1 ', full_name: ' Gate Guardian ' }));

    expect(response.status).toBe(200);
    expect(mockAssertGuardianUnchanged).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'parent-1' }));
    expect(mockUpsertGuardian).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'parent-1', fullName: 'Gate Guardian' }),
    );
    expect(mockLinkGuardianAthlete).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'parent-1' }));
  });

  // Provisioning's upsert reactivates whatever login it is pointed at, and
  // reads nothing about deletion. A deleted family's guardian came back with
  // a working login, and the retention purge later removed that live login.
  test('a guardian email that belongs to a deleted parent login is refused 409 before anything is written', async () => {
    stubAccounts({
      byEmail: {
        'guardian@example.org': {
          account_id: 'guardian-1',
          organization_id: 'org-real',
          role: 'parent',
          auth_provider: 'microsoft',
          is_platform_owner: false,
          deleted_at: '2026-03-01 12:00:00+00',
        },
      },
    });

    const response = await POST(promoteRequest(guardianBase, { account_id: 'athlete-1' }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe('DELETED_GUARDIAN_LOGIN');
    expect(payload.error).toBe(
      'Conflict: guardian@example.org belongs to a guardian login that was deleted. Intake does not restore a deleted login.',
    );
    expectNothingWritten();
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

  // A guardian record already linked to one login must not be re-pointed to
  // another by a promotion: that would cut the real parent off from every
  // child on the record. upsertGuardian refuses it, but this route has no
  // transaction and writes the athlete and both accounts first -- so the
  // refusal has to land before any of them, not halfway through.
  test('a guardian record linked to a different login is refused before anything is written', async () => {
    mockAssertGuardianUnchanged.mockRejectedValueOnce(new ConflictError(
      'Conflict: guardian record "parent-1" is already linked to another login account, not "guardian-1".',
      'GUARDIAN_ACCOUNT_CONFLICT',
    ));

    const response = await POST(promoteRequest(guardianBase));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(String(payload.error)).toMatch(/already linked to another login account/);
    expect(mockAssertGuardianUnchanged).toHaveBeenCalledWith({
      organizationId: 'org-real',
      parentId: 'parent-1',
      accountId: 'guardian-1',
    });
    expect(mockUpsertAthlete).not.toHaveBeenCalled();
    expect(mockAthleteAccount).not.toHaveBeenCalled();
    expect(mockStaffProvision).not.toHaveBeenCalled();
    expect(mockUpsertGuardian).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  test('the guardian check runs, scoped to the session organization, before the first promotion write', async () => {
    const response = await POST(promoteRequest({ ...guardianBase, organization_id: 'org-attacker' }));

    expect(response.status).toBe(200);
    expect(mockAssertGuardianUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-real', parentId: 'parent-1' }),
    );
    expect(mockAssertGuardianUnchanged.mock.invocationCallOrder[0])
      .toBeLessThan(mockUpsertAthlete.mock.invocationCallOrder[0]);
  });

  // Provisioning keeps the login an email already has and ignores
  // guardian.account_id. The guardian record used to be linked to
  // guardian.account_id anyway -- any existing account, another family's
  // parent login included, which would then see this child.
  test('an email that already belongs to a different account is refused before anything is written', async () => {
    stubAccounts({
      byEmail: {
        'guardian@example.org': {
          account_id: 'acct-other-family',
          organization_id: 'org-real',
          role: 'parent',
          auth_provider: 'microsoft',
          is_platform_owner: false,
        },
      },
    });

    const response = await POST(promoteRequest({ ...guardianBase, account_id: 'acct-named-in-payload' }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(String(payload.error)).toMatch(/already belongs to a different login account than "acct-named-in-payload"/);
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('lower(login_email) = $1'),
      ['guardian@example.org'],
    );
    expect(mockUpsertAthlete).not.toHaveBeenCalled();
    expect(mockAthleteAccount).not.toHaveBeenCalled();
    expect(mockStaffProvision).not.toHaveBeenCalled();
    expect(mockUpsertGuardian).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  test('an account_id another identity already holds is refused before anything is written', async () => {
    stubAccounts({ byId: { 'guardian-1': { account_id: 'guardian-1', organization_id: 'org-real', role: 'parent' } } });

    const response = await POST(promoteRequest(guardianBase));
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(String(payload.error)).toMatch(/account_id is already in use by another identity/);
    expectNothingWritten();
  });

  // R5 (Jason 2026-09-29, "A"). Provisioning re-roles an existing account to
  // the role it is given, so a guardian email that belonged to a coach turned
  // the coach's login into a parent login as a side effect of promotion.
  describe('R5: a guardian email or account_id that belongs to an existing non-parent account', () => {
    test.each(['coach', 'staff', 'volunteer', 'board', 'organization_admin', 'admin', 'athlete'])(
      'an existing %s account named by email is refused with 409 before anything is written',
      async (existingRole) => {
        stubAccounts({
          byEmail: {
            'guardian@example.org': {
              account_id: 'guardian-1',
              organization_id: 'org-real',
              role: existingRole,
              auth_provider: existingRole === 'athlete' ? 'ppbf_local' : 'microsoft',
              is_platform_owner: false,
            },
          },
        });

        const response = await POST(promoteRequest(guardianBase, { account_id: 'athlete-1' }));
        const payload = await response.json();

        expect(response.status).toBe(409);
        expect(payload.error).toBe(
          `Conflict: guardian@example.org already belongs to an existing ${existingRole} account in this organization. `
          + "Intake does not change an existing account's role, so it cannot make that account a parent login. "
          + 'Use a different email address.',
        );
        expectNothingWritten();
      },
    );

    test('the email is matched the way sign-in matches it: trimmed and lower-cased', async () => {
      stubAccounts({
        byEmail: {
          'guardian@example.org': {
            account_id: 'guardian-1',
            organization_id: 'org-real',
            role: 'coach',
            auth_provider: 'microsoft',
            is_platform_owner: false,
          },
        },
      });

      const response = await POST(promoteRequest({ ...guardianBase, email: '  Guardian@Example.ORG ' }));

      expect(response.status).toBe(409);
      expectNothingWritten();
    });

    test('a new email whose account_id belongs to an existing coach is refused with 409 naming it', async () => {
      stubAccounts({ byId: { 'guardian-1': { account_id: 'guardian-1', organization_id: 'org-real', role: 'coach' } } });

      const response = await POST(promoteRequest(guardianBase));
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(String(payload.error)).toMatch(
        /^Conflict: account_id "guardian-1" already belongs to an existing coach account in this organization\./,
      );
      expectNothingWritten();
    });

    test('an existing parent login for that email is still linked, not refused', async () => {
      stubAccounts({
        byEmail: {
          'guardian@example.org': {
            account_id: 'guardian-1',
            organization_id: 'org-real',
            role: 'parent',
            auth_provider: 'microsoft',
            is_platform_owner: false,
          },
        },
      });

      const response = await POST(promoteRequest(guardianBase));

      expect(response.status).toBe(200);
      expect(mockStaffProvision).toHaveBeenCalledWith(expect.objectContaining({ refuseRoleChange: true }));
    });

    test('an email with no account_id provisions nothing, so no account is looked up or changed', async () => {
      const recordOnly = { ...guardianBase };
      delete (recordOnly as { account_id?: string }).account_id;

      const response = await POST(promoteRequest(recordOnly));

      expect(response.status).toBe(200);
      expect(mockQueryOne).not.toHaveBeenCalled();
      expect(mockStaffProvision).not.toHaveBeenCalled();
    });
  });

  test('the guardian record is linked to the account provisioning wrote, not the payload account_id', async () => {
    mockStaffProvision.mockResolvedValueOnce({
      accountId: 'acct-provisioned',
      organizationId: 'org-real',
      role: 'parent',
      loginEmail: 'guardian@example.org',
      created: false,
    });

    const response = await POST(promoteRequest(guardianBase));

    expect(response.status).toBe(200);
    expect(mockUpsertGuardian).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'parent-1', accountId: 'acct-provisioned' }),
    );
  });

  test('a guardian record with no account_id leaves its login link alone', async () => {
    const recordOnly = { ...guardianBase };
    delete (recordOnly as { account_id?: string }).account_id;

    await POST(promoteRequest(recordOnly));

    expect(mockUpsertGuardian).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
    expect(mockQueryOne).not.toHaveBeenCalled();
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
    // It used to be refused after upsertAthlete had written the record.
    expectNothingWritten();
  });

  // createOrUpdateAthleteAccount's update branch re-roles any same-org account
  // it is pointed at into a locked athlete account (PIN cleared, deactivated,
  // sessions revoked). Same rule as R5 on the guardian side.
  test.each(['coach', 'parent', 'staff', 'organization_admin', 'admin'])(
    'an athlete account_id that belongs to an existing %s account is refused with 409 before anything is written',
    async (existingRole) => {
      stubAccounts({ byId: { 'athlete-1': { organization_id: 'org-real', role: existingRole } } });

      const response = await POST(athletePromoteRequest({ account_id: 'athlete-1' }));
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.error).toBe(
        `Conflict: account_id "athlete-1" already belongs to an existing ${existingRole} account in this organization. `
        + "Intake does not change an existing account's role, so it cannot make that account an athlete login. "
        + 'Use a different account_id.',
      );
      expectNothingWritten();
    },
  );

  // createOrUpdateAthleteAccount refuses this itself, but only after
  // upsertAthlete had written the athlete record: a 409 ("Account already
  // exists in another organization") for a promotion that had half happened.
  // Now a 403, before the first write.
  test('an athlete account_id held in another organization is refused 403 before anything is written', async () => {
    stubAccounts({ byId: { 'athlete-1': { organization_id: 'org-other', role: 'athlete' } } });

    const response = await POST(athletePromoteRequest({ account_id: 'athlete-1' }));
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe('Forbidden: account already exists in another organization');
    expectNothingWritten();
  });

  test('an existing athlete account in this organization is still re-provisioned', async () => {
    stubAccounts({ byId: { 'athlete-1': { organization_id: 'org-real', role: 'athlete', athlete_id: null } } });

    const response = await POST(athletePromoteRequest({ account_id: 'athlete-1' }));

    expect(response.status).toBe(200);
    expect(mockAthleteAccount).toHaveBeenCalledWith('athlete-1', 'ath-1', 'org-real');
  });

  test('re-promoting the athlete whose login it already is still re-provisions it', async () => {
    stubAccounts({ byId: { 'athlete-1': { organization_id: 'org-real', role: 'athlete', athlete_id: 'ath-1' } } });

    const response = await POST(athletePromoteRequest({ account_id: 'athlete-1' }));

    expect(response.status).toBe(200);
    expect(mockAthleteAccount).toHaveBeenCalledWith('athlete-1', 'ath-1', 'org-real');
  });

  // createOrUpdateAthleteAccount's update branch re-binds the login to the
  // promoted athlete, clears its PIN and revokes its sessions. Naming another
  // child's login -- a typo, a reused id -- locked that child out, and the next
  // activation code for the login showed this child's records to that family.
  test('an athlete account_id that is another athlete record\'s login is refused 409 before anything is written', async () => {
    stubAccounts({
      byId: { 'athlete-1': { organization_id: 'org-real', role: 'athlete', athlete_id: 'ath-other-child' } },
    });

    const response = await POST(athletePromoteRequest({ account_id: 'athlete-1' }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe('EXISTING_ATHLETE_ACCOUNT_CONFLICT');
    expect(payload.error).toBe(
      'Conflict: account_id "athlete-1" is already the login of a different athlete record in this organization. '
      + "Intake does not move an athlete's login to another athlete record. Use a different account_id.",
    );
    // The other child's record id is not disclosed.
    expect(payload.error).not.toContain('ath-other-child');
    expectNothingWritten();
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


// promotion.waiver.status reached pilot.waivers unread. With
// pilot_waivers_status_check in place a bad value would fail at upsertWaiver
// as a 500 -- after the athlete, account, guardian, emergency contact and
// medical writes had already committed, since promotion has no transaction.
// It is checked before the first write instead, like the readiness score.
describe('promotion waiver status is validated before any promotion write', () => {
  function waiverPromoteRequest(waiver: Record<string, unknown>) {
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
          waiver,
        },
      }),
    });
  }

  const WAIVER = {
    waiver_type: 'general',
    signed_by_name: 'Pat Guardian',
    signed_by_role: 'guardian',
    signed_at: '2026-09-29T12:00:00.000Z',
    consent_version: 'v1',
  };

  test.each(['signed', 'declined', 'withdrawn', 'missing'])('%p promotes and is written as given', async (status) => {
    const response = await POST(waiverPromoteRequest({ ...WAIVER, status }));

    expect(response.status).toBe(200);
    expect(mockUpsertWaiver).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-real',
      athleteId: 'ath-1',
      status,
      recordedByAccountId: 'acct-admin',
    }));
  });

  test.each([
    ['padded and capitalised', ' Signed '],
    ['outside the vocabulary', 'active'],
    ['null', null],
    ['absent', undefined],
  ])('a status that is %s is refused 400 before the athlete write', async (_label, status) => {
    const response = await POST(waiverPromoteRequest({ ...WAIVER, status }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(String(payload.error)).toMatch(/^Unsupported promotion\.waiver\.status/);
    expect(mockUpsertAthlete).not.toHaveBeenCalled();
    expect(mockUpsertWaiver).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
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
