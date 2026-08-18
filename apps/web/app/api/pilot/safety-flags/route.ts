import { NextResponse, type NextRequest } from 'next/server';

import { accessibleAthleteIds, assertCoachAssignedToAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { NotFoundError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  getSafetyFlagById,
  listOpenSafetyFlags,
  raiseSafetyFlag,
  resolveSafetyFlag,
  type SafetyFlagClass,
  type SafetyFlagResolution,
  type SafetyFlagRow,
  type SafetyFlagSeverity,
  type SafetyFlagTriggeredBy,
} from '@/src/server/pilot/safetyFlags';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

export const runtime = 'nodejs';

const QUEUE_ROLES = ['organization_admin', 'admin', 'coach'] as const;

// The open-flag queue this migration exists to serve: GET lists open flags
// (filterable by class/severity), POST raises one (human_entry only --
// SHADOW-triggered flags are filed internally, not through this route),
// PATCH resolves one. A note is mandatory on every resolution -- see
// safetyFlags.ts's own header for why: it is the false-positive learning
// signal, not friction.
//
// ATHLETE SCOPE (the fix for the 2026-08-18 safety audit's CRITICAL finding
// on this route). Role membership in QUEUE_ROLES was the ONLY check here, so
// any coach could read the whole gym's open queue -- including
// medical_clearance_missing and concussion_rest_period, which name a child
// and a medical condition -- raise a flag against any child in the
// organization, and bypass an open flag on a child they have no standing on.
//
// The rule is the one the sibling training-holds route already enforces, and
// the authority behind it is the same owner decision (2026-08-06): a coach
// reaches an athlete only through assertCoachAssignedToAthlete, which admits
// the coach of record AND the holder of an active coverage grant.
// organization_admin/admin are deliberately NOT scoped that way -- they
// already see and act across the whole organization, and narrowing them here
// would break the admin flag board this queue exists to serve.
//
// Where each surface applies it:
// - GET names an athlete -> the same explicit assignment gate as
//   training-holds' GET, so a coach probing one child gets a clean 403.
// - GET without an athlete (the coach's own board) -> the org read is
//   filtered per row against accessibleAthleteIds, the batched form of the
//   same gate, mirroring how shadowJobQueue.getJobsForActor narrows a page of
//   rows to the subjects the actor may see. A coach keeps a working board;
//   it now contains only their own athletes.
// - POST/PATCH -> the gate before the write, with PATCH reporting "not
//   yours" exactly as it reports "not real".
function isQueueCoach(principal: PilotPrincipal): boolean {
  // requireRole has already narrowed the caller to QUEUE_ROLES, so anything
  // that is not a coach here is an organization admin (or the legacy 'admin'
  // spelling of one) and is intentionally left unscoped.
  return principal.role === 'coach';
}

/**
 * The rows of an organization-wide flag read a coach may actually see:
 * flags whose athlete they are assigned to or hold coverage for, plus flags
 * raised about the coach's own account.
 *
 * Person-subject flags about ANYONE ELSE are dropped rather than shown. A
 * flag's subject may be an account rather than an athlete row, and athletes
 * have accounts too -- so admitting person-subject rows on role alone would
 * reopen the same disclosure through the other column.
 */
async function coachVisibleFlags(
  principal: PilotPrincipal,
  flags: SafetyFlagRow[],
): Promise<SafetyFlagRow[]> {
  const athleteIds = flags
    .map((flag) => flag.athlete_id)
    .filter((athleteId): athleteId is string => athleteId !== null);
  const accessible = athleteIds.length > 0
    ? await accessibleAthleteIds(principal, athleteIds)
    : new Set<string>();

  return flags.filter((flag) => (
    flag.athlete_id !== null
      ? accessible.has(flag.athlete_id)
      : flag.person_account_id === principal.accountId
  ));
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...QUEUE_ROLES]);

    const { searchParams } = new URL(request.url);
    const athleteId = searchParams.get('athlete_id')?.trim() || undefined;

    // A coach naming one athlete is refused explicitly, the same way
    // training-holds' GET refuses it: the request is about a specific child,
    // so silently returning an empty list would misreport "no open flags" for
    // a child who may well have one.
    if (isQueueCoach(principal) && athleteId) {
      await assertCoachAssignedToAthlete(principal.accountId, athleteId, principal.organizationId);
    }

    const flags = await listOpenSafetyFlags(principal.organizationId, {
      flagClass: (searchParams.get('flag_class') as SafetyFlagClass | null) ?? undefined,
      severity: (searchParams.get('severity') as SafetyFlagSeverity | null) ?? undefined,
      athleteId,
    });

    return NextResponse.json({
      flags: isQueueCoach(principal) ? await coachVisibleFlags(principal, flags) : flags,
    });
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

    const athleteId = body.athlete_id?.trim() || undefined;

    // A coach may only raise a flag against an athlete they stand on, and
    // must name that athlete: a person_account_id subject is admin-only here
    // BECAUSE an athlete has an account too, so a coach allowed to file
    // against an arbitrary account could file against any child in the gym
    // through that column while the athlete gate below never ran. A coach who
    // needs a flag raised about an adult (or about an athlete outside their
    // own) asks an organization admin -- fail closed, since the flag becomes
    // part of a child's safety record either way.
    if (isQueueCoach(principal)) {
      if (!athleteId) {
        throw new Error('Missing athlete_id: a coach may only raise a flag against an athlete they are assigned to');
      }
      if (body.person_account_id?.trim()) {
        // Refused rather than dropped: a coach naming an athlete they stand on
        // AND an arbitrary account would still be filing a record against that
        // account, past a gate that only checked the athlete half.
        throw new Error('Unsupported person_account_id: a coach raises a flag against their athlete, not against an account');
      }
      await assertCoachAssignedToAthlete(principal.accountId, athleteId, principal.organizationId);
    }

    // A human raising a flag through this route is always human_entry --
    // SHADOW's own inference and rule evaluation file flags from server-side
    // code directly, never through this endpoint, so triggered_by is not a
    // client-supplied field here.
    const triggeredBy: SafetyFlagTriggeredBy = 'human_entry';

    const created = await raiseSafetyFlag({
      organizationId: principal.organizationId,
      athleteId,
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

    // Resolving includes status='bypassed' -- standing a blocking flag down
    // and letting a child train through it -- so the authority check needs
    // the flag's subject BEFORE resolveSafetyFlag runs. "Not yours" and "not
    // real" are reported identically (the same 404 a missing flag has always
    // produced, from resolveSafetyFlag's own NotFoundError), so a coach cannot
    // enumerate the gym's flag ids through this endpoint.
    const flagNotFound = () => new NotFoundError(
      'That safety flag does not exist.',
      'SAFETY_FLAG_NOT_FOUND',
    );

    if (isQueueCoach(principal)) {
      const existing = await getSafetyFlagById(principal.organizationId, body.flag_id);
      if (!existing || !existing.athlete_id) {
        // A person-subject flag is admin-only to resolve for the same reason
        // it is admin-only to raise -- and a coach must never be the one to
        // stand down a flag about their own conduct.
        throw flagNotFound();
      }
      try {
        await assertCoachAssignedToAthlete(principal.accountId, existing.athlete_id, principal.organizationId);
      } catch {
        throw flagNotFound();
      }
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
