import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { createAthleteAccount, createParentAccount } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { upsertAthlete } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowAuthority, type ShadowAutomationMode } from '@/src/server/pilot/shadowAuthority';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';
import {
  bindIntakeDocumentsToOwner,
  createAssessment,
  createAttendance,
  createCoachObservation,
  createReadiness,
  getIntakeCaseById,
  linkGuardianAthlete,
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

    if (action === 'reject') {
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
        },
      });

      await writeShadowTelemetryEvent({
        organizationId: principal.organizationId,
        metricName: 'shadow.intake.review.reject',
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        dimensions: {
          automation_mode: automationMode,
        },
      });

      return NextResponse.json({ ok: true, intake_case_id: intakeCaseId, status: 'rejected' });
    }

    if (action === 'approve') {
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
        },
      });

      await writeShadowTelemetryEvent({
        organizationId: principal.organizationId,
        metricName: 'shadow.intake.review.approve',
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        dimensions: {
          automation_mode: automationMode,
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

    if (promotion.athlete.account_id && promotion.athlete.pin) {
      await createAthleteAccount(
        promotion.athlete.account_id,
        promotion.athlete.athlete_id,
        promotion.athlete.pin,
        principal.organizationId,
      );
    }

    if (promotion.guardian) {
      if (promotion.guardian.account_id && promotion.guardian.pin) {
        await createParentAccount(
          promotion.guardian.account_id,
          promotion.guardian.pin,
          principal.organizationId,
        );
      } else if (promotion.guardian.account_id && !promotion.guardian.pin) {
        throw new Error('guardian.pin is required when guardian.account_id is provided');
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
