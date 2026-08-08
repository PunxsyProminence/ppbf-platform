import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { fileIncidentReport } from '@/src/server/pilot/escalationLadder';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { DECISION_LOOP_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

/**
 * Capability #152: THE MISSING "THIS ACTUALLY HAPPENED" REPORT.
 *
 * pilot.shadow_near_misses ("this almost happened") and pilot.safety_gate_evaluations
 * already flow into the escalation ladder (#194), but nothing let a coach or
 * admin retroactively assert real harm/a real violation occurred -- see
 * pilot_slice_postgres_safety_escalations_migration.sql's 'incident' source_type
 * for the full reasoning on why this is a new source_type, not a near-miss
 * or a new table.
 *
 * Read access deliberately reuses the existing escalation ladder
 * (GET /api/pilot/escalations, /admin/escalations) rather than a new list
 * endpoint -- an incident IS an escalation row once filed, and severity is
 * forced to 'high'/'critical' here so it always surfaces at the top of
 * that queue. This route is write-only.
 */
const SEVERITIES = new Set<string>(['high', 'critical']);

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

interface IncidentReportRequestBody {
  athleteId?: unknown;
  description?: unknown;
  severity?: unknown;
  occurredAt?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const body = (await request.json().catch(() => ({}))) as IncidentReportRequestBody;
    if (
      !boundedString(body.athleteId, 300)
      || !boundedString(body.description, 4000)
      || typeof body.severity !== 'string'
      || !SEVERITIES.has(body.severity)
      || (body.occurredAt !== undefined && body.occurredAt !== null && !boundedString(body.occurredAt, 100))
    ) {
      return NextResponse.json(
        { ok: false, error: 'Incident report payload is invalid: athleteId, description, and severity ("high" or "critical") are required.' },
        { status: 400 },
      );
    }

    await assertActorCanAccessAthlete(principal, body.athleteId);

    const escalation = await fileIncidentReport({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      severity: body.severity as 'high' | 'critical',
      reason: body.description,
      reportedByAccountId: principal.accountId,
      reportedByRole: principal.role,
      occurredAt: (body.occurredAt as string | null | undefined) ?? null,
    });

    return NextResponse.json({ ok: true, escalation });
  } catch (error) {
    return jsonError(error);
  }
}
