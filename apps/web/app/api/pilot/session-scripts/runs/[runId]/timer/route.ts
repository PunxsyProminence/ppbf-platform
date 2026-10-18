import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  ROUND_TIMER_LIMITS,
  adjustRoundTimer,
  configureRoundTimerRevised,
  moveRoundTimerRevised,
  readOwnRoundTimerRevised,
  type RoundTimerAction,
  type RoundTimerAdjustment,
} from '@/src/server/pilot/roundTimers';
import { SessionScriptRunError } from '@/src/server/pilot/sessionScriptRuns';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

// The round timer of a live run (WO-N1-03): read it, configure it, and start, pause, resume or end
// it. Who may: the same roles as the run route beside this one, and the module underneath allows
// only the coach delivering the run (another coach's run answers 404, as on the run route).
//
// ONE ACTION PER REQUEST, NAMED EXPLICITLY, as on the run route. The client never sends a time,
// a state or a round: the server writes the instants with the database clock and derives the rest.
// +30 SEC and REPEAT (add_30, repeat) also carry the revision the screen last read, which every
// answer here includes beside the timer, read or written in the same statement as that timer; a
// stale one is refused (roundTimers.ts adjustRoundTimer).
const ROLES = ['coach', 'admin', 'organization_admin'] as const;
const MOVES = ['start', 'pause', 'resume', 'end'] as const;
const ADJUSTMENTS = ['add_30', 'repeat'] as const;
const ACTIONS = ['configure', ...MOVES, ...ADJUSTMENTS] as const;

function badRequest(code: string) {
  return NextResponse.json({ error: code }, { status: 400 });
}

function boundedInt(value: unknown, limits: { min: number; max: number }): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= limits.min && value <= limits.max ? value : null;
}

async function runIdOf(context: RouteContext): Promise<string | null> {
  const { runId } = await context.params;
  return runId?.trim() ? runId.trim() : null;
}

function failure(error: unknown) {
  if (error instanceof SessionScriptRunError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return jsonError(error);
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ROLES]);
    const runId = await runIdOf(context);
    if (!runId) return badRequest('run_id');
    const read = await readOwnRoundTimerRevised(principal.organizationId, principal.accountId, runId);
    return NextResponse.json(
      { timer: read?.timer ?? null, revision: read?.revision },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ROLES]);
    const runId = await runIdOf(context);
    if (!runId) return badRequest('run_id');

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest('INVALID_BODY');
    }
    const record = body as Record<string, unknown>;
    const action = record.action;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
      return badRequest(`action:expected one of ${ACTIONS.join('|')}`);
    }

    const isAdjustment = (ADJUSTMENTS as readonly string[]).includes(action);
    const allowed =
      action === 'configure'
        ? ['action', 'round_seconds', 'rest_seconds', 'rounds_total']
        : isAdjustment
          ? ['action', 'revision']
          : ['action'];
    const extras = Object.keys(record).filter((key) => !allowed.includes(key));
    if (extras.length > 0) {
      return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
    }

    const { organizationId, accountId } = principal;
    if (action === 'configure') {
      const roundSeconds = boundedInt(record.round_seconds, ROUND_TIMER_LIMITS.roundSeconds);
      if (roundSeconds === null) return badRequest('round_seconds');
      const restSeconds = boundedInt(record.rest_seconds, ROUND_TIMER_LIMITS.restSeconds);
      if (restSeconds === null) return badRequest('rest_seconds');
      const roundsTotal = boundedInt(record.rounds_total, ROUND_TIMER_LIMITS.roundsTotal);
      if (roundsTotal === null) return badRequest('rounds_total');
      return NextResponse.json(await configureRoundTimerRevised(organizationId, accountId, runId, { roundSeconds, restSeconds, roundsTotal }));
    }

    if (isAdjustment) {
      if (typeof record.revision !== 'string' || !/^\d{1,20}$/.test(record.revision)) return badRequest('revision');
      const adjusted = await adjustRoundTimer(organizationId, accountId, runId, action as RoundTimerAdjustment, record.revision);
      return NextResponse.json(adjusted);
    }

    return NextResponse.json(await moveRoundTimerRevised(organizationId, accountId, runId, action as RoundTimerAction));
  } catch (error) {
    return failure(error);
  }
}
