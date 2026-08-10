import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  SessionScriptRunError,
  finishSessionScriptRun,
  moveSessionScriptRunCursor,
  pauseSessionScriptRun,
  resumeSessionScriptRun,
} from '@/src/server/pilot/sessionScriptRuns';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

// Moving a live run: cursor, pause, resume, finish.
//
// ONE ACTION PER REQUEST, NAMED EXPLICITLY. The alternative -- a PATCH that accepts current_block_id
// or run_state directly -- would let a client set run_state to 'completed' while leaving ended_at
// unset, or move the cursor of a run it does not own by including a field. Naming the action means
// the server decides which columns each one is allowed to touch.
//
// The module underneath returns 404 for a run belonging to another coach, identical to a run that
// does not exist, so this route cannot be used to discover other coaches' run ids.
const ACTIONS = ['advance', 'pause', 'resume', 'finish'] as const;
type RunAction = (typeof ACTIONS)[number];

const FINISH_OPTIONAL_FIELDS = [
  'blocks_completed',
  'athletes_present',
  'reset_protocol_used',
  'deviation_note',
  'what_worked',
  'what_did_not',
] as const;

function badRequest(code: string) {
  return NextResponse.json({ error: code }, { status: 400 });
}

function optionalNonNegativeInt(value: unknown): number | null | 'INVALID' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return 'INVALID';
  }
  return value;
}

function optionalString(value: unknown): string | null | 'INVALID' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'INVALID';
  return value;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'platform_owner']);

    const { runId } = await context.params;
    if (!runId?.trim()) {
      return badRequest('run_id');
    }

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest('INVALID_BODY');
    }
    const record = body as Record<string, unknown>;

    const action = record.action;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
      return badRequest(`action:expected one of ${ACTIONS.join('|')}`);
    }

    const { organizationId, accountId } = principal;

    switch (action as RunAction) {
      case 'advance': {
        // Takes a target block rather than "next": a coach who skips a block or goes back to
        // re-teach one is doing something ordinary, and the client does not own block order.
        if (typeof record.to_block_id !== 'string' || record.to_block_id.trim() === '') {
          return badRequest('to_block_id');
        }
        const extras = Object.keys(record).filter((k) => !['action', 'to_block_id'].includes(k));
        if (extras.length > 0) {
          return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
        }
        const run = await moveSessionScriptRunCursor(
          organizationId,
          accountId,
          runId,
          record.to_block_id.trim(),
        );
        return NextResponse.json({ run });
      }

      case 'pause':
      case 'resume': {
        const extras = Object.keys(record).filter((k) => k !== 'action');
        if (extras.length > 0) {
          return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
        }
        const run =
          action === 'pause'
            ? await pauseSessionScriptRun(organizationId, accountId, runId)
            : await resumeSessionScriptRun(organizationId, accountId, runId);
        return NextResponse.json({ run });
      }

      case 'finish': {
        const extras = Object.keys(record).filter(
          (k) =>
            k !== 'action'
            && k !== 'run_state'
            && !(FINISH_OPTIONAL_FIELDS as readonly string[]).includes(k),
        );
        if (extras.length > 0) {
          return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
        }

        // 'completed' and 'abandoned' are both real outcomes and the coach picks. A session cut
        // short by an injury or an empty room is not a completed delivery, and recording it as one
        // would put it into the history as if the plan had been taught.
        const runState = record.run_state ?? 'completed';
        if (runState !== 'completed' && runState !== 'abandoned') {
          return badRequest('run_state:expected completed|abandoned');
        }

        const blocksCompleted = optionalNonNegativeInt(record.blocks_completed);
        if (blocksCompleted === 'INVALID') return badRequest('blocks_completed');
        const athletesPresent = optionalNonNegativeInt(record.athletes_present);
        if (athletesPresent === 'INVALID') return badRequest('athletes_present');

        if (
          record.reset_protocol_used !== undefined
          && record.reset_protocol_used !== null
          && typeof record.reset_protocol_used !== 'boolean'
        ) {
          return badRequest('reset_protocol_used');
        }

        const deviationNote = optionalString(record.deviation_note);
        if (deviationNote === 'INVALID') return badRequest('deviation_note');
        const whatWorked = optionalString(record.what_worked);
        if (whatWorked === 'INVALID') return badRequest('what_worked');
        const whatDidNot = optionalString(record.what_did_not);
        if (whatDidNot === 'INVALID') return badRequest('what_did_not');

        const run = await finishSessionScriptRun(organizationId, accountId, runId, {
          runState,
          blocksCompleted,
          athletesPresent,
          resetProtocolUsed: (record.reset_protocol_used as boolean | undefined) ?? undefined,
          deviationNote: deviationNote ?? undefined,
          whatWorked: whatWorked ?? undefined,
          whatDidNot: whatDidNot ?? undefined,
        });
        return NextResponse.json({ run });
      }

      default:
        return badRequest('action');
    }
  } catch (error) {
    if (error instanceof SessionScriptRunError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return jsonError(error);
  }
}
