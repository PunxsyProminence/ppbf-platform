import { NextResponse, type NextRequest } from 'next/server';

import { type ActorIdentity, requireRole } from '@/src/server/pilot/access';
import { getCoachDisplayName } from '@/src/server/pilot/achievements';
import {
  MINOR_LIMIT_ROLES,
  MINOR_LIMIT_TYPES,
  type AthleteMinorLimitRow,
  isLimitSet,
  isMinorLimitType,
  minorLimitAccessibleAthleteIds,
  readAthleteMinorLimits,
  setMinorLimit,
} from '@/src/server/pilot/athleteMinorLimits';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A coach's limits for one minor (OD-2026-10-06-024 ruling 2).
 *
 *   GET  ?athlete_id=   whether the athlete is a minor (dob rule), the limit in
 *                       force per type (null = no limit set) and the history
 *   POST { action: 'accessible_athletes', athlete_ids }
 *                       of these ids, the ones this caller may open
 *   POST { athlete_id, limit_type, value, note }
 *                       records a new limit of ONE type; value null clears it.
 *                       `value` must be PRESENT (null to clear): a body that
 *                       omits it is refused, so a partial or stale client can
 *                       never clear a limit by accident. For the two numeric
 *                       types value is a number (an empty string is refused,
 *                       not read as a clear: an untouched number field must
 *                       not clear a limit); for supervision it is text, and
 *                       "" clears it.
 *
 * Coach-set data only: the route stores what a coach chose and reads it back.
 * It proposes no number and computes no score (see athleteMinorLimits.ts).
 *
 * Authorization lives in the module (membership role here + the athlete
 * chokepoint); requireRole is the cheap first refusal for roles that can
 * never pass it.
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

type NamedRow = AthleteMinorLimitRow & { set_by_name: string };

async function withNames(organizationId: string, rows: AthleteMinorLimitRow[]): Promise<NamedRow[]> {
  const names = new Map<string, string>();
  for (const id of new Set(rows.map((row) => row.set_by_account_id))) {
    names.set(id, (await getCoachDisplayName(organizationId, id)) ?? 'A coach');
  }
  return rows.map((row) => ({ ...row, set_by_name: names.get(row.set_by_account_id) ?? 'A coach' }));
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MINOR_LIMIT_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) throw new ValidationError('Missing athlete_id');

    const reading = await readAthleteMinorLimits(actorOf(principal), athleteId);
    const history = await withNames(principal.organizationId, reading.history);
    const byId = new Map(history.map((row) => [row.limit_id, row]));
    const limits: Record<string, NamedRow | null> = {};
    for (const type of MINOR_LIMIT_TYPES) {
      const row = reading.limits[type];
      // The row in force is within the history window in every realistic case;
      // when it is not, name the setter the same way.
      limits[type] = row ? byId.get(row.limit_id) ?? (await withNames(principal.organizationId, [row]))[0] : null;
    }

    return NextResponse.json(
      {
        ok: true,
        athlete_is_minor: reading.athlete_is_minor,
        limit_types: MINOR_LIMIT_TYPES,
        limits,
        history,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...MINOR_LIMIT_ROLES]);

    const parsed: unknown = await request.json().catch(() => null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationError('Request body must be a JSON object');
    }
    const body = parsed as Record<string, unknown>;

    if ('action' in body) {
      if (body.action !== 'accessible_athletes') {
        throw new ValidationError('action must be accessible_athletes, or omitted to set a limit');
      }
      const ids = body.athlete_ids;
      if (!Array.isArray(ids) || ids.length > MAX_ROSTER_IDS || !ids.every((id) => typeof id === 'string')) {
        throw new ValidationError(`athlete_ids must be a list of at most ${MAX_ROSTER_IDS} ids`);
      }
      const accessible = await minorLimitAccessibleAthleteIds(actorOf(principal), ids as string[]);
      return NextResponse.json(
        { ok: true, athlete_ids: [...accessible] },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) throw new ValidationError('Missing athlete_id');
    if (!isMinorLimitType(body.limit_type)) {
      throw new ValidationError(`limit_type must be one of: ${MINOR_LIMIT_TYPES.join(', ')}`);
    }
    if (!('value' in body)) {
      throw new ValidationError('value is required (send null to clear the limit)');
    }
    if (body.note !== undefined && typeof body.note !== 'string') {
      throw new ValidationError('note must be text');
    }

    let valueNumber: number | null = null;
    let valueText: string | null = null;
    if (body.limit_type === 'supervision') {
      const value = body.value === '' ? null : body.value;
      if (value !== null && typeof value !== 'string') {
        throw new ValidationError('supervision value must be text, or null to clear it');
      }
      valueText = value;
    } else {
      const value = body.value;
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new ValidationError('value must be a number, or null to clear the limit');
      }
      valueNumber = value;
    }

    const row = await setMinorLimit({
      actor: actorOf(principal),
      athleteId,
      limitType: body.limit_type,
      valueNumber,
      valueText,
      note: typeof body.note === 'string' ? body.note : '',
    });

    const [named] = await withNames(principal.organizationId, [row]);
    return NextResponse.json({ ok: true, limit: isLimitSet(row) ? named : null, written: named });
  } catch (error) {
    return jsonError(error);
  }
}
