import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  SESSION_CLASS_MESSAGES,
  SessionRunClassError,
  markSessionNoShowsAbsent,
  setSessionRunClass,
} from '@/src/server/pilot/sessionRunClass';
import {
  SessionScriptRunError,
  finishSessionScriptRun,
  keyedSessionScriptRunAction,
  moveSessionScriptRunCursor,
  pauseSessionScriptRun,
  resumeSessionScriptRun,
  setSessionScriptRunShowOnWall,
  type RunActionAsked,
} from '@/src/server/pilot/sessionScriptRuns';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

// Moving a live run: cursor, pause, resume, finish, the coach's "Show on TV" switch, and the class
// (D4, OD-2026-10-21-002): tie_class { class_id } ties the session to today's class and copies the
// standing marks to its register; { class_id: null } unties it (the register marks stay).
// mark_no_shows is the End Session offer on a tied session (OD-2026-10-21-004 ruling 3): one tap
// marks every signed-up athlete with no mark Absent. Never automatic: only this action does it.
//
// ONE ACTION PER REQUEST, NAMED EXPLICITLY. The alternative -- a PATCH that accepts current_block_id
// or run_state directly -- would let a client set run_state to 'completed' while leaving ended_at
// unset, or move the cursor of a run it does not own by including a field. Naming the action means
// the server decides which columns each one is allowed to touch.
//
// The module underneath returns 404 for a run belonging to another coach, identical to a run that
// does not exist, so this route cannot be used to discover other coaches' run ids.
const ACTIONS = ['advance', 'pause', 'resume', 'finish', 'show_on_wall', 'tie_class', 'mark_no_shows'] as const;
// No platform_owner, as on the sibling runs route (OD-2026-10-08-003 PLAN-3).
const RUN_ROLES = ['coach', 'admin', 'organization_admin'] as const;
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

// The no-shows tap names its athletes and their class, and may carry a request key (W4 item 7,
// OVERWATCH 7160191377): text of 1 to 200 characters, never blank, with no NUL and no unpaired
// surrogate (PostgreSQL's jsonb cannot store either in the audit record, and the refused write would
// read as a server fault and be sent again), at most NO_SHOWS_MAX names (a class is created with a
// capacity of at most 200; the limit leaves room).
const NO_SHOWS_MAX = 500;
const TEXT_MAX = 200;
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isIdText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= TEXT_MAX && !value.includes(NUL)
    && !LONE_SURROGATE.test(value);
}

// Every action may carry a request key (W4 item 7, OVERWATCH 7170099938): a kept save sends the same
// key on every resend, and the server records it with the action, so whether an earlier send landed
// is decided by that key alone. Absent: sent once, as before.
const KEY_FIELD = 'request_key';

function requestKeyOf(record: Record<string, unknown>): string | null | 'INVALID' {
  if (record.request_key === undefined) return null;
  return isIdText(record.request_key) ? record.request_key : 'INVALID';
}

const badKey = () => badRequest(`request_key:expected text of 1 to ${TEXT_MAX} characters`);

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
    requireRole(principal, [...RUN_ROLES]);

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
    const requestKey = requestKeyOf(record);
    if (requestKey === 'INVALID') return badKey();
    // A keyed run action: the answer says whether this send wrote it or an earlier one had.
    const keyed = async (asked: RunActionAsked) => {
      const answer = await keyedSessionScriptRunAction({ organizationId, accountId, role: principal.role }, runId, requestKey as string, asked);
      return NextResponse.json(answer.replayed ? { run: answer.run, replayed: true } : { run: answer.run });
    };

    switch (action as RunAction) {
      case 'advance': {
        // Takes a target block rather than "next": a coach who skips a block or goes back to
        // re-teach one is doing something ordinary, and the client does not own block order.
        if (typeof record.to_block_id !== 'string' || record.to_block_id.trim() === '') {
          return badRequest('to_block_id');
        }
        const extras = Object.keys(record).filter((k) => !['action', 'to_block_id', KEY_FIELD].includes(k));
        if (extras.length > 0) {
          return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
        }
        if (requestKey !== null) return await keyed({ action: 'advance', toBlockId: record.to_block_id.trim() });
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
        const extras = Object.keys(record).filter((k) => k !== 'action' && k !== KEY_FIELD);
        if (extras.length > 0) {
          return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
        }
        if (requestKey !== null) return await keyed({ action: action === 'pause' ? 'pause' : 'resume' });
        const run =
          action === 'pause'
            ? await pauseSessionScriptRun(organizationId, accountId, runId)
            : await resumeSessionScriptRun(organizationId, accountId, runId);
        return NextResponse.json({ run });
      }

      case 'show_on_wall': {
        // An explicit target value, not a toggle: a retried "turn it off" must never turn it back
        // on. Only a real boolean is accepted -- "false" as a string would be truthy somewhere.
        if (typeof record.show !== 'boolean') {
          return badRequest('show:expected true|false');
        }
        const extras = Object.keys(record).filter((k) => !['action', 'show', KEY_FIELD].includes(k));
        if (extras.length > 0) {
          return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
        }
        if (requestKey !== null) return await keyed({ action: 'show_on_wall', show: record.show });
        const run = await setSessionScriptRunShowOnWall(organizationId, accountId, runId, record.show);
        return NextResponse.json({ run });
      }

      case 'tie_class': {
        if (record.class_id !== null && (typeof record.class_id !== 'string' || record.class_id.trim() === '')) {
          return badRequest('class_id:expected a class id or null');
        }
        const extras = Object.keys(record).filter((k) => !['action', 'class_id', KEY_FIELD].includes(k));
        if (extras.length > 0) {
          return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
        }
        const tie = await setSessionRunClass(
          { organizationId, accountId, role: principal.role, athleteId: principal.athleteId },
          runId,
          typeof record.class_id === 'string' ? record.class_id.trim() : null,
          requestKey,
        );
        return NextResponse.json(tie);
      }

      case 'mark_no_shows': {
        const extras = Object.keys(record).filter((k) => !['action', 'athlete_ids', 'class_id', KEY_FIELD, 'page_id'].includes(k));
        if (extras.length > 0) {
          return badRequest(`UNEXPECTED_FIELD:${extras.sort().join(',')}`);
        }
        // The athletes the screen showed when the coach tapped: a resend acts on these, never on a
        // set worked out again later.
        const athleteIds: unknown = record.athlete_ids;
        if (!Array.isArray(athleteIds) || athleteIds.length === 0 || athleteIds.length > NO_SHOWS_MAX || !athleteIds.every(isIdText)) {
          return badRequest(`athlete_ids:expected 1 to ${NO_SHOWS_MAX} athlete ids`);
        }
        // The class the screen showed them for.
        if (!isIdText(record.class_id)) {
          return badRequest(`class_id:expected text of 1 to ${TEXT_MAX} characters`);
        }
        // The page a kept tap was made on (#2182 round 12): recorded with the tap.
        if (record.page_id !== undefined && !isIdText(record.page_id)) {
          return badRequest(`page_id:expected text of 1 to ${TEXT_MAX} characters`);
        }
        const result = await markSessionNoShowsAbsent(
          { organizationId, accountId, role: principal.role, athleteId: principal.athleteId },
          runId,
          { athleteIds, classId: record.class_id, requestKey, pageId: record.page_id ?? null },
        );
        return NextResponse.json(result);
      }

      case 'finish': {
        const extras = Object.keys(record).filter(
          (k) =>
            k !== 'action'
            && k !== 'run_state'
            && k !== KEY_FIELD
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

        const input = {
          runState,
          blocksCompleted,
          athletesPresent,
          resetProtocolUsed: (record.reset_protocol_used as boolean | undefined) ?? undefined,
          deviationNote: deviationNote ?? undefined,
          whatWorked: whatWorked ?? undefined,
          whatDidNot: whatDidNot ?? undefined,
        } as const;
        if (requestKey !== null) return await keyed({ action: 'finish', input });
        const run = await finishSessionScriptRun(organizationId, accountId, runId, input);
        return NextResponse.json({ run });
      }

      default:
        return badRequest('action');
    }
  } catch (error) {
    if (error instanceof SessionScriptRunError || error instanceof SessionRunClassError) {
      const message = SESSION_CLASS_MESSAGES.get(error.message);
      return NextResponse.json(message ? { error: error.message, message } : { error: error.message }, { status: error.status });
    }
    return jsonError(error);
  }
}
