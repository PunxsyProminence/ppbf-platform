import { NextResponse, type NextRequest } from 'next/server';

import { GYM_STATUS_OPTIONS, isGymStatus } from '@/src/shared/athleteConstants';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { createOrUpdateAthleteAccount } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { upsertAthlete } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowAuthority, type ShadowAutomationMode } from '@/src/server/pilot/shadowAuthority';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { buildReviewResearchFields } from '@/src/server/pilot/shadow';
import { createShadowResearchRequirement } from '@/src/server/pilot/shadowResearch';
import { createOrUpdateMicrosoftStaffAccount } from '@/src/server/pilot/staffProvisioning';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';
import {
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
      automation_mode?: ShadowAutomationMode;
    };

    const intakeCaseId = requireString(body.intake_case_id, 'intake_case_id');
    const action = body.action;
    const automationMode = body.automation_mode ?? 'assisted';
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

    if (intakeCase.primary_athlete_id) {
      await assertActorCanAccessAthlete(principal, intakeCase.primary_athlete_id);
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

    if (principal.role !== 'organization_admin') {
      throw new Error('Forbidden: only organization_admin can promote intake');
    }
    if (intakeCase.status !== 'approved') {
      throw new Error('Forbidden: intake must be approved before promotion');
    }
    if (process.env.PPBF_INTAKE_PROMOTION_ENABLED !== 'true') {
      throw new Error('Forbidden: intake promotion is not enabled');
    }

    // Promotion writes straight to pilot.athletes, so it has to answer to the
    // same gym_status allow-list the roster-create route does -- otherwise an
    // approved intake case is a way around it.
    if (!isGymStatus(promotion.athlete.gym_status)) {
      throw new Error(`Request body field gym_status must be one of: ${GYM_STATUS_OPTIONS.join(', ')}`);
    }

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

    // An athlete PIN is deliberately NOT settable at promotion. The account
    // is provisioned with no credential and inactive, and the supported flow
    // sets the PIN afterward through /api/pilot/admin/accounts/pin-reset with
    // mode 'activate' — the same promote → activate → sign-in sequence the
    // E2E gate exercises. This request used to ACCEPT athlete.pin and
    // silently discard it (it landed in createOrUpdateAthleteAccount's
    // ignored legacy parameter), so an administrator believed a credential
    // was set that never was. Refuse it the way the guardian branch below
    // refuses guardian.pin; the prefix keeps jsonError mapping it to a 400.
    if (promotion.athlete.pin) {
      throw new Error(
        'Unsupported athlete.pin: promotion provisions the account without a credential. '
        + 'Set the PIN after promotion via /api/pilot/admin/accounts/pin-reset with mode "activate".',
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
      await createReadiness({
        organizationId: principal.organizationId,
        athleteId: promotion.athlete.athlete_id,
        score: promotion.readiness.score,
        category: promotion.readiness.category,
        measuredAt: promotion.readiness.measured_at,
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
