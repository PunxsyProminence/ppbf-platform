import { randomUUID } from 'node:crypto';

import { type ActorIdentity, assertActorCanAccessAthlete } from './access';
import { VOCABULARIES } from './contentImport/vocabularies';
import { query, queryOne } from './db';
import { ForbiddenError, ValidationError } from './errors';

/**
 * Athlete contact caps: the sparring limits a COACH sets for one athlete.
 *
 * Two limits, each optional on its own:
 *   highest_allowed_stage              -- a rung of the contact ladder drills,
 *                                         templates and cohorts already use;
 *   max_hard_open_sessions_per_7_days  -- how many hard or open sparring
 *                                         sessions in any 7 days.
 *
 * COACH-SET DATA, NEVER AN APP NUMBER. Nothing in this module proposes,
 * defaults, derives or scores a limit -- the sparring-exposure migration's
 * "no recommended limit" refusal stands. Minors' limits are coach-set data;
 * when none is set the answer is "no cap set -- ask the coach", and this
 * module returns exactly that (null), never a fallback value.
 *
 * WARN, NEVER BLOCK (Jason, 2026-10-04: "Warn only"). This module stores and
 * reads caps. It gates nothing; the sparring entry screen shows the cap and
 * warns, and the coach decides.
 *
 * APPEND-ONLY. Every set, change or clear inserts a row; the newest row is the
 * cap in force, and the rows before it are the record of who allowed what.
 * There is no UPDATE and no DELETE here.
 *
 * WHO. Staff only, both ways: coach, organization_admin, admin -- with an
 * ACTIVE membership in this organization in one of those roles -- and only
 * for an athlete assertActorCanAccessAthlete lets them reach (a coach's own
 * athletes plus live coverage; an org admin's whole gym; never a deleted
 * athlete). Athletes, guardians, volunteers, board and platform_owner get
 * nothing from this module: a cap is a coach's working limit for one child,
 * and whether the athlete or family sees it is a separate decision nobody has
 * made yet.
 */

/** The contact ladder, lowest to highest. One list, shared with drills. */
export const CONTACT_STAGES = VOCABULARIES.contact_level.values as readonly ContactStage[];

export type ContactStage = 'none' | 'light_technical' | 'conditioned' | 'controlled_sparring' | 'open_sparring';

export const CONTACT_CAP_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export const MAX_SESSIONS_CEILING = 14;
export const NOTE_MAX = 1000;
const HISTORY_LIMIT = 20;

export interface AthleteContactCapRow {
  cap_id: string;
  athlete_id: string;
  highest_allowed_stage: ContactStage | null;
  max_hard_open_sessions_per_7_days: number | null;
  note: string;
  set_by_account_id: string;
  set_by_role: (typeof CONTACT_CAP_ROLES)[number];
  set_at: string;
}

export interface ContactCapInput {
  highestAllowedStage: ContactStage | null;
  maxHardOpenSessionsPer7Days: number | null;
  note: string;
}

const FIELDS = `cap_id, athlete_id, highest_allowed_stage, max_hard_open_sessions_per_7_days,
  note, set_by_account_id, set_by_role, set_at`;

/** True when this row actually limits anything; a cleared row does not. */
export function isCapSet(row: AthleteContactCapRow | null): row is AthleteContactCapRow {
  return row !== null && (row.highest_allowed_stage !== null || row.max_hard_open_sessions_per_7_days !== null);
}

/** Position on the ladder, for comparing an entry's stage to the cap. */
export function contactStageRank(stage: ContactStage): number {
  return CONTACT_STAGES.indexOf(stage);
}

export function contactCapShapeError(input: ContactCapInput): string | null {
  if (input.highestAllowedStage !== null && !CONTACT_STAGES.includes(input.highestAllowedStage)) {
    return `highest_allowed_stage must be one of: ${CONTACT_STAGES.join(', ')}`;
  }
  const max = input.maxHardOpenSessionsPer7Days;
  if (max !== null && (!Number.isInteger(max) || max < 0 || max > MAX_SESSIONS_CEILING)) {
    return `max_hard_open_sessions_per_7_days must be a whole number from 0 to ${MAX_SESSIONS_CEILING}`;
  }
  if (input.note.length > NOTE_MAX) {
    return `note must be ${NOTE_MAX} characters or fewer`;
  }
  return null;
}

/**
 * The actor's role HERE, read from an active membership row -- not
 * pilot.accounts.role (the home role) and not the session's claim alone.
 * Null when the account may not touch caps in this organization.
 */
async function capRoleInOrganization(
  actor: ActorIdentity,
): Promise<(typeof CONTACT_CAP_ROLES)[number] | null> {
  if (!(CONTACT_CAP_ROLES as readonly string[]).includes(actor.role)) return null;
  const membership = await queryOne<{ role: (typeof CONTACT_CAP_ROLES)[number] }>(
    `select om.role
       from pilot.organization_memberships om
      where om.account_id = $1 and om.organization_id = $2 and om.active_flag = true
        and om.role = any($3::text[])
      order by case om.role when $4 then 0 else 1 end
      limit 1`,
    [actor.accountId, actor.organizationId, [...CONTACT_CAP_ROLES], actor.role],
  );
  return membership?.role ?? null;
}

/**
 * Throws ForbiddenError unless this actor is staff here AND reaches this
 * athlete. One message for every reason, so the response cannot be used to
 * learn whether an athlete id exists or whose it is.
 */
async function assertCapAccess(
  actor: ActorIdentity,
  athleteId: string,
): Promise<(typeof CONTACT_CAP_ROLES)[number]> {
  const role = await capRoleInOrganization(actor);
  if (role) {
    try {
      await assertActorCanAccessAthlete(actor, athleteId);
      return role;
    } catch {
      // fall through to the single refusal below
    }
  }
  throw new ForbiddenError('This account may not read or set contact caps for this athlete.', 'CONTACT_CAP_NOT_PERMITTED');
}

/** The cap in force: the newest row, which may be a cleared one. Null when none was ever set. */
export async function getCurrentContactCap(
  actor: ActorIdentity,
  athleteId: string,
): Promise<AthleteContactCapRow | null> {
  await assertCapAccess(actor, athleteId);
  return queryOne<AthleteContactCapRow>(
    `select ${FIELDS} from pilot.athlete_contact_caps
      where organization_id = $1 and athlete_id = $2
      order by set_at desc, cap_id desc
      limit 1`,
    [actor.organizationId, athleteId],
  );
}

/** Newest first, the last 20 changes -- who allowed what, and when. */
export async function listContactCapHistory(
  actor: ActorIdentity,
  athleteId: string,
): Promise<AthleteContactCapRow[]> {
  await assertCapAccess(actor, athleteId);
  return query<AthleteContactCapRow>(
    `select ${FIELDS} from pilot.athlete_contact_caps
      where organization_id = $1 and athlete_id = $2
      order by set_at desc, cap_id desc
      limit ${HISTORY_LIMIT}`,
    [actor.organizationId, athleteId],
  );
}

/**
 * Records a new cap for one athlete (or clears it: both limits null).
 * Appends; never edits a past row. Returns the row written.
 */
export async function setContactCap(input: ContactCapInput & {
  actor: ActorIdentity;
  athleteId: string;
}): Promise<AthleteContactCapRow> {
  const note = input.note.trim();
  const shapeError = contactCapShapeError({ ...input, note });
  if (shapeError) throw new ValidationError(shapeError, 'CONTACT_CAP_INVALID');

  const role = await assertCapAccess(input.actor, input.athleteId);

  const row = await queryOne<AthleteContactCapRow>(
    `insert into pilot.athlete_contact_caps
       (organization_id, cap_id, athlete_id, highest_allowed_stage,
        max_hard_open_sessions_per_7_days, note, set_by_account_id, set_by_role)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ${FIELDS}`,
    [
      input.actor.organizationId,
      randomUUID(),
      input.athleteId,
      input.highestAllowedStage,
      input.maxHardOpenSessionsPer7Days,
      note,
      input.actor.accountId,
      role,
    ],
  );
  if (!row) throw new Error('Contact cap insert returned no row');
  return row;
}
