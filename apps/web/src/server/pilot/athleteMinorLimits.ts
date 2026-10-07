import { randomUUID } from 'node:crypto';

import { type ActorIdentity, accessibleAthleteIds, assertActorCanAccessAthlete } from './access';
import { writePilotAuditEvent } from './audit';
import { query, queryOne, withTransaction } from './db';
import { ForbiddenError, ValidationError } from './errors';
import { isMinor } from './wallDisplay';

/**
 * Athlete minor limits: the per-athlete limits a COACH sets for a minor,
 * stored as data so the AI and screens read them (OD-2026-10-06-024 ruling
 * 2; OD-2026-09-21-001 items 2-4).
 *
 * Three limit types, each set, changed or cleared on its own:
 *   heat_exposure_minutes_per_session   -- a number of minutes;
 *   weight_cut_max_percent_body_weight  -- a percentage, 0 to 100;
 *   supervision                         -- what the coach requires, in the
 *                                          coach's own words.
 * Contact level is NOT here: it already has coach-set storage for every
 * athlete in pilot.athlete_contact_caps (athleteContactCaps.ts), and readers
 * take it from there.
 *
 * COACH-SET DATA, NEVER AN APP NUMBER. Nothing in this module proposes,
 * defaults, derives or scores a limit. When none is set for a type the answer
 * is "no limit set -- ask the coach", and this module returns exactly that
 * (null), never a fallback value.
 *
 * WHO IS A MINOR is decided at read time from pilot.athletes.dob through
 * isMinor() (wallDisplay.ts; an unknown date of birth counts as a minor) and
 * reported beside the limits. A coach may record a limit for any athlete they
 * reach; nothing here refuses an adult, and nothing stores the label.
 *
 * APPEND-ONLY. Every set, change or clear inserts a row; the newest row per
 * (athlete, type) is the limit in force, and the rows before it are the record
 * of who allowed what. There is no UPDATE and no DELETE here. Each write also
 * records an audit event ('create' on entity 'athlete_minor_limit') in the
 * SAME transaction, so the audit row and the limit row commit or roll back
 * together. The value itself stays out of the audit row; the table holds it.
 *
 * WHO. Staff only, both ways: coach, organization_admin, admin -- with an
 * ACTIVE membership in this organization in one of those roles -- and only
 * for an athlete assertActorCanAccessAthlete lets them reach (a coach's own
 * athletes plus live coverage; an org admin's whole gym; never a deleted
 * athlete). Athletes, guardians, volunteers, board and platform_owner get
 * nothing from this module: whether the athlete or family sees a child's
 * limits is a separate decision nobody has made yet.
 */

export const MINOR_LIMIT_TYPES = [
  'heat_exposure_minutes_per_session',
  'weight_cut_max_percent_body_weight',
  'supervision',
] as const;

export type MinorLimitType = (typeof MINOR_LIMIT_TYPES)[number];

/** The unit each type is stored in; the database's shape check holds the same pairing. */
export const MINOR_LIMIT_UNITS: Readonly<Record<MinorLimitType, 'minutes' | 'percent_body_weight' | 'text'>> = {
  heat_exposure_minutes_per_session: 'minutes',
  weight_cut_max_percent_body_weight: 'percent_body_weight',
  supervision: 'text',
};

export const MINOR_LIMIT_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export const NOTE_MAX = 1000;
export const SUPERVISION_TEXT_MAX = 500;
const HISTORY_LIMIT = 30;
/** numeric(8,2): six digits before the point. */
const NUMBER_MAX = 999999.99;

export interface AthleteMinorLimitRow {
  limit_id: string;
  athlete_id: string;
  limit_type: MinorLimitType;
  /** Stored numeric(8,2), read back as a number; null = cleared or a text type. */
  value_number: number | null;
  value_text: string | null;
  unit: 'minutes' | 'percent_body_weight' | 'text';
  note: string;
  set_by_account_id: string;
  set_by_role: (typeof MINOR_LIMIT_ROLES)[number];
  set_at: string;
}

export interface MinorLimitInput {
  limitType: MinorLimitType;
  /** The number for a numeric type; null clears it. Ignored for supervision. */
  valueNumber: number | null;
  /** The coach's words for supervision; null clears it. Ignored for numeric types. */
  valueText: string | null;
  note: string;
}

export interface AthleteMinorLimitsReading {
  /** From pilot.athletes.dob at read time; unknown dob reads as a minor. */
  athlete_is_minor: boolean;
  /** The limit in force per type: a set row, or null = no limit set. */
  limits: Record<MinorLimitType, AthleteMinorLimitRow | null>;
  /** Newest first, the last 30 rows across every type. */
  history: AthleteMinorLimitRow[];
}

const FIELDS = `limit_id, athlete_id, limit_type, value_number::float8 as value_number, value_text, unit,
  note, set_by_account_id, set_by_role, set_at`;

/** True when this row actually limits anything; a cleared row does not. */
export function isLimitSet(row: AthleteMinorLimitRow | null): row is AthleteMinorLimitRow {
  return row !== null && (row.value_number !== null || row.value_text !== null);
}

export function isMinorLimitType(value: unknown): value is MinorLimitType {
  return typeof value === 'string' && (MINOR_LIMIT_TYPES as readonly string[]).includes(value);
}

/**
 * The row to write for this input, or the reason it is refused. Pure. The only
 * bounds are the column's own (numeric(8,2); a percentage of body weight
 * cannot pass 100) -- never a policy ceiling.
 */
export function minorLimitShapeError(input: MinorLimitInput): string | null {
  if (!isMinorLimitType(input.limitType)) {
    return `limit_type must be one of: ${MINOR_LIMIT_TYPES.join(', ')}`;
  }
  if (input.note.length > NOTE_MAX) {
    return `note must be ${NOTE_MAX} characters or fewer`;
  }
  if (input.limitType === 'supervision') {
    const text = input.valueText;
    if (text !== null && (text.trim().length === 0 || text.length > SUPERVISION_TEXT_MAX)) {
      return `supervision must be ${SUPERVISION_TEXT_MAX} characters or fewer, or null to clear it`;
    }
    return null;
  }
  const value = input.valueNumber;
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > NUMBER_MAX)) {
    return 'value must be a number, 0 or more';
  }
  if (input.limitType === 'weight_cut_max_percent_body_weight' && value !== null && value > 100) {
    return 'a percentage of body weight cannot be more than 100';
  }
  return null;
}

/**
 * The actor's role HERE, read from its active membership row in this
 * organization -- not pilot.accounts.role, which is the account's HOME role
 * and can differ. Null when the account may not touch limits in this
 * organization.
 */
async function limitRoleInOrganization(
  actor: ActorIdentity,
): Promise<(typeof MINOR_LIMIT_ROLES)[number] | null> {
  if (!(MINOR_LIMIT_ROLES as readonly string[]).includes(actor.role)) return null;
  const membership = await queryOne<{ role: (typeof MINOR_LIMIT_ROLES)[number] }>(
    `select om.role
       from pilot.organization_memberships om
      where om.account_id = $1 and om.organization_id = $2 and om.active_flag = true
        and om.role = any($3::text[])`,
    [actor.accountId, actor.organizationId, [...MINOR_LIMIT_ROLES]],
  );
  return membership?.role ?? null;
}

/**
 * Throws ForbiddenError unless this actor is staff here AND reaches this
 * athlete. One message for every refusal, so the response cannot be used to
 * learn whether an athlete id exists or whose it is.
 *
 * The athlete check runs with the MEMBERSHIP role, so a coach membership here
 * reaches only that coach's athletes (and live coverage) whatever the
 * account's home role says.
 *
 * Only access.ts's own refusals ("Forbidden: ...") become this refusal. Any
 * other failure -- the database down, a timeout -- is rethrown, so an outage
 * is never reported to a coach as "you may not see this child's limits".
 */
async function assertLimitAccess(
  actor: ActorIdentity,
  athleteId: string,
): Promise<(typeof MINOR_LIMIT_ROLES)[number]> {
  const role = await limitRoleInOrganization(actor);
  if (role) {
    try {
      await assertActorCanAccessAthlete({ ...actor, role }, athleteId);
      return role;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Forbidden'))) throw error;
    }
  }
  throw new ForbiddenError('This account may not read or set limits for this athlete.', 'MINOR_LIMIT_NOT_PERMITTED');
}

/**
 * Of these athletes, the ones this actor may read and set limits for: the
 * same rule as assertLimitAccess, batched for a roster. Empty for anyone with
 * no such membership.
 */
export async function minorLimitAccessibleAthleteIds(
  actor: ActorIdentity,
  athleteIds: readonly string[],
): Promise<Set<string>> {
  const role = await limitRoleInOrganization(actor);
  if (!role) return new Set();
  return accessibleAthleteIds({ ...actor, role }, athleteIds);
}

async function athleteIsMinorHere(organizationId: string, athleteId: string, now: Date): Promise<boolean> {
  // The access check above already proved a live row; a row gone between the
  // two reads is treated as a minor, the same way an unknown dob is.
  const row = await queryOne<{ dob: string | null }>(
    `select to_char(dob, 'YYYY-MM-DD') as dob
       from pilot.athletes
      where organization_id = $1 and athlete_id = $2 and deleted_at is null`,
    [organizationId, athleteId],
  );
  return row ? isMinor(row.dob, now) : true;
}

/** Newest first, the last 30 writes across every type -- who allowed what, and when. */
async function historyRows(organizationId: string, athleteId: string): Promise<AthleteMinorLimitRow[]> {
  return query<AthleteMinorLimitRow>(
    `select ${FIELDS} from pilot.athlete_minor_limits
      where organization_id = $1 and athlete_id = $2
      order by limit_seq desc
      limit ${HISTORY_LIMIT}`,
    [organizationId, athleteId],
  );
}

/** The limit in force per type: the newest row for that type, which may be a cleared one. */
async function currentRows(organizationId: string, athleteId: string): Promise<AthleteMinorLimitRow[]> {
  return query<AthleteMinorLimitRow>(
    `select distinct on (limit_type) ${FIELDS} from pilot.athlete_minor_limits
      where organization_id = $1 and athlete_id = $2
      order by limit_type, limit_seq desc`,
    [organizationId, athleteId],
  );
}

/**
 * Everything a coach screen or the AI needs for one athlete: whether the
 * athlete is a minor, the limit in force per type (null = no limit set), and
 * the recent history. One access check.
 */
export async function readAthleteMinorLimits(
  actor: ActorIdentity,
  athleteId: string,
  now: Date = new Date(),
): Promise<AthleteMinorLimitsReading> {
  await assertLimitAccess(actor, athleteId);
  const [athleteIsMinor, current, history] = await Promise.all([
    athleteIsMinorHere(actor.organizationId, athleteId, now),
    currentRows(actor.organizationId, athleteId),
    historyRows(actor.organizationId, athleteId),
  ]);
  const limits = {
    heat_exposure_minutes_per_session: null,
    weight_cut_max_percent_body_weight: null,
    supervision: null,
  } as Record<MinorLimitType, AthleteMinorLimitRow | null>;
  for (const row of current) {
    limits[row.limit_type] = isLimitSet(row) ? row : null;
  }
  return { athlete_is_minor: athleteIsMinor, limits, history };
}

/** The limit in force for one type: the newest row, which may be a cleared one. Null when none was ever set. */
export async function getCurrentMinorLimit(
  actor: ActorIdentity,
  athleteId: string,
  limitType: MinorLimitType,
): Promise<AthleteMinorLimitRow | null> {
  await assertLimitAccess(actor, athleteId);
  return queryOne<AthleteMinorLimitRow>(
    `select ${FIELDS} from pilot.athlete_minor_limits
      where organization_id = $1 and athlete_id = $2 and limit_type = $3
      order by limit_seq desc
      limit 1`,
    [actor.organizationId, athleteId, limitType],
  );
}

/**
 * Records a new limit of one type for one athlete (or clears it: value null).
 * Appends; never edits a past row. The audit row is written on the same
 * transaction. Returns the row written.
 */
export async function setMinorLimit(input: MinorLimitInput & {
  actor: ActorIdentity;
  athleteId: string;
}): Promise<AthleteMinorLimitRow> {
  const note = input.note.trim();
  const shapeError = minorLimitShapeError({ ...input, note });
  if (shapeError) throw new ValidationError(shapeError, 'MINOR_LIMIT_INVALID');

  const role = await assertLimitAccess(input.actor, input.athleteId);

  const isText = input.limitType === 'supervision';
  const valueNumber = isText ? null : input.valueNumber;
  const valueText = isText ? input.valueText?.trim() ?? null : null;
  const limitId = randomUUID();

  return withTransaction(async (client) => {
    const inserted = await client.query<AthleteMinorLimitRow>(
      `insert into pilot.athlete_minor_limits
         (organization_id, limit_id, athlete_id, limit_type, value_number, value_text, unit,
          note, set_by_account_id, set_by_role)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning ${FIELDS}`,
      [
        input.actor.organizationId,
        limitId,
        input.athleteId,
        input.limitType,
        valueNumber,
        valueText,
        MINOR_LIMIT_UNITS[input.limitType],
        note,
        input.actor.accountId,
        role,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('Minor limit insert returned no row');

    // The value stays out of the audit row (the table holds it); the audit
    // says who changed which limit type for which athlete, and when.
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: input.actor.accountId,
      actor_role: role,
      organization_id: input.actor.organizationId,
      entity_type: 'athlete_minor_limit',
      entity_id: limitId,
      details: {
        athlete_id: input.athleteId,
        limit_type: input.limitType,
        cleared: valueNumber === null && valueText === null,
      },
    }, client);

    return row;
  });
}
