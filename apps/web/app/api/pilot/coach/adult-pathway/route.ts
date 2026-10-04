import { NextResponse, type NextRequest } from 'next/server';

import { type ActorIdentity, requireRole } from '@/src/server/pilot/access';
import { getCoachDisplayName } from '@/src/server/pilot/achievements';
import {
  PATHWAY_WRITE_ROLES,
  confirmPathwayCheckpoint,
  getAthletePathway,
  grantMinorAllowance,
  pathwayAccessibleAthleteIds,
  placeAthleteOnStage,
  withdrawMinorAllowance,
  withdrawPathwayCheckpoint,
} from '@/src/server/pilot/adultPathway';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The adult pathway for one athlete (map item 17, B2a).
 *
 *   GET  ?athlete_id=   eligibility, the live allowance, current placement,
 *                       recent placements and live goal ticks, with staff
 *                       display names in place of account ids
 *   POST { action, ... }
 *     accessible_athletes  { athlete_ids }         of these, the ones this caller may open
 *     place                { athlete_id, stage_key, note? }
 *     confirm              { athlete_id, stage_key, goal_key }
 *     withdraw_checkpoint  { athlete_id, goal_key }
 *     grant_allowance      { athlete_id, reason }   reason required
 *     withdraw_allowance   { athlete_id }          ends a minor's placement
 *
 * Every rule lives in adultPathway.ts: who may write (OD-2026-10-04-019),
 * who may be placed (OD-2026-10-04-010), what switching the allowance off
 * does (OD-2026-10-04-018), and "flag and freeze" when a placed athlete
 * stops being eligible. The route parses, hands the SESSION's identity down,
 * and names people. Nothing here computes or proposes a stage.
 */

const MAX_ROSTER_IDS = 1000;
const ACTIONS = [
  'accessible_athletes',
  'place',
  'confirm',
  'withdraw_checkpoint',
  'grant_allowance',
  'withdraw_allowance',
] as const;

function actorOf(principal: ActorIdentity): ActorIdentity {
  return {
    accountId: principal.accountId,
    role: principal.role,
    organizationId: principal.organizationId,
    athleteId: principal.athleteId,
  };
}

function text(body: Record<string, unknown>, key: string, required: boolean): string {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`Missing ${key}`);
    return '';
  }
  if (typeof value !== 'string') throw new ValidationError(`${key} must be text`);
  if (required && !value.trim()) throw new ValidationError(`Missing ${key}`);
  return value;
}

async function namer(organizationId: string) {
  const cache = new Map<string, string>();
  return async (accountId: string | null): Promise<string | null> => {
    if (!accountId) return null;
    if (!cache.has(accountId)) cache.set(accountId, (await getCoachDisplayName(organizationId, accountId)) ?? 'A coach');
    return cache.get(accountId) ?? 'A coach';
  };
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...PATHWAY_WRITE_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) throw new ValidationError('Missing athlete_id');

    const pathway = await getAthletePathway(actorOf(principal), athleteId);
    const name = await namer(principal.organizationId);
    const placement = async <T extends { set_by_account_id: string; ended_by_account_id: string | null }>(row: T) => ({
      ...row,
      set_by_name: await name(row.set_by_account_id),
      ended_by_name: await name(row.ended_by_account_id),
    });

    return NextResponse.json(
      {
        ok: true,
        eligibility: pathway.eligibility,
        allowance: pathway.allowance
          ? { ...pathway.allowance, granted_by_name: await name(pathway.allowance.granted_by_account_id) }
          : null,
        current: pathway.current ? await placement(pathway.current) : null,
        history: await Promise.all(pathway.history.map(placement)),
        checkpoints: await Promise.all(
          pathway.checkpoints.map(async (c) => ({ ...c, confirmed_by_name: await name(c.confirmed_by_account_id) })),
        ),
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
    requireRole(principal, [...PATHWAY_WRITE_ROLES]);

    const parsed: unknown = await request.json().catch(() => null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ValidationError('Request body must be a JSON object');
    }
    const body = parsed as Record<string, unknown>;
    const action = body.action;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
      throw new ValidationError(`action must be one of: ${ACTIONS.join(', ')}`);
    }
    const actor = actorOf(principal);

    if (action === 'accessible_athletes') {
      const ids = body.athlete_ids;
      if (!Array.isArray(ids) || ids.length > MAX_ROSTER_IDS || !ids.every((id) => typeof id === 'string')) {
        throw new ValidationError(`athlete_ids must be a list of at most ${MAX_ROSTER_IDS} ids`);
      }
      const accessible = await pathwayAccessibleAthleteIds(actor, ids as string[]);
      return NextResponse.json({ ok: true, athlete_ids: [...accessible] }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const athleteId = text(body, 'athlete_id', true).trim();
    switch (action) {
      case 'place': {
        const placement = await placeAthleteOnStage({
          actor, athleteId, stageKey: text(body, 'stage_key', true), note: text(body, 'note', false),
        });
        return NextResponse.json({ ok: true, placement });
      }
      case 'confirm': {
        const checkpoint = await confirmPathwayCheckpoint({
          actor, athleteId, stageKey: text(body, 'stage_key', true), goalKey: text(body, 'goal_key', true),
        });
        return NextResponse.json({ ok: true, checkpoint });
      }
      case 'withdraw_checkpoint':
        await withdrawPathwayCheckpoint({ actor, athleteId, goalKey: text(body, 'goal_key', true) });
        return NextResponse.json({ ok: true });
      case 'grant_allowance': {
        const allowance = await grantMinorAllowance({ actor, athleteId, reason: text(body, 'reason', true) });
        return NextResponse.json({ ok: true, allowance });
      }
      default: {
        const result = await withdrawMinorAllowance({ actor, athleteId });
        return NextResponse.json({ ok: true, ended_placement_id: result.endedPlacementId });
      }
    }
  } catch (error) {
    return jsonError(error);
  }
}
