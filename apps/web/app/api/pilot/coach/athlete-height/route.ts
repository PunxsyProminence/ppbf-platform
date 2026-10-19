import { NextResponse, type NextRequest } from 'next/server';

import { gymDayIso } from '@/src/lib/gymTime';
import { type ActorIdentity, requireRole } from '@/src/server/pilot/access';
import {
  GROWTH_MIN_DAYS,
  HEIGHT_CM_MAX,
  HEIGHT_CM_MIN,
  HEIGHT_ROLES,
  type HeightSummary,
  parseHeightCm,
  parseMeasuredOn,
  parseRequestKey,
  parseSupersedesHeightId,
  readAthleteHeights,
  recordAndSummarize,
} from '@/src/server/pilot/athleteHeights';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Standing height for ONE athlete, coach-entered (OD-2026-10-17-026 (b)).
 *
 *   GET  ?athlete_id=   the readings (newest first, corrected ones marked) and
 *                       the growth rate in cm per year, or null when no two
 *                       readings are GROWTH_MIN_DAYS apart
 *   POST { athlete_id, height_cm, measured_on?, request_key,
 *          supersedes_height_id? }
 *                       records a reading, or a correction of one (a new row;
 *                       the original stays). A retry with the same
 *                       request_key returns the first attempt's row with
 *                       created: false. The audit row is written by the
 *                       module, in the reading's own transaction.
 *
 * Coach-only: authorization lives in athleteHeights.ts (an active staff
 * membership here + the athlete chokepoint); requireRole is the cheap first
 * refusal for roles that can never pass it. No athlete, guardian, board or
 * platform-owner read exists anywhere.
 */

function actorOf(principal: ActorIdentity): ActorIdentity {
  return {
    accountId: principal.accountId,
    role: principal.role,
    organizationId: principal.organizationId,
    athleteId: principal.athleteId,
  };
}

function requireAthleteId(value: unknown): string {
  const athleteId = typeof value === 'string' ? value.trim() : '';
  if (!athleteId) throw new ValidationError('Missing athlete_id.');
  return athleteId;
}

function body(summary: HeightSummary) {
  return {
    ok: true,
    readings: summary.readings,
    latest: summary.latest,
    growth: summary.growth,
    growth_min_days: GROWTH_MIN_DAYS,
    height_cm_min: HEIGHT_CM_MIN,
    height_cm_max: HEIGHT_CM_MAX,
  };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...HEIGHT_ROLES]);
    const athleteId = requireAthleteId(request.nextUrl.searchParams.get('athlete_id'));
    const summary = await readAthleteHeights(actorOf(principal), athleteId);
    return NextResponse.json(body(summary), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...HEIGHT_ROLES]);
    const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ValidationError('The request body must be JSON.');
    }
    const today = gymDayIso();
    if (!today) throw new Error('Unable to resolve the gym date.');
    const athleteId = requireAthleteId(payload.athlete_id);
    const { reading, created, summary } = await recordAndSummarize(actorOf(principal), {
      athleteId,
      heightCm: parseHeightCm(payload.height_cm),
      measuredOn: parseMeasuredOn(payload.measured_on, today),
      requestKey: parseRequestKey(payload.request_key),
      supersedesHeightId: parseSupersedesHeightId(payload.supersedes_height_id),
    });
    // created false: a retry of a save that already landed; nothing new was written.
    return NextResponse.json({ ...body(summary), reading, created }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
