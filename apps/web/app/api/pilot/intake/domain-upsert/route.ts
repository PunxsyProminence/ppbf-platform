import { NextResponse, type NextRequest } from 'next/server';

import { assertActiveParentAccount, assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { withTransaction } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  assertShadowAuthority,
  isShadowAutomationMode,
  SHADOW_AUTOMATION_MODES,
  type ShadowAutomationMode,
} from '@/src/server/pilot/shadowAuthority';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';
import { requireWaiverStatus } from '@/src/server/pilot/waiverCompliance';
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
      automation_mode?: unknown;
    };

    const entityType = body.entity_type;
    const athleteId = body.athlete_id?.trim() || '';
    // Validated against the closed vocabulary rather than cast to it. The
    // declared type is erased at runtime, and this value reaches
    // assertShadowAuthority -- whose automatic-actor refusals all compare for
    // exact equality -- before being persisted verbatim into
    // shadow_authority_checks, shadow_events and shadow_telemetry_events, none
    // of which carry a CHECK on the column. shadow/medical-status/route.ts
    // named this route as one of the two unchecked call sites; this is that
    // check. Absent still means 'assisted', unchanged.
    const automationMode: ShadowAutomationMode = body.automation_mode === undefined
      ? 'assisted'
      : (body.automation_mode as ShadowAutomationMode);
    if (!isShadowAutomationMode(automationMode)) {
      throw new Error(
        `Unsupported automation_mode: must be one of ${SHADOW_AUTOMATION_MODES.join(', ')}`,
      );
    }
    if (!entityType || !athleteId || !body.payload) {
      throw new Error('Missing entity_type, athlete_id, or payload');
    }
    // Held in a const so the narrowing above survives into the transaction
    // callback below.
    const payload = body.payload;

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

    // Attaching a guardian to an athlete grants that guardian's account
    // ongoing read access to the athlete's training holds, safety-gate
    // outcomes, and staff messages (see guardianAthleteIds). The athlete
    // side is already checked above via assertActorCanAccessAthlete; this
    // branch additionally requires organization_admin (not coach -- no
    // shipped coach workflow calls this today, so narrowing it costs no
    // real functionality) and, when an account_id is supplied, requires
    // it actually be an active parent-role account in this organization,
    // so a link can't be minted onto an arbitrary or wrong-family account.
    //
    // These refusals and their one read run here, ahead of the
    // transaction: assertActiveParentAccount reads through the pool, and a
    // request that held its transaction's connection while waiting for a
    // second one could starve the pool against itself under load.
    let guardianLink: { parentId: string; guardianAccountId: string | undefined } | null = null;
    if (entityType === 'guardian_link') {
      requireRole(principal, ['organization_admin']);

      const parentId = asString(payload.parent_id);
      if (!parentId) {
        throw new Error('Missing parent_id for guardian link');
      }

      const guardianAccountId = typeof payload.account_id === 'string' ? payload.account_id : undefined;
      if (guardianAccountId) {
        await assertActiveParentAccount(principal.organizationId, guardianAccountId, 'account_id');
      }
      guardianLink = { parentId, guardianAccountId };
    }

    // ONE TRANSACTION for the record and the three rows that account for it.
    //
    // These used to be four or five separate autocommit statements. The record
    // committed first; a failure on the audit row, the shadow event or the
    // metric after it then answered 500 for a write that had already happened.
    // The coach's page kept the draft and showed a failure, the coach pressed
    // send again, and the family read the same message twice -- with the first
    // copy possibly having no audit row at all. Now, for a record or
    // accounting statement that fails before commit, the transaction rolls
    // every one of these writes back.
    //
    // The authority check and the access check stay above this on purpose: a
    // refused request must still leave its shadow_authority_checks row.
    //
    // NOT CLOSED HERE, and both can still end in a duplicate on resend: a
    // COMMIT whose acknowledgement is lost or indeterminate (the data may
    // exist although this route answers 500), and a successful write whose
    // HTTP response never reaches the browser. Both need a request key from
    // the page, which is a separate change.
    const entityId = await withTransaction(async (client) => {
      let entityId = '';

      if (entityType === 'emergency_contact') {
        entityId = await upsertEmergencyContact({
          organizationId: principal.organizationId,
          athleteId,
          fullName: asString(payload.full_name),
          relationshipToAthlete: asString(payload.relationship_to_athlete, 'guardian'),
          phone: asString(payload.phone),
          email: typeof payload.email === 'string' ? payload.email : undefined,
          isPrimary: Boolean(payload.is_primary ?? true),
          notes: typeof payload.notes === 'string' ? payload.notes : undefined,
        }, client);
      } else if (entityType === 'medical') {
        entityId = await upsertMedicalIntake({
          organizationId: principal.organizationId,
          athleteId,
          conditions: typeof payload.conditions === 'string' ? payload.conditions : undefined,
          medications: typeof payload.medications === 'string' ? payload.medications : undefined,
          allergies: typeof payload.allergies === 'string' ? payload.allergies : undefined,
          physicianName: typeof payload.physician_name === 'string' ? payload.physician_name : undefined,
          physicianPhone: typeof payload.physician_phone === 'string' ? payload.physician_phone : undefined,
          clearanceStatus: typeof payload.clearance_status === 'string' ? payload.clearance_status : undefined,
          notes: typeof payload.notes === 'string' ? payload.notes : undefined,
        }, client);
      } else if (entityType === 'waiver') {
        entityId = await upsertWaiver({
          organizationId: principal.organizationId,
          athleteId,
          waiverType: asString(payload.waiver_type, 'general'),
          signedByName: asString(payload.signed_by_name),
          signedByRole: asString(payload.signed_by_role, 'guardian'),
          signedAt: asString(payload.signed_at, new Date().toISOString()),
          consentVersion: asString(payload.consent_version, 'v1'),
          // Held to pilot_waivers_status_check's vocabulary before the write, so
          // a bad value is a 400 naming the field rather than a 500 from the
          // constraint. Absent still means 'signed', unchanged; null or any
          // other non-vocabulary value is refused instead of becoming 'signed'.
          status: requireWaiverStatus(payload.status, 'payload.status', 'signed'),
          notes: typeof payload.notes === 'string' ? payload.notes : undefined,
          // signed_by_name is whatever the caller typed off the paper form. This
          // is the account that typed it -- the only party to this row the
          // platform can actually identify.
          recordedByAccountId: principal.accountId,
        }, client);
      } else if (entityType === 'assessment') {
        entityId = await createAssessment({
          organizationId: principal.organizationId,
          athleteId,
          assessorAccountId: principal.accountId,
          assessmentType: asString(payload.assessment_type, 'intake_assessment'),
          result: (payload.result as Record<string, unknown>) || {},
        }, client);
      } else if (entityType === 'attendance') {
        entityId = await createAttendance({
          organizationId: principal.organizationId,
          athleteId,
          attendanceDate: asString(payload.attendance_date, new Date().toISOString().slice(0, 10)),
          status: asString(payload.status, 'present'),
          notes: typeof payload.notes === 'string' ? payload.notes : undefined,
        }, client);
      } else if (entityType === 'readiness') {
        // A readiness score entered here is typed by a member of staff during
        // intake review -- nothing computes it. That is recorded on the row
        // rather than left to be inferred, and the account that typed it is
        // recorded with it, so "where did this number come from" has an answer
        // that does not depend on reading this file.
        entityId = await createReadiness({
          organizationId: principal.organizationId,
          athleteId,
          score: requireFiniteNumber(payload.score, 'payload.score'),
          category: asString(payload.category, 'general'),
          measuredAt: asString(payload.measured_at, new Date().toISOString()),
          method: 'staff_entered_intake',
          recordedByAccountId: principal.accountId,
        }, client);
      } else if (entityType === 'coach_note') {
        entityId = await createCoachObservation({
          organizationId: principal.organizationId,
          athleteId,
          coachAccountId: principal.accountId,
          authorRole: principal.role,
          noteType: asString(payload.note_type, 'coach_observation'),
          noteText: asString(payload.note_text),
        }, client);
      } else if (guardianLink) {
        const { parentId, guardianAccountId } = guardianLink;
        await upsertGuardian({
          organizationId: principal.organizationId,
          parentId,
          accountId: guardianAccountId,
          fullName: asString(payload.full_name, 'Guardian'),
          phone: typeof payload.phone === 'string' ? payload.phone : undefined,
          email: typeof payload.email === 'string' ? payload.email : undefined,
        }, client);

        await linkGuardianAthlete({
          organizationId: principal.organizationId,
          parentId,
          athleteId,
          relationshipToAthlete: asString(payload.relationship_to_athlete, 'guardian'),
        }, client);
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
      }, client);

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
      }, client);

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
      }, client);

      return entityId;
    });

    return NextResponse.json({ ok: true, entity_type: entityType, entity_id: entityId, athlete_id: athleteId });
  } catch (error) {
    return jsonError(error);
  }
}
