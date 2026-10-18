import { NextResponse, type NextRequest } from 'next/server';

import { gymDayIso } from '@/src/lib/gymTime';
import { type ActorIdentity, requireRole } from '@/src/server/pilot/access';
import { HEIGHT_ROLES, heightAccessibleAthleteIds } from '@/src/server/pilot/athleteHeights';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { TEST_DAY_MAX_ROWS, parseTestDay, recordTestDay } from '@/src/server/pilot/testDay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The quarterly test day (OD-2026-10-17-026): height, jumps and the 20-m
 * shuttle for a group, on one date, in one save.
 *
 *   POST { action: 'accessible_athletes', athlete_ids }
 *                       of these ids, the ones this caller may record for
 *   POST { administered_on?, request_key, rows: [{ athlete_id, height_cm?,
 *          cmj_cm?, broad_cm?, shuttle_level?, shuttle_number? }] }
 *                       writes every filled cell in one transaction, or
 *                       nothing; a retry of the same request_key writes
 *                       nothing new and says how many were already saved
 *
 * Authorization lives in testDay.ts / athleteHeights.ts (an active staff seat
 * here + the athlete chokepoint for every row); requireRole is the cheap first
 * refusal for roles that can never pass it.
 */

const MAX_ROSTER_IDS = 1000;

function actorOf(principal: ActorIdentity): ActorIdentity {
  return {
    accountId: principal.accountId,
    role: principal.role,
    organizationId: principal.organizationId,
    athleteId: principal.athleteId,
  };
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...HEIGHT_ROLES]);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('The request body must be JSON.');
    const actor = actorOf(principal);

    if (body.action === 'accessible_athletes') {
      const ids = body.athlete_ids;
      if (!Array.isArray(ids) || ids.length > MAX_ROSTER_IDS || !ids.every((id) => typeof id === 'string' && id.length > 0)) {
        throw new ValidationError(`athlete_ids must be up to ${MAX_ROSTER_IDS} athlete ids.`);
      }
      const allowed = await heightAccessibleAthleteIds(actor, ids as string[]);
      return NextResponse.json(
        { ok: true, athlete_ids: (ids as string[]).filter((id) => allowed.has(id)), max_rows: TEST_DAY_MAX_ROWS },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    }

    const today = gymDayIso();
    if (!today) throw new Error('Unable to resolve the gym date.');
    const input = parseTestDay(body, today);
    const result = await recordTestDay(actor, input);
    // One save, one audit row; a retry that wrote nothing records nothing.
    // Counts only, no measurements: shadow_mirror false, as for heights.
    if (result.written > 0) {
      await writePilotAuditEvent({
        event_type: 'create',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'test_day',
        entity_id: input.requestKey,
        details: {
          administered_on: input.administeredOn,
          athlete_ids: input.rows.map((row) => row.athleteId),
          cells_written: result.written,
        },
        shadow_mirror: false,
      });
    }
    return NextResponse.json({ ok: true, ...result, administered_on: input.administeredOn }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
