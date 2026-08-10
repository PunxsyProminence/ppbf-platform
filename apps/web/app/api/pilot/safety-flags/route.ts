import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  listOpenSafetyFlags,
  raiseSafetyFlag,
  resolveSafetyFlag,
  type SafetyFlagClass,
  type SafetyFlagResolution,
  type SafetyFlagSeverity,
  type SafetyFlagTriggeredBy,
} from '@/src/server/pilot/safetyFlags';

export const runtime = 'nodejs';

const QUEUE_ROLES = ['organization_admin', 'admin', 'coach'] as const;

// The open-flag queue this migration exists to serve: GET lists open flags
// (filterable by class/severity), POST raises one (human_entry only --
// SHADOW-triggered flags are filed internally, not through this route),
// PATCH resolves one. A note is mandatory on every resolution -- see
// safetyFlags.ts's own header for why: it is the false-positive learning
// signal, not friction.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUEUE_ROLES]);

    const { searchParams } = new URL(request.url);
    const flags = await listOpenSafetyFlags(principal.organizationId, {
      flagClass: (searchParams.get('flag_class') as SafetyFlagClass | null) ?? undefined,
      severity: (searchParams.get('severity') as SafetyFlagSeverity | null) ?? undefined,
      athleteId: searchParams.get('athlete_id') ?? undefined,
    });
    return NextResponse.json({ flags });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUEUE_ROLES]);

    const body = (await request.json()) as {
      athlete_id?: string;
      person_account_id?: string;
      flag_class?: SafetyFlagClass;
      flag_code?: string;
      severity?: SafetyFlagSeverity;
      trigger_detail?: string;
      evidence_basis?: string;
      confidence_note?: string;
      source_activity_id?: string;
      source_reference?: string;
    };

    if (!body.flag_class || !body.flag_code?.trim()) {
      throw new Error('Missing flag_class or flag_code');
    }

    // A human raising a flag through this route is always human_entry --
    // SHADOW's own inference and rule evaluation file flags from server-side
    // code directly, never through this endpoint, so triggered_by is not a
    // client-supplied field here.
    const triggeredBy: SafetyFlagTriggeredBy = 'human_entry';

    const created = await raiseSafetyFlag({
      organizationId: principal.organizationId,
      athleteId: body.athlete_id,
      personAccountId: body.person_account_id,
      flagClass: body.flag_class,
      flagCode: body.flag_code.trim(),
      severity: body.severity,
      triggeredBy,
      triggerDetail: body.trigger_detail,
      evidenceBasis: body.evidence_basis,
      confidenceNote: body.confidence_note,
      sourceActivityId: body.source_activity_id,
      sourceReference: body.source_reference,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'safety_flag',
      entity_id: created.flag_id,
      details: { flag_class: created.flag_class, flag_code: created.flag_code, severity: created.severity },
    });

    return NextResponse.json({ flag: created }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUEUE_ROLES]);

    const body = (await request.json()) as {
      flag_id?: string;
      status?: 'acknowledged' | 'bypassed' | 'upheld' | 'withdrawn';
      resolution?: SafetyFlagResolution;
      coach_note?: string;
    };

    if (!body.flag_id || !body.status || !body.resolution || !body.coach_note?.trim()) {
      throw new Error('Missing flag_id, status, resolution, or coach_note');
    }

    const resolved = await resolveSafetyFlag({
      organizationId: principal.organizationId,
      flagId: body.flag_id,
      status: body.status,
      resolution: body.resolution,
      coachNote: body.coach_note.trim(),
      resolvedByAccountId: principal.accountId,
      resolvedByRole: principal.role,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'safety_flag',
      entity_id: resolved.flag_id,
      details: { status: resolved.status, resolution: resolved.resolution },
    });

    return NextResponse.json({ flag: resolved });
  } catch (error) {
    return jsonError(error);
  }
}
