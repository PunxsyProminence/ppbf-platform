import { NextResponse, type NextRequest } from 'next/server';

import { type ActorIdentity, requireRole } from '@/src/server/pilot/access';
import { getCoachDisplayName } from '@/src/server/pilot/achievements';
import {
  CONTACT_CAP_ROLES,
  CONTACT_STAGES,
  type AthleteContactCapRow,
  type ContactStage,
  isCapSet,
  listContactCapHistory,
  setContactCap,
} from '@/src/server/pilot/athleteContactCaps';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A coach's sparring caps for one athlete (map item 15).
 *
 *   GET  ?athlete_id=   the cap in force (null = no cap set) and its history
 *   POST { athlete_id, highest_allowed_stage, max_hard_open_sessions_per_7_days, note }
 *                       records a new cap; both limits null clears it
 *
 * Coach-set data only: the route stores what a coach chose and reads it back.
 * It proposes no number and computes no score (see athleteContactCaps.ts), and
 * it blocks nothing -- exceeding a cap warns on the entry screen, coach
 * decides (Jason, 2026-10-04: "Warn only").
 *
 * Authorization lives in the module (membership role here + the athlete
 * chokepoint); requireRole is the cheap first refusal for roles that can
 * never pass it.
 */

function actorOf(principal: ActorIdentity): ActorIdentity {
  return {
    accountId: principal.accountId,
    role: principal.role,
    organizationId: principal.organizationId,
    athleteId: principal.athleteId,
  };
}

async function withNames(organizationId: string, rows: AthleteContactCapRow[]) {
  const names = new Map<string, string>();
  for (const id of new Set(rows.map((row) => row.set_by_account_id))) {
    names.set(id, (await getCoachDisplayName(organizationId, id)) ?? 'A coach');
  }
  return rows.map((row) => ({ ...row, set_by_name: names.get(row.set_by_account_id) ?? 'A coach' }));
}

function stageOrNull(value: unknown): ContactStage | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !(CONTACT_STAGES as readonly string[]).includes(value)) {
    throw new ValidationError(`highest_allowed_stage must be one of: ${CONTACT_STAGES.join(', ')}, or empty`);
  }
  return value as ContactStage;
}

function sessionsOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError('max_hard_open_sessions_per_7_days must be a whole number, or empty');
  }
  return value;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...CONTACT_CAP_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) throw new ValidationError('Missing athlete_id');

    // One read: the cap in force IS the newest history row, so the two can
    // never disagree because a write landed between two queries.
    const history = await listContactCapHistory(actorOf(principal), athleteId);
    const named = await withNames(principal.organizationId, history);
    const current = named[0] ?? null;

    return NextResponse.json(
      {
        ok: true,
        cap: isCapSet(current) ? current : null,
        history: named,
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
    requireRole(principal, [...CONTACT_CAP_ROLES]);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) throw new ValidationError('Missing request body');

    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) throw new ValidationError('Missing athlete_id');
    if (body.note !== undefined && typeof body.note !== 'string') {
      throw new ValidationError('note must be text');
    }

    const row = await setContactCap({
      actor: actorOf(principal),
      athleteId,
      highestAllowedStage: stageOrNull(body.highest_allowed_stage),
      maxHardOpenSessionsPer7Days: sessionsOrNull(body.max_hard_open_sessions_per_7_days),
      note: typeof body.note === 'string' ? body.note : '',
    });

    const [named] = await withNames(principal.organizationId, [row]);
    return NextResponse.json({ ok: true, cap: isCapSet(row) ? named : null, written: named });
  } catch (error) {
    return jsonError(error);
  }
}
