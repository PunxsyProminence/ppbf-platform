import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { STAFF_CREDENTIAL_ROLES } from '@/src/server/pilot/clearanceRegister';
import {
  createCoachDevelopmentActivity,
  createCoachDevelopmentGoal,
  listCoachDevelopmentActivities,
  listCoachDevelopmentGoals,
  updateCoachDevelopmentGoal,
  COACH_DEVELOPMENT_GOAL_STATUSES,
  type CoachDevelopmentGoalPatch,
  type CoachDevelopmentGoalStatus,
} from '@/src/server/pilot/coachDevelopment';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A coach's OWN development record: what they are trying to get better at,
 * and the development work they did.
 *
 * THE ROUTE TAKES NO ACCOUNT ID, ON ANY METHOD. Every read and every write is
 * about `principal.accountId` -- the caller reads and writes their own record
 * and nobody else's. This is the shape /api/pilot/profile/photo and
 * /api/pilot/coach/credentials already use, and it is deliberate rather than
 * incidental: whether a head coach may see their staff's development goals is
 * a real product question that nobody has answered, and building the
 * cross-coach read first and gating it afterwards is how that question gets
 * answered by accident. There is no `account_id` parameter to forget to
 * check, because there is no parameter.
 *
 * WHO MAY CALL IT: the same set that may hold a staff credential. This
 * surface sits on the same Coach Development tab as the credential list, and
 * narrowing it further would mean a volunteer who spends a Saturday at a
 * coaching clinic has nowhere to record it while their SafeSport certificate
 * sits in the panel beside it. No role is broadened by reusing this set: a
 * caller still only ever reaches their own rows.
 *
 * NOTHING HERE IS A CREDENTIAL. Clearances live in pilot.person_clearances,
 * are uploaded through /api/pilot/coach/credentials and are moved to
 * 'current' only by an administrator through /api/pilot/admin/credentials.
 * Rows written here are SELF-ENTERED AND UNVERIFIED, carry no status, no
 * verifier, no expiry and no document, and confer nothing. A coach logging
 * "SafeSport refresher" here has made a note to themselves; they have not
 * been cleared for anything, and no read of this route may be presented as
 * though they had.
 *
 * NOTHING IS COMPUTED. No progress figure, no percentage, no completion
 * ratio, no score, no level, and no total of duration_minutes -- see
 * coachDevelopment.ts and the migration header for why an hours total in
 * particular is refused. The Coach Goals tab this feeds shipped with
 * hardcoded progress bars showing the same "68%" to every coach who logged
 * in; they were deleted as fake personal data, and this route adds no way
 * back to them.
 *
 * NO AUDIT EVENT IS WRITTEN, and that is the same call #767 made for
 * development blocks: the audit vocabulary is a registered, separately
 * governed list, and inventing an entry on the way past is not this slice's
 * to do. What these rows record is a person's notes about their own
 * learning -- not an action taken on anybody else, which is what the audit
 * log exists to hold.
 */

const DEVELOPMENT_ROLES = STAFF_CREDENTIAL_ROLES;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * `duration_minutes` from a request body.
 *
 * Absent and null both mean "not recorded" and reach the module as null. A
 * value that is present but is not a number is REFUSED rather than coerced:
 * `Number("two hours")` is NaN and `Number("")` is 0, and both would land in
 * the database as something the coach did not type.
 */
function parseDurationMinutes(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed)) {
      throw new ValidationError(
        'duration_minutes must be a whole number of minutes, or omitted.',
        'COACH_DEVELOPMENT_ACTIVITY_INVALID',
      );
    }
    return parsed;
  }
  throw new ValidationError(
    'duration_minutes must be a whole number of minutes, or omitted.',
    'COACH_DEVELOPMENT_ACTIVITY_INVALID',
  );
}

function parseStatus(value: unknown): CoachDevelopmentGoalStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string'
    || !(COACH_DEVELOPMENT_GOAL_STATUSES as readonly string[]).includes(value)) {
    // Named explicitly rather than passed through, so a body carrying an
    // unknown status cannot reach the data layer and cannot quietly become
    // the default.
    throw new ValidationError(
      `Unknown goal status '${String(value)}'.`,
      'COACH_DEVELOPMENT_GOAL_INVALID',
    );
  }
  return value as CoachDevelopmentGoalStatus;
}

/**
 * A goal id, null when deliberately absent, or a refusal.
 *
 * null and undefined both mean "not toward a particular goal" -- an activity
 * without one is ordinary. Anything else that is not a string is a client
 * bug, and answering it with a silent null hides the bug inside a 201.
 */
function parseOptionalGoalId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ValidationError(
      'goal_id must be a string, or omitted for an activity not toward a particular goal.',
      'COACH_DEVELOPMENT_ACTIVITY_INVALID',
    );
  }
  return value.trim() ? value.trim() : null;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DEVELOPMENT_ROLES]);

    const [goals, activities] = await Promise.all([
      listCoachDevelopmentGoals(principal.organizationId, principal.accountId),
      listCoachDevelopmentActivities(principal.organizationId, principal.accountId),
    ]);

    return NextResponse.json(
      { ok: true, goals, activities },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DEVELOPMENT_ROLES]);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      throw new ValidationError('A JSON body is required.', 'COACH_DEVELOPMENT_INVALID');
    }

    const kind = optionalString(body.kind);
    if (kind !== 'goal' && kind !== 'activity') {
      throw new ValidationError(
        'kind must be "goal" or "activity".',
        'COACH_DEVELOPMENT_INVALID',
      );
    }

    if (kind === 'goal') {
      const goal = await createCoachDevelopmentGoal({
        // The organization and the author are the SESSION's, never the
        // body's. A client-supplied organization_id or account_id is not
        // read here at all -- there is nowhere for one to be read into.
        organizationId: principal.organizationId,
        coachAccountId: principal.accountId,
        title: optionalString(body.title) ?? '',
        developmentFocus: optionalString(body.development_focus) ?? '',
        targetOn: optionalString(body.target_on) ?? null,
        status: parseStatus(body.status),
      });
      return NextResponse.json({ ok: true, goal }, { status: 201 });
    }

    const activity = await createCoachDevelopmentActivity({
      organizationId: principal.organizationId,
      coachAccountId: principal.accountId,
      title: optionalString(body.title) ?? '',
      provider: optionalString(body.provider),
      occurredOn: optionalString(body.occurred_on) ?? '',
      durationMinutes: parseDurationMinutes(body.duration_minutes),
      notes: optionalString(body.notes),
      /* A non-string goal_id is REFUSED, not dropped. optionalString mapped
         42 or {} to undefined and then to null, so an activity a client meant
         to attach came back 201 with goal_id null -- indistinguishable in the
         response from "not toward a particular goal". body.status two fields
         up refuses an unrecognised value for exactly this reason: so it
         cannot quietly become the default. */
      goalId: parseOptionalGoalId(body.goal_id),
    });

    if (!activity) {
      // The named goal is not one of this coach's. Indistinguishable from a
      // goal id that never existed, deliberately: a 404 that meant "exists,
      // but not yours" would let any coach probe for their colleagues' goals.
      return NextResponse.json({ ok: false, error: 'Goal not found.' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, activity }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DEVELOPMENT_ROLES]);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      throw new ValidationError('A JSON body is required.', 'COACH_DEVELOPMENT_INVALID');
    }

    const goalId = optionalString(body.goal_id)?.trim();
    if (!goalId) {
      throw new ValidationError('goal_id is required.', 'COACH_DEVELOPMENT_GOAL_INVALID');
    }

    /* Only what a coach may correct. The organization, the owner and
       created_at are absent from this type rather than guarded after the
       fact: a goal does not change gyms, does not change owner, and did not
       stop having been written when it was.

       `target_on` distinguishes ABSENT from an explicit null, because the
       two mean different things -- leave the deadline alone, versus remove
       it -- and a coach who can never remove a date they no longer want is
       stuck with it. */
    const patch: CoachDevelopmentGoalPatch = {};
    if (body.title !== undefined) patch.title = optionalString(body.title) ?? '';
    if (body.development_focus !== undefined) {
      patch.developmentFocus = optionalString(body.development_focus) ?? '';
    }
    if (body.target_on !== undefined) {
      /* '' CLEARS THE DATE. WHITESPACE IS A MISTAKE, NOT A CLEARING.
         This read `target?.trim() ? target : null`, which mapped '   ' to
         null and erased a date the coach had set, with a 200 and no message
         -- while POST refused the identical value with a 400. The same input
         meant two different things depending on which verb carried it, and
         the destructive reading was the silent one. A trailing space from a
         mobile keyboard was enough. */
      const target = optionalString(body.target_on);
      if (target !== undefined && target !== '' && !target.trim()) {
        // Refused HERE rather than left to the module, so the route's own
        // parsing holds the rule its sibling fields hold, and the caller gets
        // the same 400 POST gives for the same value.
        throw new ValidationError(
          'target_on must be a calendar date written as YYYY-MM-DD, or empty to clear it.',
          'COACH_DEVELOPMENT_GOAL_INVALID',
        );
      }
      patch.targetOn = target === undefined || target === '' ? null : target;
    }
    if (body.status !== undefined) patch.status = parseStatus(body.status);

    const goal = await updateCoachDevelopmentGoal(
      principal.organizationId,
      principal.accountId,
      goalId,
      patch,
    );

    if (!goal) {
      return NextResponse.json({ ok: false, error: 'Goal not found.' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, goal });
  } catch (error) {
    return jsonError(error);
  }
}
