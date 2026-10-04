import { randomUUID } from 'node:crypto';

import { humanizeContactLevel } from '../../lib/drillPresentation';

import { type ActorIdentity, accessibleAthleteIds, assertActorCanAccessAthlete } from './access';
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
 *                                         sessions in any 7 days (any whole
 *                                         number from 0; no app-set ceiling).
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
  // The only upper bound is the column's storage limit (Postgres integer),
  // so an absurd value is a 400 rather than a database error -- not a policy.
  if (max !== null && (!Number.isInteger(max) || max < 0 || max > 2147483647)) {
    return 'max_hard_open_sessions_per_7_days must be a whole number, 0 or more';
  }
  if (input.note.length > NOTE_MAX) {
    return `note must be ${NOTE_MAX} characters or fewer`;
  }
  return null;
}

/**
 * The actor's role HERE, read from its active membership row in this
 * organization (one row per account and organization) -- not
 * pilot.accounts.role, which is the account's HOME role and can differ: an
 * organization_admin of one gym can hold only a coach membership in another.
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
        and om.role = any($3::text[])`,
    [actor.accountId, actor.organizationId, [...CONTACT_CAP_ROLES]],
  );
  return membership?.role ?? null;
}

/**
 * Throws ForbiddenError unless this actor is staff here AND reaches this
 * athlete. One message for every refusal, so the response cannot be used to
 * learn whether an athlete id exists or whose it is.
 *
 * The athlete check runs with the MEMBERSHIP role, so a coach membership
 * here reaches only that coach's athletes (and live coverage) whatever the
 * account's home role says.
 *
 * Only access.ts's own refusals ("Forbidden: ...") become this refusal. Any
 * other failure -- the database down, a timeout -- is rethrown, so an outage
 * is never reported to a coach as "you may not see this child's cap".
 */
async function assertCapAccess(
  actor: ActorIdentity,
  athleteId: string,
): Promise<(typeof CONTACT_CAP_ROLES)[number]> {
  const role = await capRoleInOrganization(actor);
  if (role) {
    try {
      await assertActorCanAccessAthlete({ ...actor, role }, athleteId);
      return role;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Forbidden'))) throw error;
    }
  }
  throw new ForbiddenError('This account may not read or set contact caps for this athlete.', 'CONTACT_CAP_NOT_PERMITTED');
}

/**
 * Of these athletes, the ones this actor may read and set caps for: the same
 * rule as assertCapAccess (an active staff membership here, then the athlete
 * chokepoint run with that membership role), batched for a roster. Empty for
 * anyone with no such membership.
 */
export async function contactCapAccessibleAthleteIds(
  actor: ActorIdentity,
  athleteIds: readonly string[],
): Promise<Set<string>> {
  const role = await capRoleInOrganization(actor);
  if (!role) return new Set();
  return accessibleAthleteIds({ ...actor, role }, athleteIds);
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
      order by cap_seq desc
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
      order by cap_seq desc
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

/* ---------------------------------------------------------------------------
 * Comparing one sparring entry with the cap (map item 15, PR B).
 *
 * WARN, NEVER BLOCK (Jason, 2026-10-04: "Warn only"). These functions run
 * AFTER the entry has saved and only describe how it compares with the cap
 * the coach set. Nothing here refuses, scores or recommends.
 * ------------------------------------------------------------------------- */

export type CapState = 'set' | 'none' | 'unknown';

export interface CapReading {
  /** 'none' = no cap set (never a default); 'unknown' = the cap could not be read. */
  state: CapState;
  cap: AthleteContactCapRow | null;
}

/**
 * The cap for the entry screen. A refusal or an outage reading the cap is
 * 'unknown' -- never 'none' -- and never fails the caller: the entry it is
 * shown beside has already saved.
 */
export async function readCapForEntry(actor: ActorIdentity, athleteId: string): Promise<CapReading> {
  try {
    const cap = await getCurrentContactCap(actor, athleteId);
    return isCapSet(cap) ? { state: 'set', cap } : { state: 'none', cap: null };
  } catch (error) {
    console.error({
      event: 'contact-cap-read-failed',
      forbidden: error instanceof ForbiddenError,
    });
    return { state: 'unknown', cap: null };
  }
}

export type CapWarningKind =
  | 'stage_above_cap'
  | 'hard_open_days_over_cap'
  | 'stage_not_recorded'
  | 'cap_unknown'
  | 'days_not_counted';

export interface CapWarning {
  kind: CapWarningKind;
  message: string;
}

export interface EntryForCapCheck {
  contactStage: ContactStage | null;
  sparringType: string;
  /** Gym day sparred, YYYY-MM-DD. */
  sparringDay: string;
}

/** Hard or open, the same rule countHardOrOpenSparringDays counts by. */
export function isHardOrOpen(entry: Pick<EntryForCapCheck, 'contactStage' | 'sparringType'>): boolean {
  return entry.sparringType === 'hard' || entry.contactStage === 'open_sparring';
}

const DECIDES = 'Saved. The coach decides.';

/**
 * How one saved entry compares with a SET cap. Pure.
 *
 * `hardOpenDays` is countHardOrOpenSparringDays for the 7 gym days ending on
 * the entry's day, this entry included. The day limit is only reported for an
 * entry that is itself hard or open: a technical round on a heavy week does
 * not go over anything.
 */
export function checkEntryAgainstCap(
  cap: AthleteContactCapRow,
  entry: EntryForCapCheck,
  hardOpenDays: number,
): CapWarning[] {
  const warnings: CapWarning[] = [];
  const highest = cap.highest_allowed_stage;

  if (highest !== null) {
    if (entry.contactStage === null) {
      warnings.push({
        kind: 'stage_not_recorded',
        message: `No contact stage was recorded, so this entry cannot be checked against the cap `
          + `(highest stage: ${humanizeContactLevel(highest)}). ${DECIDES}`,
      });
    } else if (contactStageRank(entry.contactStage) > contactStageRank(highest)) {
      warnings.push({
        kind: 'stage_above_cap',
        message: `Above this athlete's cap: recorded at ${humanizeContactLevel(entry.contactStage)}; `
          + `the coach-set highest stage is ${humanizeContactLevel(highest)}. ${DECIDES}`,
      });
    }
  }

  const most = cap.max_hard_open_sessions_per_7_days;
  if (most !== null && isHardOrOpen(entry) && hardOpenDays > most) {
    warnings.push({
      kind: 'hard_open_days_over_cap',
      message: `Over this athlete's cap: ${hardOpenDays} hard or open sparring sessions in the 7 gym days `
        + `ending ${entry.sparringDay} (sessions = gym days); the coach-set most is ${most}. ${DECIDES}`,
    });
  }

  return warnings;
}

/**
 * The warnings for one saved entry, whatever could or could not be read, so
 * an empty list always means "checked and within the cap" or "no cap set" --
 * never "could not check". `hardOpenDays` null = the count failed.
 */
export function entryCapWarnings(
  reading: CapReading,
  entry: EntryForCapCheck,
  hardOpenDays: number | null,
): CapWarning[] {
  if (reading.state === 'unknown') {
    return [{
      kind: 'cap_unknown',
      message: `This athlete's cap could not be read just now, so this entry was not checked against it. ${DECIDES}`,
    }];
  }
  if (!reading.cap) return [];
  const warnings = checkEntryAgainstCap(reading.cap, entry, hardOpenDays ?? 0)
    .filter((warning) => hardOpenDays !== null || warning.kind !== 'hard_open_days_over_cap');
  if (hardOpenDays === null && reading.cap.max_hard_open_sessions_per_7_days !== null && isHardOrOpen(entry)) {
    warnings.push({
      kind: 'days_not_counted',
      message: `Hard or open sparring days could not be counted just now, so the 7-day limit was not checked. ${DECIDES}`,
    });
  }
  return warnings;
}
