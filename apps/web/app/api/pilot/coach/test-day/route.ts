import { NextResponse, type NextRequest } from 'next/server';

import { gymDayIso } from '@/src/lib/gymTime';
import { type ActorIdentity, requireRole } from '@/src/server/pilot/access';
import { HEIGHT_ROLES, heightAccessibleAthleteIds } from '@/src/server/pilot/athleteHeights';
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
 *                       writes every filled cell and its audit rows in one
 *                       transaction, or nothing; a retry of the same
 *                       request_key writes nothing new, says how many were
 *                       already saved, and names any cell an earlier attempt
 *                       saved that this form no longer carries
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

    if (body.action !== undefined) throw new ValidationError("action must be 'accessible_athletes', or omitted to save.");

    const today = gymDayIso();
    if (!today) throw new Error('Unable to resolve the gym date.');
    // The audit rows (the save's and each height's) are written by
    // recordTestDay in the same transaction as the results.
    const result = await recordTestDay(actor, parseTestDay(body, today));
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
