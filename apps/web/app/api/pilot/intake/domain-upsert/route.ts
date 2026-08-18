import { NextResponse, type NextRequest } from 'next/server';

import { assertActiveParentAccount, assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowAuthority, type ShadowAutomationMode } from '@/src/server/pilot/shadowAuthority';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';
import {
  createAssessment,
  createAttendance,
  createCoachObservation,
  createReadiness,
  linkGuardianAthlete,
  upsertEmergencyContact,
  upsertGuardian,
  upsertMedicalIntake,
  upsertWaiver,
} from '@/src/server/pilot/intake';

export const runtime = 'nodejs';


function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// pilot.readiness.score is NOT NULL and read straight into a coach-facing
// triage board (readinessBoard.ts). Number(value || 0) used to turn a
// missing or malformed score into a real, stored 0 -- which the board reads
// as RED, "adjust the plan", for an athlete nobody actually measured. A
// missing reading must stay missing, not become a fabricated alarm.
function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // "Unsupported" is jsonError's recognized prefix for a client-supplied
    // field that is missing, wrong-typed, or otherwise invalid (see
    // "Unsupported guardian.pin" elsewhere) -- anything else falls into the
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

    const body = (await request.json()) as {
      entity_type?: 'emergency_contact' | 'medical' | 'waiver' | 'assessment' | 'attendance' | 'readiness' | 'coach_note' | 'guardian_link';
      athlete_id?: string;
      payload?: Record<string, unknown>;
      automation_mode?: ShadowAutomationMode;
    };

    const entityType = body.entity_type;
    const athleteId = body.athlete_id?.trim() || '';
    const automationMode = body.automation_mode ?? 'assisted';
    if (!entityType || !athleteId || !body.payload) {
      throw new Error('Missing entity_type, athlete_id, or payload');
    }

    await assertShadowAuthority({
      actor: principal,
      organizationId: principal.organizationId,
      action: `intake.domain_upsert.${entityType}`,
      automationMode,
      confidenceTier: 'SUFFICIENT_FOR_REVIEW',
      lowRisk: true,
      reversible: true,
      withinApprovedOptions: true,
      restrictionConflict: false,
      metadata: {
        athlete_id: athleteId,
      },
    });

    await assertActorCanAccessAthlete(principal, athleteId);

    let entityId = '';

    if (entityType === 'emergency_contact') {
      entityId = await upsertEmergencyContact({
        organizationId: principal.organizationId,
        athleteId,
        fullName: asString(body.payload.full_name),
        relationshipToAthlete: asString(body.payload.relationship_to_athlete, 'guardian'),
        phone: asString(body.payload.phone),
        email: typeof body.payload.email === 'string' ? body.payload.email : undefined,
        isPrimary: Boolean(body.payload.is_primary ?? true),
        notes: typeof body.payload.notes === 'string' ? body.payload.notes : undefined,
      });
    } else if (entityType === 'medical') {
      entityId = await upsertMedicalIntake({
        organizationId: principal.organizationId,
        athleteId,
        conditions: typeof body.payload.conditions === 'string' ? body.payload.conditions : undefined,
        medications: typeof body.payload.medications === 'string' ? body.payload.medications : undefined,
        allergies: typeof body.payload.allergies === 'string' ? body.payload.allergies : undefined,
        physicianName: typeof body.payload.physician_name === 'string' ? body.payload.physician_name : undefined,
        physicianPhone: typeof body.payload.physician_phone === 'string' ? body.payload.physician_phone : undefined,
        clearanceStatus: typeof body.payload.clearance_status === 'string' ? body.payload.clearance_status : undefined,
        notes: typeof body.payload.notes === 'string' ? body.payload.notes : undefined,
      });
    } else if (entityType === 'waiver') {
      entityId = await upsertWaiver({
        organizationId: principal.organizationId,
        athleteId,
        waiverType: asString(body.payload.waiver_type, 'general'),
        signedByName: asString(body.payload.signed_by_name),
        signedByRole: asString(body.payload.signed_by_role, 'guardian'),
        signedAt: asString(body.payload.signed_at, new Date().toISOString()),
        consentVersion: asString(body.payload.consent_version, 'v1'),
        status: asString(body.payload.status, 'signed'),
        notes: typeof body.payload.notes === 'string' ? body.payload.notes : undefined,
      });
    } else if (entityType === 'assessment') {
      entityId = await createAssessment({
        organizationId: principal.organizationId,
        athleteId,
        assessorAccountId: principal.accountId,
        assessmentType: asString(body.payload.assessment_type, 'intake_assessment'),
        result: (body.payload.result as Record<string, unknown>) || {},
      });
    } else if (entityType === 'attendance') {
      entityId = await createAttendance({
        organizationId: principal.organizationId,
        athleteId,
        attendanceDate: asString(body.payload.attendance_date, new Date().toISOString().slice(0, 10)),
        status: asString(body.payload.status, 'present'),
        notes: typeof body.payload.notes === 'string' ? body.payload.notes : undefined,
      });
    } else if (entityType === 'readiness') {
      // A readiness score entered here is typed by a member of staff during
      // intake review -- nothing computes it. That is recorded on the row
      // rather than left to be inferred, and the account that typed it is
      // recorded with it, so "where did this number come from" has an answer
      // that does not depend on reading this file.
      entityId = await createReadiness({
        organizationId: principal.organizationId,
        athleteId,
        score: requireFiniteNumber(body.payload.score, 'payload.score'),
        category: asString(body.payload.category, 'general'),
        measuredAt: asString(body.payload.measured_at, new Date().toISOString()),
        method: 'staff_entered_intake',
        recordedByAccountId: principal.accountId,
      });
    } else if (entityType === 'coach_note') {
      entityId = await createCoachObservation({
        organizationId: principal.organizationId,
        athleteId,
        coachAccountId: principal.accountId,
        noteType: asString(body.payload.note_type, 'coach_observation'),
        noteText: asString(body.payload.note_text),
      });
    } else if (entityType === 'guardian_link') {
      // Attaching a guardian to an athlete grants that guardian's account
      // ongoing read access to the athlete's training holds, safety-gate
      // outcomes, and staff messages (see guardianAthleteIds). The athlete
      // side is already checked above via assertActorCanAccessAthlete; this
      // branch additionally requires organization_admin (not coach -- no
      // shipped coach workflow calls this today, so narrowing it costs no
      // real functionality) and, when an account_id is supplied, requires
      // it actually be an active parent-role account in this organization,
      // so a link can't be minted onto an arbitrary or wrong-family account.
      requireRole(principal, ['organization_admin']);

      const parentId = asString(body.payload.parent_id);
      if (!parentId) {
        throw new Error('Missing parent_id for guardian link');
      }

      const guardianAccountId = typeof body.payload.account_id === 'string' ? body.payload.account_id : undefined;
      if (guardianAccountId) {
        await assertActiveParentAccount(principal.organizationId, guardianAccountId, 'account_id');
      }

      await upsertGuardian({
        organizationId: principal.organizationId,
        parentId,
        accountId: guardianAccountId,
        fullName: asString(body.payload.full_name, 'Guardian'),
        phone: typeof body.payload.phone === 'string' ? body.payload.phone : undefined,
        email: typeof body.payload.email === 'string' ? body.payload.email : undefined,
      });

      await linkGuardianAthlete({
        organizationId: principal.organizationId,
        parentId,
        athleteId,
        relationshipToAthlete: asString(body.payload.relationship_to_athlete, 'guardian'),
      });
      entityId = `${parentId}:${athleteId}`;
    } else {
      throw new Error('Unsupported entity_type');
    }

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: `intake_${entityType}`,
      entity_id: entityId || athleteId,
      details: { athlete_id: athleteId },
      shadow_mirror: false,
    });

    await emitShadowEvent({
      organizationId: principal.organizationId,
      eventName: 'SHADOW_INTAKE_DOMAIN_UPSERTED',
      entityType: `intake_${entityType}`,
      entityId: entityId || athleteId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      payload: {
        athlete_id: athleteId,
        automation_mode: automationMode,
      },
    });

    await writeShadowTelemetryEvent({
      organizationId: principal.organizationId,
      metricName: 'shadow.intake.domain_upsert',
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      dimensions: {
        entity_type: entityType,
        automation_mode: automationMode,
        athlete_id: athleteId,
      },
    });

    return NextResponse.json({ ok: true, entity_type: entityType, entity_id: entityId, athlete_id: athleteId });
  } catch (error) {
    return jsonError(error);
  }
}
