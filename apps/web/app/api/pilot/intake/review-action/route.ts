import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { createOrUpdateAthleteAccount } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { upsertAthlete } from '@/src/server/pilot/entities';
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
import { createOrUpdateMicrosoftStaffAccount } from '@/src/server/pilot/staffProvisioning';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';
import {
  assertActorCanAccessIntakeCase,
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
    // is NULL on every row (no code path writes it; see resolveIntakeCaseAuthority
    // in intake.ts), so the athlete check never ran and requireRole admitted every
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
    // createReadiness call where it used to live. This route has no
    // transaction wrapping its promotion writes -- by the time readiness was
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

    const athleteCreatedAt = new Date().toISOString();

    await upsertAthlete(principal.organizationId, {
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
    });

    // An athlete PIN is deliberately NOT settable at promotion. The account is
    // provisioned with no credential and inactive, and NOBODY sets a PIN for
    // an athlete any more: an administrator issues a one-time activation code
    // and the athlete redeems it, choosing a PIN only they know. That is the
    // promote → issue code → redeem → sign-in sequence the E2E gate exercises.
    //
    // This request used to ACCEPT athlete.pin and silently discard it (it
    // landed in createOrUpdateAthleteAccount's ignored legacy parameter), so
    // an administrator believed a credential was set that never was. Refuse it
    // the way the guardian branch below refuses guardian.pin; the prefix keeps
    // jsonError mapping it to a 400.
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

    if (promotion.athlete.account_id) {
      await createOrUpdateAthleteAccount(
        promotion.athlete.account_id,
        promotion.athlete.athlete_id,
        principal.organizationId,
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

      if (promotion.guardian.account_id) {
        if (!promotion.guardian.email) {
          throw new Error('Missing guardian.email: required when guardian.account_id is provided');
        }

        await createOrUpdateMicrosoftStaffAccount({
          loginEmail: promotion.guardian.email,
          organizationId: principal.organizationId,
          role: 'parent',
          accountIdHint: promotion.guardian.account_id,
        });
      }

      await upsertGuardian({
        organizationId: principal.organizationId,
        parentId: promotion.guardian.parent_id,
        accountId: promotion.guardian.account_id,
        fullName: promotion.guardian.full_name,
        phone: promotion.guardian.phone,
        email: promotion.guardian.email,
      });

      await linkGuardianAthlete({
        organizationId: principal.organizationId,
        parentId: promotion.guardian.parent_id,
        athleteId: promotion.athlete.athlete_id,
        relationshipToAthlete: promotion.guardian.relationship_to_athlete ?? 'guardian',
      });
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
      });
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
      });
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
        status: promotion.waiver.status,
        notes: promotion.waiver.notes,
      });
    }

    if (promotion.assessment) {
      await createAssessment({
        organizationId: principal.organizationId,
        athleteId: promotion.athlete.athlete_id,
        assessorAccountId: principal.accountId,
        assessmentType: promotion.assessment.assessment_type,
        result: promotion.assessment.result,
      });
    }

    if (promotion.attendance) {
      await createAttendance({
        organizationId: principal.organizationId,
        athleteId: promotion.athlete.athlete_id,
        attendanceDate: promotion.attendance.attendance_date,
        status: promotion.attendance.status,
        notes: promotion.attendance.notes,
      });
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
      });
    }

    if (promotion.coach_note) {
      await createCoachObservation({
        organizationId: principal.organizationId,
        athleteId: promotion.athlete.athlete_id,
        coachAccountId: principal.accountId,
        noteType: promotion.coach_note.note_type ?? 'intake_observation',
        noteText: promotion.coach_note.note_text,
      });
    }

    await bindIntakeDocumentsToOwner({
      organizationId: principal.organizationId,
      intakeCaseId,
      ownerEntityType: 'athlete',
      ownerEntityId: promotion.athlete.athlete_id,
    });

    await updateIntakeCaseStatus({
      organizationId: principal.organizationId,
      intakeCaseId,
      status: 'promoted',
      reviewedByAccountId: principal.accountId,
      reviewNotes: body.notes,
    });

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
        guardian_parent_id: promotion.guardian?.parent_id ?? null,
        guardian_account_id: promotion.guardian?.account_id ?? null,
      },
      shadow_mirror: false,
    });

    const researchFields = buildReviewResearchFields({ action: 'promote', intakeCaseId });

    await emitShadowEvent({
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
    });

    await createShadowResearchRequirement({
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
    });

    await writeShadowTelemetryEvent({
      organizationId: principal.organizationId,
      metricName: 'shadow.intake.review.promote',
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      dimensions: {
        automation_mode: automationMode,
        has_guardian: Boolean(promotion.guardian),
        athlete_id: promotion.athlete.athlete_id,
      },
    });

    return NextResponse.json({
      ok: true,
      intake_case_id: intakeCaseId,
      status: 'promoted',
      athlete_id: promotion.athlete.athlete_id,
      guardian_parent_id: promotion.guardian?.parent_id ?? null,
    });
  } catch (error) {
    return jsonError(error);
  }
}
