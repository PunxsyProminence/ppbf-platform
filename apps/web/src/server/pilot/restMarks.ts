import { randomUUID } from 'node:crypto';

import { gymDayIso } from '../../lib/gymTime';
import { type ActorIdentity, assertActorCanAccessAthlete } from './access';
import { writePilotAuditEvent } from './audit';
import { query, queryOne, withTransaction } from './db';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import { LOAD_JUMP_PRIOR_WEEKS } from './weeklySessionLoad';

/**
 * Rest and away marks (lane R6-b1). Owner ruling OD-2026-11-17-004 (OW25-30
 * A): "A recorded rest or away mark (no health reason asked for minors), a
 * per-week share of rated sessions, and a ratio that stays silent otherwise;
 * no imputed numbers on screen."
 *
 * WHAT A MARK IS. A coach's record that an athlete rested or was away on a
 * range of gym days, so a quiet week can later be told apart from a week
 * nobody logged. This module records and reads marks; it computes no load and
 * changes no rule. Rule 6 starts reading marks in lane R6-b2.
 *
 * NO REASON, FOR ANY AGE. A mark is a kind ('rest' or 'away') and two dates.
 * There is no reason, note or free-text field in the table, the module or the
 * route, and a request that sends one is refused rather than ignored
 * (restMarkUnknownFieldsError), so nobody is ever asked, or able, to record
 * why a child was not training.
 *
 * WHO. REST_MARK_ROLES, by the ACTIVE membership role here (not the account's
 * home role), and only for an athlete assertActorCanAccessAthlete lets that
 * role reach; never a deleted athlete; never platform_owner. Who may mark is
 * Jason's ruling (2026-11-19, relayed by Overwatch: "A: Coach + office"):
 * coaches and the organization admin; athletes and families get no mark
 * control. It is held in that one constant. Athletes, parents and the board
 * read nothing here.
 *
 * Every mark and clear is audited on entity 'athlete_rest_mark' in the same
 * transaction, shadow_mirror false: staff bookkeeping, not a family-feed row.
 */

/** Who may set, clear and read marks (Jason 2026-11-19, "A: Coach + office"). Change here only (plus its tests). */
export const REST_MARK_ROLES = ['coach', 'organization_admin', 'admin'] as const;
export type RestMarkRole = (typeof REST_MARK_ROLES)[number];

export const REST_MARK_KINDS = ['rest', 'away'] as const;
export type RestMarkKind = (typeof REST_MARK_KINDS)[number];

/** The table's own cap (pilot_athlete_rest_marks_range_check): the 5 weeks Rule 6 reads. */
export const REST_MARK_MAX_DAYS = (LOAD_JUMP_PRIOR_WEEKS + 1) * 7;

/** The only fields a mark request may carry. Anything else is refused. */
export const REST_MARK_CREATE_FIELDS = ['athlete_id', 'kind', 'first_day', 'last_day'] as const;
export const REST_MARK_CLEAR_FIELDS = ['athlete_id', 'mark_id'] as const;

export interface RestMarkRow {
  mark_id: string;
  athlete_id: string;
  kind: RestMarkKind;
  /** Gym calendar days, YYYY-MM-DD, both inclusive. */
  first_day: string;
  last_day: string;
  marked_at: string;
}

/** One of Rule 6's 7-day buckets: week 0 is the last 7 gym days, today included. */
export interface LoadWeekWindow {
  week_index: number;
  first_day: string;
  last_day: string;
}

const FIELDS = `mark_id::text as mark_id, athlete_id, kind, first_day::text as first_day,
  last_day::text as last_day, marked_at`;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dayNumber(isoDay: string): number | null {
  if (!ISO_DAY.test(isoDay)) return null;
  const ms = Date.parse(`${isoDay}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  const day = Math.round(ms / 86_400_000);
  // Date.parse rolls 2026-02-30 forward; a day that does not round-trip is not a day.
  return dayFromNumber(day) === isoDay ? day : null;
}

function dayFromNumber(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Pure: the 5 windows Rule 6 buckets sessions into, newest first, for the
 * gym day `today`. Week k covers today-7k-6 .. today-7k, the same reduction
 * weeklySessionLoad.ts does in SQL ((today - date) / 7).
 */
export function loadWeekWindows(today: string): LoadWeekWindow[] {
  const todayNumber = dayNumber(today);
  if (todayNumber === null) throw new Error(`Not a gym day: ${today}`);
  const windows: LoadWeekWindow[] = [];
  for (let week = 0; week <= LOAD_JUMP_PRIOR_WEEKS; week += 1) {
    windows.push({
      week_index: week,
      first_day: dayFromNumber(todayNumber - 7 * week - 6),
      last_day: dayFromNumber(todayNumber - 7 * week),
    });
  }
  return windows;
}

/**
 * Pure: the refusal for a request body carrying any field outside `allowed`,
 * or null. A reason, a note, a health word -- anything not in the list -- is
 * refused out loud, never dropped silently, so a screen that starts sending
 * one fails its first request instead of quietly losing it.
 */
export function restMarkUnknownFieldsError(
  body: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length === 0) return null;
  return `A rest or away mark takes only ${allowed.join(', ')}; it records no reason. Not accepted: ${extra.sort().join(', ')}.`;
}

/**
 * Pure: the refusal for a mark's kind and range, or null. A range runs
 * forward, covers at most REST_MARK_MAX_DAYS days, and sits within the window
 * the load rule can use: it may start no earlier than the oldest day Rule 6
 * reads, and end no later than REST_MARK_MAX_DAYS - 1 days ahead (a planned
 * holiday may be marked before it starts).
 */
export function restMarkShapeError(
  input: { kind: unknown; firstDay: unknown; lastDay: unknown },
  today: string,
): string | null {
  if (typeof input.kind !== 'string' || !(REST_MARK_KINDS as readonly string[]).includes(input.kind)) {
    return `kind must be one of: ${REST_MARK_KINDS.join(', ')}.`;
  }
  const first = typeof input.firstDay === 'string' ? dayNumber(input.firstDay) : null;
  const last = typeof input.lastDay === 'string' ? dayNumber(input.lastDay) : null;
  if (first === null || last === null) return 'first_day and last_day must be dates (YYYY-MM-DD).';
  if (last < first) return 'last_day must be on or after first_day.';
  if (last - first + 1 > REST_MARK_MAX_DAYS) return `A mark covers at most ${REST_MARK_MAX_DAYS} days.`;
  const todayNumber = dayNumber(today);
  if (todayNumber === null) throw new Error(`Not a gym day: ${today}`);
  if (first < todayNumber - (REST_MARK_MAX_DAYS - 1)) {
    return `A mark may start at most ${REST_MARK_MAX_DAYS - 1} days ago.`;
  }
  if (last > todayNumber + (REST_MARK_MAX_DAYS - 1)) {
    return `A mark may end at most ${REST_MARK_MAX_DAYS - 1} days ahead.`;
  }
  return null;
}

function requireToday(today: string | undefined): string {
  const day = today ?? gymDayIso();
  if (!day) throw new Error('Unable to resolve the gym date.');
  return day;
}

/** The actor's role HERE, from its active membership row; null when it may not touch marks. */
async function restMarkRoleInOrganization(actor: ActorIdentity): Promise<RestMarkRole | null> {
  const membership = await queryOne<{ role: RestMarkRole }>(
    `select om.role
       from pilot.organization_memberships om
      where om.account_id = $1 and om.organization_id = $2 and om.active_flag = true
        and om.role = any($3::text[])`,
    [actor.accountId, actor.organizationId, [...REST_MARK_ROLES]],
  );
  return membership?.role ?? null;
}

const NOT_PERMITTED = 'This account may not record or read rest marks for this athlete.';

/**
 * Throws ForbiddenError unless the actor holds a REST_MARK_ROLES membership
 * here AND reaches this athlete with that role. One message for every refusal,
 * so the answer cannot be used to learn whether an athlete id exists. Only
 * access.ts's own refusals ("Forbidden: ...") become this refusal; an outage
 * is rethrown, never reported as "not permitted".
 */
async function assertRestMarkAccess(actor: ActorIdentity, athleteId: string): Promise<RestMarkRole> {
  const role = await restMarkRoleInOrganization(actor);
  if (role) {
    try {
      await assertActorCanAccessAthlete({ ...actor, role }, athleteId);
      return role;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Forbidden'))) throw error;
    }
  }
  throw new ForbiddenError(NOT_PERMITTED, 'REST_MARK_NOT_PERMITTED');
}

/**
 * Live marks overlapping fromDay..toDay for a NAMED SET of athletes the
 * caller has already cleared through the athlete-access contract (the same
 * roster the staff analytics read uses). There is no "all" mode; an empty
 * list answers without the database. The actor must still hold a
 * REST_MARK_ROLES membership here.
 */
export async function listRestMarks(
  actor: ActorIdentity,
  clearedAthleteIds: readonly string[],
  fromDay: string,
  toDay: string,
): Promise<RestMarkRow[]> {
  if (!(await restMarkRoleInOrganization(actor))) {
    throw new ForbiddenError(NOT_PERMITTED, 'REST_MARK_NOT_PERMITTED');
  }
  if (clearedAthleteIds.length === 0) return [];
  return query<RestMarkRow>(
    `select ${FIELDS}
       from pilot.athlete_rest_marks
      where organization_id = $1 and athlete_id = any($2::text[])
        and cleared_at is null
        and first_day <= $4::date and last_day >= $3::date
      order by athlete_id, first_day, marked_at`,
    [actor.organizationId, [...clearedAthleteIds], fromDay, toDay],
  );
}

/**
 * Records one mark, audited in the same transaction. The same kind over the
 * same range, already live, is returned as it stands (one tap twice is one
 * mark; uq_athlete_rest_marks_live_range holds it under a race).
 */
export async function addRestMark(input: {
  actor: ActorIdentity;
  athleteId: string;
  kind: unknown;
  firstDay: unknown;
  lastDay: unknown;
  today?: string;
}): Promise<{ mark: RestMarkRow; created: boolean }> {
  const shapeError = restMarkShapeError(input, requireToday(input.today));
  if (shapeError) throw new ValidationError(shapeError, 'REST_MARK_INVALID');
  const kind = input.kind as RestMarkKind;
  const firstDay = input.firstDay as string;
  const lastDay = input.lastDay as string;

  const role = await assertRestMarkAccess(input.actor, input.athleteId);
  const markId = randomUUID();

  return withTransaction(async (client) => {
    const inserted = await client.query<RestMarkRow>(
      `insert into pilot.athlete_rest_marks
         (organization_id, mark_id, athlete_id, kind, first_day, last_day, marked_by_account_id, marked_by_role)
       values ($1, $2, $3, $4, $5::date, $6::date, $7, $8)
       on conflict (organization_id, athlete_id, kind, first_day, last_day) where cleared_at is null
       do nothing
       returning ${FIELDS}`,
      [input.actor.organizationId, markId, input.athleteId, kind, firstDay, lastDay, input.actor.accountId, role],
    );
    const created = inserted.rows[0];
    if (!created) {
      const existing = await client.query<RestMarkRow>(
        `select ${FIELDS}
           from pilot.athlete_rest_marks
          where organization_id = $1 and athlete_id = $2 and kind = $3
            and first_day = $4::date and last_day = $5::date and cleared_at is null`,
        [input.actor.organizationId, input.athleteId, kind, firstDay, lastDay],
      );
      const found = existing.rows[0];
      if (!found) throw new Error('Rest mark insert conflicted but no live mark was found');
      return { mark: found, created: false };
    }

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: input.actor.accountId,
      actor_role: role,
      organization_id: input.actor.organizationId,
      entity_type: 'athlete_rest_mark',
      entity_id: markId,
      details: { athlete_id: input.athleteId, kind, first_day: firstDay, last_day: lastDay },
      shadow_mirror: false,
    }, client);
    return { mark: created, created: true };
  });
}

/**
 * Clears one live mark (undo): sets cleared_at and cleared_by, keeps the row,
 * audits it in the same transaction. Any REST_MARK_ROLES staff who reaches
 * the athlete may clear it. A mark already cleared, or not this athlete's, is
 * not found; the guarded update means two clears cannot both succeed.
 */
export async function clearRestMark(input: {
  actor: ActorIdentity;
  athleteId: string;
  markId: string;
}): Promise<void> {
  if (!UUID_SHAPE.test(input.markId)) throw new ValidationError('mark_id must be a mark id', 'REST_MARK_INVALID');
  const role = await assertRestMarkAccess(input.actor, input.athleteId);

  await withTransaction(async (client) => {
    const cleared = await client.query<{ mark_id: string }>(
      `update pilot.athlete_rest_marks
          set cleared_at = clock_timestamp(), cleared_by_account_id = $4
        where organization_id = $1 and athlete_id = $2 and mark_id = $3::uuid and cleared_at is null
        returning mark_id::text as mark_id`,
      [input.actor.organizationId, input.athleteId, input.markId, input.actor.accountId],
    );
    if (cleared.rowCount === 0) throw new NotFoundError('No such rest mark.', 'REST_MARK_NOT_FOUND');

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: input.actor.accountId,
      actor_role: role,
      organization_id: input.actor.organizationId,
      entity_type: 'athlete_rest_mark',
      entity_id: input.markId,
      details: { athlete_id: input.athleteId, action: 'clear' },
      shadow_mirror: false,
    }, client);
  });
}
