import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { createOrUpdateAthleteAccountWithClient } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { isCompetitionGatedWaiverType, lockCompetitionSafety } from '@/src/server/pilot/competitionSafetyLock';
import { withTransaction } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  assertShadowAuthority,
  isShadowAutomationMode,
  SHADOW_AUTOMATION_MODES,
  type ShadowAutomationMode,
} from '@/src/server/pilot/shadowAuthority';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { buildReviewResearchFields } from '@/src/server/pilot/shadow';
import { createShadowResearchRequirement } from '@/src/server/pilot/shadowResearch';
import {
  assertGuardianLoginProvisionable,
  createOrUpdateMicrosoftStaffAccount,
} from '@/src/server/pilot/staffProvisioning';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';
import { requireWaiverStatus, type WaiverStatus } from '@/src/server/pilot/waiverCompliance';
import {
  assertActorCanAccessIntakeCase,
  assertGuardianAccountUnchanged,
  bindIntakeDocumentsToOwner,
  createAssessment,
  createAttendance,
  createCoachObservation,
  createReadiness,
  getIntakeCaseById,
  isIntakeDocumentReadyForReview,
  linkGuardianAthlete,
  listIntakeDocumentsByCase,
  type IntakePromotionPayload,
  updateIntakeCaseStatus,
  upsertEmergencyContact,
  upsertGuardian,
  upsertMedicalIntake,
  upsertWaiver,
  writePromotedAthleteRecord,
} from '@/src/server/pilot/intake';

export const runtime = 'nodejs';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing ${field}`);
  }
  return value.trim();
}

// promotion.readiness.score is typed as `number` in IntakePromotionPayload,
// but that type comes from an `as` cast on the request body -- nothing
// checks the actual JSON value before it reaches pilot.readiness, a NOT
// NULL column a coach-facing triage board reads as ground truth.
function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // "Unsupported" is jsonError's recognized prefix for a client-supplied
    // field that is missing, wrong-typed, or otherwise invalid (see
    // "Unsupported guardian.pin" below) -- anything else falls into the
    // generic 500 branch, which scrubs the message and would hide a
    // legitimate validation refusal behind an opaque server error. The
    // message names both failure modes this guard actually rejects --
    // missing/wrong-typed and non-finite (NaN, Infinity) -- since "must be a
    // number" alone reads as though only the type was checked (Copilot
    // review, PR #423).
    throw new Error(`Unsupported ${field}: must be a finite number, and cannot be missing`);
  }
  return value;
}

// Runs one write that follows a committed promotion. A failure is logged by
// step, error class and code only -- never the message, which can carry row
// values -- and swallowed, so the caller still reports the promotion it made.
async function afterCommit(step: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
    console.error('intake-promotion-after-commit-write-failed', {
      step,
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      ...(code ? { code } : {}),
    });
  }
}

export async function POST(request: NextRequest) { // NOSONAR
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    await assertShadowRuntimeReadiness({
      requiredTables: [
        'intake_cases',
        'intake_documents',
        'documents',
        'emergency_contacts',
        'medical_intake',
        'waivers',
        'guardian_links',
        'parents',
        'assessments',
        'attendance',
        'readiness',
        'coach_observations',
        'shadow_events',
        'shadow_telemetry_events',
        'shadow_authority_checks',
      ],
    });

    const body = (await request.json()) as {
      intake_case_id?: string;
      action?: 'approve' | 'reject' | 'promote';
      notes?: string;
      promotion?: IntakePromotionPayload;
      automation_mode?: unknown;
    };

    const intakeCaseId = requireString(body.intake_case_id, 'intake_case_id');
    const action = body.action;
    // Validated against the closed vocabulary rather than cast to it.
    //
    // Two gates downstream compare this value for EXACT equality with
    // 'automatic': assertShadowAuthority's automatic-actor refusals, and this
    // route's own "automatic intake promotion is not allowed" stop further
    // down. The declared type is erased at runtime, so a caller declaring
    // "Automatic" was read as a non-automatic actor by both and promoted a
    // child's record -- athlete, guardian, emergency contact, medical, waiver
    // -- past a refusal that never fired, with the authority ledger recording
    // the check as passed. shadow/medical-status/route.ts named this route as
    // one of the two unchecked call sites; this is that check. Absent still
    // means 'assisted', unchanged.
    const automationMode: ShadowAutomationMode = body.automation_mode === undefined
      ? 'assisted'
      : (body.automation_mode as ShadowAutomationMode);
    if (!isShadowAutomationMode(automationMode)) {
      throw new Error(
        `Unsupported automation_mode: must be one of ${SHADOW_AUTOMATION_MODES.join(', ')}`,
      );
    }
    if (!action || !['approve', 'reject', 'promote'].includes(action)) {
      throw new Error('Unsupported action');
    }

    await assertShadowAuthority({
      actor: principal,
      organizationId: principal.organizationId,
      action: `intake.review_action.${action}`,
      automationMode,
      confidenceTier: action === 'promote' ? 'SUFFICIENT_FOR_REVIEW' : 'SUFFICIENT_FOR_LOW_RISK_ACTION',
      lowRisk: action !== 'promote',
      reversible: action !== 'promote',
      withinApprovedOptions: true,
      restrictionConflict: false,
      metadata: {
        intake_case_id: intakeCaseId,
      },
    });

    const intakeCase = await getIntakeCaseById(principal.organizationId, intakeCaseId);
    if (!intakeCase) {
      throw new Error('Missing intake case');
    }

    // Authorize the actor against THIS case before any status mutation. The
    // former gate here -- `if (intakeCase.primary_athlete_id) await
    // assertActorCanAccessAthlete(...)` -- was dead: intake_cases.primary_athlete_id
    // was NULL on every row (no code path wrote it until 2026-10-05; see
    // resolveIntakeCaseAuthority in intake.ts), so the athlete check never ran and requireRole admitted every
    // coach in the organization to act on any case. The sibling READ routes
    // (cases/get, document-review, document-link) already gate on
    // assertActorCanAccessIntakeCase, which narrows an owner-less case to
    // organization_admin or the submitting account and enforces full athlete-scope
    // once the case is athlete-bound. This is the one MUTATING route; it needs the
    // same gate, before the write rather than after.
    const authority = await assertActorCanAccessIntakeCase(
      principal,
      principal.organizationId,
      intakeCaseId,
    );
    if (!authority.found) {
      throw new Error('Missing intake case');
    }

    const intakeDocuments = action === 'reject'
      ? []
      : await listIntakeDocumentsByCase(principal.organizationId, intakeCaseId);
    if (
      action !== 'reject'
      && (
        intakeDocuments.length === 0
        || intakeDocuments.some((document) => !isIntakeDocumentReadyForReview(document))
      )
    ) {
      throw new Error(
        'Forbidden: intake documents must pass security scanning and extraction before approval',
      );
    }

    if (action === 'reject') {
      const researchFields = buildReviewResearchFields({ action: 'reject', intakeCaseId });

      await updateIntakeCaseStatus({
        organizationId: principal.organizationId,
        intakeCaseId,
        status: 'rejected',
        reviewedByAccountId: principal.accountId,
        reviewNotes: body.notes,
      });

      await writePilotAuditEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'intake_case',
        entity_id: intakeCaseId,
        details: { action: 'reject', notes: body.notes ?? '' },
        shadow_mirror: false,
      });

      await emitShadowEvent({
        organizationId: principal.organizationId,
        eventName: 'SHADOW_INTAKE_CASE_REJECTED',
        entityType: 'intake_case',
        entityId: intakeCaseId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        payload: {
          automation_mode: automationMode,
          athlete_id: intakeCase.primary_athlete_id,
          research_requirement: researchFields.researchRequirement,
          knowledge_gap: researchFields.knowledgeGap,
          source_status: researchFields.sourceStatus,
          source_verification_state: researchFields.sourceVerificationState,
        },
      });

      await createShadowResearchRequirement({
        organizationId: principal.organizationId,
        sourceEventName: 'SHADOW_INTAKE_CASE_REJECTED',
        sourceEntityType: 'intake_case',
        sourceEntityId: intakeCaseId,
        researchRequirement: researchFields.researchRequirement,
        knowledgeGap: researchFields.knowledgeGap,
        evidenceLabel: null,
        subjectId: intakeCase.primary_athlete_id,
        sourceStatus: researchFields.sourceStatus,
        sourceConfidenceTier: 'LIMITED',
        sourceVerificationState: researchFields.sourceVerificationState,
        createdByAccountId: principal.accountId,
        createdByRole: principal.role,
        metadata: {
          action: 'reject',
          notes: body.notes ?? '',
          athlete_id: intakeCase.primary_athlete_id,
        },
      });

      await writeShadowTelemetryEvent({
        organizationId: principal.organizationId,
        metricName: 'shadow.intake.review.reject',
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        dimensions: {
          automation_mode: automationMode,
          athlete_id: intakeCase.primary_athlete_id,
        },
      });

      return NextResponse.json({ ok: true, intake_case_id: intakeCaseId, status: 'rejected' });
    }

    if (action === 'approve') {
      /* A promoted case cannot be walked back to 'approved'.

         approve had no status precondition at all -- it wrote 'approved'
         unconditionally, over any prior status including 'promoted'. That made
         a destructive sequence reachable in two clicks: promote, approve,
         promote again.

         The second promote is the damage. createOrUpdateAthleteAccount's
         update branch sets pin_hash = null, active_flag = false and revokes
         every session, because re-running a review is meant to RE-PROVISION.
         That is correct for an athlete who has not activated yet. Run it on one
         who has already redeemed their code and chosen a PIN nobody else knows,
         and they are locked out of their own account, with no way to ask for a
         new activation code themselves -- while the admin who did it sees
         ok: true and no signal that anything was undone.

         The guard is on approve rather than on promote deliberately. Promote's
         own precondition (status must be 'approved') is doing its job; what
         defeated it was another action silently restoring the state it checks
         for. Promotion remains re-runnable for a case that genuinely needs
         re-provisioning -- an admin has to move it out of 'promoted'
         deliberately, not by clicking approve. */
      if (intakeCase.status === 'promoted') {
        throw new Error(
          'Forbidden: this intake case is already promoted. Approving it again would allow a second promotion, '
          + 'which resets the athlete PIN and revokes their sessions.',
        );
      }

      const researchFields = buildReviewResearchFields({ action: 'approve', intakeCaseId });

      await updateIntakeCaseStatus({
        organizationId: principal.organizationId,
        intakeCaseId,
        status: 'approved',
        reviewedByAccountId: principal.accountId,
        reviewNotes: body.notes,
      });

      await writePilotAuditEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'intake_case',
        entity_id: intakeCaseId,
        details: { action: 'approve', notes: body.notes ?? '' },
        shadow_mirror: false,
      });

      await emitShadowEvent({
        organizationId: principal.organizationId,
        eventName: 'SHADOW_INTAKE_CASE_APPROVED',
        entityType: 'intake_case',
        entityId: intakeCaseId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        payload: {
          automation_mode: automationMode,
          athlete_id: intakeCase.primary_athlete_id,
          research_requirement: researchFields.researchRequirement,
          knowledge_gap: researchFields.knowledgeGap,
          source_status: researchFields.sourceStatus,
          source_verification_state: researchFields.sourceVerificationState,
        },
      });

      await createShadowResearchRequirement({
        organizationId: principal.organizationId,
        sourceEventName: 'SHADOW_INTAKE_CASE_APPROVED',
        sourceEntityType: 'intake_case',
        sourceEntityId: intakeCaseId,
        researchRequirement: researchFields.researchRequirement,
        knowledgeGap: researchFields.knowledgeGap,
        evidenceLabel: null,
        subjectId: intakeCase.primary_athlete_id,
        sourceStatus: researchFields.sourceStatus,
        sourceConfidenceTier: 'SUFFICIENT_FOR_REVIEW',
        sourceVerificationState: researchFields.sourceVerificationState,
        createdByAccountId: principal.accountId,
        createdByRole: principal.role,
        metadata: {
          action: 'approve',
          notes: body.notes ?? '',
          athlete_id: intakeCase.primary_athlete_id,
        },
      });

      await writeShadowTelemetryEvent({
        organizationId: principal.organizationId,
        metricName: 'shadow.intake.review.approve',
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        dimensions: {
          automation_mode: automationMode,
          athlete_id: intakeCase.primary_athlete_id,
        },
      });

      return NextResponse.json({ ok: true, intake_case_id: intakeCaseId, status: 'approved' });
    }

    const promotion = body.promotion;
    if (!promotion) {
      throw new Error('Missing promotion payload');
    }

    if (automationMode === 'automatic') {
      throw new Error('Forbidden: automatic intake promotion is not allowed');
    }

    /* isOrganizationAdminRole, not a raw !==, because `admin` is the LEGACY
       SPELLING of organization_admin and this route already says so twice
       above: requireRole at the top of the handler admits it through
       roleEquals, and assertIntakeCaseAuthority admits it through this same
       helper. Only this third check compared the string directly.

       The result was a role that could approve and reject an intake case and
       then be refused on the one action that turns it into an athlete record,
       by an error naming the role it is supposed to be equivalent to. Every
       sibling admin route -- pin-reset, activation-codes, athlete-accounts --
       uses the helper. */
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: only organization_admin can promote intake');
    }
    if (intakeCase.status !== 'approved') {
      throw new Error('Forbidden: intake must be approved before promotion');
    }
    if (process.env.PPBF_INTAKE_PROMOTION_ENABLED !== 'true') {
      throw new Error('Forbidden: intake promotion is not enabled');
    }

    // Validated here, before any promotion write begins, not down at the
    // createReadiness call where it used to live. This route had no
    // transaction wrapping its promotion writes then (it has one now, below,
    // and a refusal there rolls them all back) -- by the time readiness was
    // reached, the athlete, account, guardian, emergency contact, medical,
    // waiver, assessment and attendance writes had already committed. A
    // refusal down there therefore returned a clean 400 that looked like
    // nothing had happened, while most of the promotion had, and a caller
    // who fixed the score and resubmitted would re-run every write in this
    // function -- duplicating the UUID-backed assessment and attendance rows,
    // which insert rather than upsert (Codex review, PR #423).
    const validatedReadinessScore = promotion.readiness
      ? requireFiniteNumber(promotion.readiness.score, 'promotion.readiness.score')
      : undefined;
    // The waiver status for the same reason: pilot_waivers_status_check refuses
    // anything outside the vocabulary, and down at upsertWaiver that refusal
    // would arrive as a 500 after the athlete, account, guardian, emergency
    // contact and medical writes had already committed. No default -- the
    // payload declares status as required.
    const validatedWaiverStatus = promotion.waiver
      ? requireWaiverStatus(promotion.waiver.status, 'promotion.waiver.status')
      : undefined;

    // Same reasoning for every other refusal this promotion can raise: each is
    // checked here, before upsertAthlete, so a refused promotion writes no
    // athlete, account or guardian row. The payload checks come first, then
    // the lookups; the write steps below keep their own checks, which these
    // only move earlier.

    // An athlete PIN is deliberately NOT settable at promotion. The account is
    // provisioned with no credential and inactive, and NOBODY sets a PIN for
    // an athlete any more: an administrator issues a one-time activation code
    // and the athlete redeems it, choosing a PIN only they know. That is the
    // promote → issue code → redeem → sign-in sequence the E2E gate exercises.
    //
    // This request used to ACCEPT athlete.pin and silently discard it (it
    // landed in createOrUpdateAthleteAccount's ignored legacy parameter), so
    // an administrator believed a credential was set that never was. Refuse it
    // the way guardian.pin is refused below; the prefix keeps jsonError
    // mapping it to a 400.
    //
    // The guidance below is user-facing and was stale: it named a `mode`
    // parameter that /admin/accounts/pin-reset no longer has, on a route that
    // no longer sets a PIN at all. An error that tells an administrator to do
    // something impossible is worse than one that says only "no".
    if (promotion.athlete.pin) {
      throw new Error(
        'Unsupported athlete.pin: promotion provisions the account without a credential, and '
        + 'no administrator sets an athlete PIN. Issue a one-time activation code via '
        + 'POST /api/pilot/admin/accounts/pin-reset (or /api/pilot/admin/activation-codes), then '
        + 'have the athlete redeem it at /api/pilot/auth/activate and choose their own PIN.',
      );
    }

    if (promotion.guardian) {
      // Guardians are provisioned as Microsoft-authenticated accounts, not PIN
      // accounts. createParentAccount wrote a local PIN account, but a parent
      // cannot sign in with a PIN -- loginWithAccountIdAndPin admits only
      // athletes, and resolvePrincipal revokes any live local non-athlete
      // session on sight -- so every guardian onboarded this way received an
      // account that could never be used. 'parent' is an invitable staff role,
      // which is the supported path for exactly this.
      // These messages are prefixed to match jsonError's status mapping, so a
      // caller gets an actionable 400 rather than a masked 500. The error this
      // replaces ("guardian.pin is required ...") had no such prefix and so
      // surfaced as "Internal server error".
      if (promotion.guardian.pin) {
        throw new Error(
          'Unsupported guardian.pin: a PIN account cannot sign in as a guardian. '
          + 'Provide guardian.email instead -- guardians authenticate with Microsoft.',
        );
      }

      if (promotion.guardian.account_id && !promotion.guardian.email) {
        throw new Error('Missing guardian.email: required when guardian.account_id is provided');
      }

      // Otherwise the athlete's account is created under that id first, and
      // guardian provisioning then refuses the id as taken -- after writes.
      if (
        promotion.guardian.account_id
        && promotion.athlete.account_id
        && promotion.guardian.account_id.trim() === promotion.athlete.account_id.trim()
      ) {
        throw new Error(
          'Unsupported guardian.account_id: it is the same as athlete.account_id. '
          + 'The athlete and the guardian each need their own login.',
        );
      }
    }

    // pilot.parents.parent_id and full_name are NOT NULL, and nothing checked
    // them before the first write. A guardian sent without either passed every
    // check here; the athlete record, and any athlete or parent login the
    // payload named (the parent login active), were written; and only then did
    // upsertGuardian fail on the not-null constraint, which reached the admin
    // as "Internal server error" while those writes stayed. Both are required
    // now, and every later step uses the trimmed values.
    const guardian = promotion.guardian && {
      ...promotion.guardian,
      parent_id: requireString(promotion.guardian.parent_id, 'guardian.parent_id'),
      full_name: requireString(promotion.guardian.full_name, 'guardian.full_name'),
    };

    if (guardian) {
      // A guardian record that is already linked to a different login is
      // refused by upsertGuardian, but that write comes after the athlete
      // record and any accounts below.
      await assertGuardianAccountUnchanged({
        organizationId: principal.organizationId,
        parentId: guardian.parent_id,
        accountId: guardian.account_id,
      });

      // Everything guardian provisioning below would refuse, refused now --
      // including an email or account_id that belongs to an existing coach,
      // staff, board or admin account (R5, Jason 2026-09-29: intake refuses
      // it rather than turning that account into a parent login). And the
      // login named for the guardian has to be the one provisioning will
      // actually use: provisioning keeps the login an email already has,
      // ignoring guardian.account_id, and the guardian record used to be
      // linked to guardian.account_id anyway -- any existing account, another
      // family's parent login included, which would then see this child.
      if (guardian.account_id && guardian.email) {
        await assertGuardianLoginProvisionable({
          loginEmail: guardian.email,
          organizationId: principal.organizationId,
          accountIdHint: guardian.account_id,
        });
      }
    }

    const athleteCreatedAt = new Date().toISOString();

    // The login the guardian record ends up linked to, if any. Undefined
    // leaves the record's current link alone.
    let guardianAccountId: string | undefined;

    // One transaction for every write that makes the promotion, under the
    // athlete-login lock writePromotedAthleteRecord takes first: the athlete
    // record, the athlete's login, the guardian's login, record and link, the
    // emergency contact, medical, waiver, assessment, attendance, readiness
    // and coach note rows, the documents, the case status and the audit row.
    // A failure anywhere in it leaves none of them (OD-2026-10-03-002 section
    // 5). Every write in it takes the transaction's client: a pooled write
    // could wait on a row this transaction holds, and Postgres would not see
    // that as a deadlock. The shadow event, research requirement and metric
    // below are written after it commits, as before.
    await withTransaction(async (client) => {
      // A travel waiver in this promotion is a write the competition entry
      // gate reads, so this transaction takes the competition-safety lock --
      // and takes it FIRST, before the athlete-login and consent-set locks
      // the writes below take, because that is the documented lock order
      // (competitionSafetyLock.ts). upsertWaiver takes it again at the waiver
      // insert; advisory locks are re-entrant within a session.
      if (promotion.waiver && isCompetitionGatedWaiverType(promotion.waiver.waiver_type)) {
        await lockCompetitionSafety(client, principal.organizationId, promotion.athlete.athlete_id);
      }

      // The athlete-record checks -- withdrawn; held by a deleted login, on
      // every promotion, account_id or not (OD-2026-09-29-002 item 4, path i);
      // the account_id's refusals -- and the athlete write, in one transaction
      // under the lock the account cleanup also takes, so the cleanup cannot
      // retire this athlete's login in between (path ii). The first write of
      // the promotion; the guardian checks above are reads only.
      await writePromotedAthleteRecord({
        organizationId: principal.organizationId,
        accountId: promotion.athlete.account_id,
        // Locked and re-checked under the transaction: a second promotion of
        // this case waits for this one and is then refused (409).
        intakeCaseId,
        athlete: {
          athlete_id: promotion.athlete.athlete_id,
          full_name: promotion.athlete.full_name,
          dob: promotion.athlete.dob,
          weight_class: promotion.athlete.weight_class,
          gym_status: promotion.athlete.gym_status,
          emergency_contact: promotion.athlete.emergency_contact,
          active_flag: true,
          coach_id: promotion.athlete.coach_id,
          created_at: athleteCreatedAt,
          updated_at: athleteCreatedAt,
        },
      }, client);

      // No credential is set here: athlete.pin was refused before the first
      // write, above.
      if (promotion.athlete.account_id) {
        await createOrUpdateAthleteAccountWithClient(
          client,
          promotion.athlete.account_id,
          promotion.athlete.athlete_id,
          principal.organizationId,
        );
      }

      if (guardian) {
        // guardian.pin, and an account_id without an email, were refused before
        // the first write, above. `&& email` only narrows the type.
        if (guardian.account_id && guardian.email) {
          // The guardian record is linked to the account provisioning wrote --
          // the one that holds guardian.email and is now an active parent in
          // this organization -- never to the payload's account_id read back.
          // The check before the first write makes the two the same; this keeps
          // them the same if the email's account changes in between.
          //
          // refuseRoleChange and refuseDeactivatedLogin: the same refusals as
          // that check, repeated on provisioning's own read and held in its
          // account write, so an account that became a non-parent or was
          // deactivated in between is still refused rather than re-roled or
          // reactivated. A deleted login is refused there for every caller.
          const provisioned = await createOrUpdateMicrosoftStaffAccount({
            loginEmail: guardian.email,
            organizationId: principal.organizationId,
            role: 'parent',
            accountIdHint: guardian.account_id,
            refuseRoleChange: true,
            refuseDeactivatedLogin: true,
          }, client);
          guardianAccountId = provisioned.accountId;
        }

        await upsertGuardian({
          organizationId: principal.organizationId,
          parentId: guardian.parent_id,
          accountId: guardianAccountId,
          fullName: guardian.full_name,
          phone: guardian.phone,
          email: guardian.email,
        }, client);

        await linkGuardianAthlete({
          organizationId: principal.organizationId,
          parentId: guardian.parent_id,
          athleteId: promotion.athlete.athlete_id,
          relationshipToAthlete: guardian.relationship_to_athlete ?? 'guardian',
        }, client);
      }

      if (promotion.emergency_contact) {
        await upsertEmergencyContact({
          organizationId: principal.organizationId,
          athleteId: promotion.athlete.athlete_id,
          fullName: promotion.emergency_contact.full_name,
          relationshipToAthlete: promotion.emergency_contact.relationship_to_athlete,
          phone: promotion.emergency_contact.phone,
          email: promotion.emergency_contact.email,
          isPrimary: promotion.emergency_contact.is_primary,
          notes: promotion.emergency_contact.notes,
        }, client);
      }

      if (promotion.medical) {
        await upsertMedicalIntake({
          organizationId: principal.organizationId,
          athleteId: promotion.athlete.athlete_id,
          conditions: promotion.medical.conditions,
          medications: promotion.medical.medications,
          allergies: promotion.medical.allergies,
          physicianName: promotion.medical.physician_name,
          physicianPhone: promotion.medical.physician_phone,
          clearanceStatus: promotion.medical.clearance_status,
          notes: promotion.medical.notes,
        }, client);
      }

      if (promotion.waiver) {
        await upsertWaiver({
          organizationId: principal.organizationId,
          athleteId: promotion.athlete.athlete_id,
          waiverType: promotion.waiver.waiver_type,
          signedByName: promotion.waiver.signed_by_name,
          signedByRole: promotion.waiver.signed_by_role,
          signedAt: promotion.waiver.signed_at,
          consentVersion: promotion.waiver.consent_version,
          // Checked above, before the first promotion write.
          status: validatedWaiverStatus as WaiverStatus,
          notes: promotion.waiver.notes,
          // The reviewer promoting the case, not the guardian who signed the
          // paper it came from.
          recordedByAccountId: principal.accountId,
        }, client);
      }

      if (promotion.assessment) {
        await createAssessment({
          organizationId: principal.organizationId,
          athleteId: promotion.athlete.athlete_id,
          assessorAccountId: principal.accountId,
          assessmentType: promotion.assessment.assessment_type,
          result: promotion.assessment.result,
        }, client);
      }

      if (promotion.attendance) {
        await createAttendance({
          organizationId: principal.organizationId,
          athleteId: promotion.athlete.athlete_id,
          attendanceDate: promotion.attendance.attendance_date,
          status: promotion.attendance.status,
          notes: promotion.attendance.notes,
        }, client);
      }

      if (promotion.readiness) {
        // Same provenance as the domain-upsert path, and for the same reason:
        // this score comes from a promotion payload an administrator hand-typed,
        // not from any formula. The row says so.
        //
        // score is validatedReadinessScore, not a fresh requireFiniteNumber call
        // against promotion.readiness.score -- the value was already checked
        // above, before the first write in this function ran. Re-validating
        // the same field here would be harmless, but keeping the checked value
        // makes it visible that this call cannot be the one that fails.
        await createReadiness({
          organizationId: principal.organizationId,
          athleteId: promotion.athlete.athlete_id,
          score: validatedReadinessScore as number,
          category: promotion.readiness.category,
          measuredAt: promotion.readiness.measured_at,
          method: 'staff_entered_intake',
          recordedByAccountId: principal.accountId,
        }, client);
      }

      if (promotion.coach_note) {
        await createCoachObservation({
          organizationId: principal.organizationId,
          athleteId: promotion.athlete.athlete_id,
          coachAccountId: principal.accountId,
          authorRole: principal.role,
          noteType: promotion.coach_note.note_type ?? 'intake_observation',
          noteText: promotion.coach_note.note_text,
        }, client);
      }

      await bindIntakeDocumentsToOwner({
        organizationId: principal.organizationId,
        intakeCaseId,
        ownerEntityType: 'athlete',
        ownerEntityId: promotion.athlete.athlete_id,
      }, client);

      await updateIntakeCaseStatus({
        organizationId: principal.organizationId,
        intakeCaseId,
        status: 'promoted',
        reviewedByAccountId: principal.accountId,
        reviewNotes: body.notes,
      }, client);

      await writePilotAuditEvent({
        event_type: 'create',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'intake_case_promotion',
        entity_id: intakeCaseId,
        details: {
          athlete_id: promotion.athlete.athlete_id,
          athlete_account_id: promotion.athlete.account_id ?? null,
          guardian_parent_id: guardian?.parent_id ?? null,
          guardian_account_id: guardianAccountId ?? null,
        },
        shadow_mirror: false,
      }, client);
    });

    const researchFields = buildReviewResearchFields({ action: 'promote', intakeCaseId });

    // The promotion has committed. These three are its shadow record, not
    // part of it, and stay outside the transaction; a failure in one is
    // logged and the promotion still answers 200, since answering 500 for a
    // promotion that happened would invite a retry against a promoted case.
    await afterCommit('shadow_event', () => emitShadowEvent({
      organizationId: principal.organizationId,
      eventName: 'SHADOW_INTAKE_CASE_PROMOTED',
      entityType: 'intake_case',
      entityId: intakeCaseId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      payload: {
        athlete_id: promotion.athlete.athlete_id,
        automation_mode: automationMode,
        research_requirement: researchFields.researchRequirement,
        knowledge_gap: researchFields.knowledgeGap,
        source_status: researchFields.sourceStatus,
        source_verification_state: researchFields.sourceVerificationState,
      },
    }));

    await afterCommit('research_requirement', () => createShadowResearchRequirement({
      organizationId: principal.organizationId,
      sourceEventName: 'SHADOW_INTAKE_CASE_PROMOTED',
      sourceEntityType: 'intake_case',
      sourceEntityId: intakeCaseId,
      researchRequirement: researchFields.researchRequirement,
      knowledgeGap: researchFields.knowledgeGap,
      evidenceLabel: null,
      subjectId: promotion.athlete.athlete_id,
      sourceStatus: researchFields.sourceStatus,
      sourceConfidenceTier: 'SUFFICIENT_FOR_REVIEW',
      sourceVerificationState: researchFields.sourceVerificationState,
      createdByAccountId: principal.accountId,
      createdByRole: principal.role,
      metadata: {
        action: 'promote',
        notes: body.notes ?? '',
        athlete_id: promotion.athlete.athlete_id,
      },
    }));

    await afterCommit('telemetry', () => writeShadowTelemetryEvent({
      organizationId: principal.organizationId,
      metricName: 'shadow.intake.review.promote',
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      dimensions: {
        automation_mode: automationMode,
        has_guardian: Boolean(promotion.guardian),
        athlete_id: promotion.athlete.athlete_id,
      },
    }));

    return NextResponse.json({
      ok: true,
      intake_case_id: intakeCaseId,
      status: 'promoted',
      athlete_id: promotion.athlete.athlete_id,
      guardian_parent_id: guardian?.parent_id ?? null,
    });
  } catch (error) {
    return jsonError(error);
  }
}
