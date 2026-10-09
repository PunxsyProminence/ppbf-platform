import { query, queryOne } from './db';
import { isMinor } from './wallDisplay';

/**
 * The one definition of a guardian's reach: which athletes a signed-in
 * parent account is linked to, through pilot.guardian_links joined to
 * pilot.parents on the SAME organization.
 *
 * Before this module, that join was hand-written in six places (access.ts,
 * the scheduler route, shadowReadModels, the research-requirements route,
 * the athletes list route, profileDb) -- six chances for one of them to
 * forget the organization predicate on the parents join and let a parent
 * account provisioned in one gym reach a child in another. This is the
 * parent arm of the athlete_record privacy tier (privacyTiers.ts), and it
 * is exactly the query a Phase-2 guardian surface will multiply, so it
 * gets one home before that happens.
 *
 * DIRECTION MATTERS. These helpers answer "what may this PARENT reach" --
 * viewer-scoped, the privacy-bearing direction. The opposite question
 * ("who are this ATHLETE's guardians") is staff-facing roster data with
 * different projections per surface (passbook, intake, roster export) and
 * deliberately does not live here: consolidating it would couple three
 * staff surfaces to a module whose reason for existing is the parent
 * boundary.
 *
 * Call sites migrate opportunistically, not in one sweep: profileDb's
 * relationship resolver stays self-contained because it is the only place
 * 'guardian_of_subject' is minted for the minor circle and its file header
 * documents that isolation on purpose; the athletes list route projects
 * full rows and keeps its join inline.
 */

/**
 * THE GUARDIAN LINK GOES DORMANT AT 18 (OD-2026-10-07-008, question card 1
 * item 3, Jason: "Goes dormant at 18"). The link row is not deleted and no
 * staff read changes; it simply stops answering for the guardian, on every
 * read in this module and on every consent change in guardianConsent.ts,
 * from the moment the athlete is an adult.
 *
 * "Adult" is wallDisplay.isMinor's answer, not a second rule: age on the
 * GYM's calendar day (America/New_York), so an athlete stays a minor until
 * local midnight at the start of their 18th birthday, and an unknown or
 * unreadable date of birth reads as a minor. The one helper every guardian
 * path names, so the day the link ends is the same day on every surface.
 */
export function guardianLinkEnded(dob: string | Date | null | undefined, now: Date = new Date()): boolean {
  return !isMinor(dob instanceof Date ? calendarDay(dob) : dob, now);
}

/**
 * A `date` column read without db.ts's type parser (a mocked pool, a bare pg
 * client) arrives as a JS Date at LOCAL midnight of that calendar day, which
 * is how node-postgres parses DATE. Its local parts are the stored day; its
 * UTC parts are the day before east of Greenwich. isMinor wants the string.
 */
function calendarDay(value: Date): string | null {
  if (Number.isNaN(value.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** The refusal a guardian's consent write meets once the link has ended. */
export const GUARDIAN_LINK_ENDED_MESSAGE = 'Forbidden: this athlete is 18 or older; guardian access has ended';

/**
 * True when the account holds a guardian link to the athlete inside this
 * organization. The parents subselect is organization-scoped on BOTH
 * levels: the link row and the parent row must each name the same gym.
 */
export async function isGuardianLinkedToAthlete(
  organizationId: string,
  accountId: string,
  athleteId: string,
): Promise<boolean> {
  /* The join onto pilot.athletes is the deletion filter, and it is a JOIN
     rather than a second query because the link row alone cannot answer this.
     guardian_links stores an athlete_id; it carries no deleted_at of its own,
     so a link to a soft-deleted athlete stayed true forever and a guardian
     kept reading a record the gym had deleted. Same shape as #690: deletion
     wrote deleted_at, and the read paths never asked. */
  const linked = await queryOne<{ athlete_id: string; dob: string | null }>(
    `select gl.athlete_id, to_char(a.dob, 'YYYY-MM-DD') as dob
     from pilot.guardian_links gl
     join pilot.athletes a
       on a.athlete_id = gl.athlete_id
      and a.organization_id = gl.organization_id
      and a.deleted_at is null
     where gl.organization_id = $1 and gl.athlete_id = $2 and gl.parent_id in (
       select parent_id
       from pilot.parents
       where organization_id = $1 and account_id = $3
     )`,
    [organizationId, athleteId, accountId],
  );

  // dob rides on the same row so the dormancy rule is decided in one place
  // (guardianLinkEnded) rather than re-derived in SQL per reader. As to_char,
  // never ::text or the bare column: ::text follows the session DateStyle and
  // the bare column's shape follows whether db.ts's date parser is installed
  // (adultPathway.ts carries the same note).
  return Boolean(linked) && !guardianLinkEnded(linked?.dob);
}

/**
 * Every athlete this parent account is linked to in this organization.
 * Distinct, because one account may back more than one parent row and a
 * scope list must not carry duplicates. An empty array means an empty
 * scope -- callers must pass it through as [] (matches nothing), never
 * widen it to undefined (matches everything).
 */
export async function guardianAthleteIds(organizationId: string, accountId: string): Promise<string[]> {
  const rows = await linkedAthleteRows(organizationId, accountId);

  // An adult child drops out of the scope list quietly: to every caller this
  // is the same shape as "not linked", which is what the ruling asks for.
  return rows.filter((row) => !guardianLinkEnded(row.dob)).map((row) => row.athlete_id);
}

/**
 * The same link rows WITHOUT the 18 rule: every live athlete this account's
 * guardian records are linked to, adult or not. For STAFF integrity checks
 * only -- guardianLoginMove's "one login, one guardian slot per child" guard
 * asks which children a login already guards so a second record for the same
 * child cannot be moved onto it, and that invariant has to hold for an adult
 * child too (the slot comes back the day a date of birth is corrected). It is
 * not a guardian read: nothing here is shown to, or reached by, the guardian.
 * Reviewer finding on #1363: the guard read guardianAthleteIds and stopped
 * seeing the adult overlap the moment the rule landed.
 */
export async function linkedAthleteIdsIncludingAdults(organizationId: string, accountId: string): Promise<string[]> {
  const rows = await linkedAthleteRows(organizationId, accountId);
  return rows.map((row) => row.athlete_id);
}

async function linkedAthleteRows(
  organizationId: string,
  accountId: string,
): Promise<Array<{ athlete_id: string; dob: string | null }>> {
  return query<{ athlete_id: string; dob: string | null }>(
    `select distinct gl.athlete_id, to_char(a.dob, 'YYYY-MM-DD') as dob
     from pilot.guardian_links gl
     join pilot.parents p
       on p.organization_id = gl.organization_id
      and p.parent_id = gl.parent_id
     join pilot.athletes a
       on a.athlete_id = gl.athlete_id
      and a.organization_id = gl.organization_id
      and a.deleted_at is null
     where gl.organization_id = $1 and p.account_id = $2`,
    [organizationId, accountId],
  );
}

/**
 * Every pilot.parents row this account backs, in this organization. Plural
 * for the same reason guardianAthleteIds is distinct-guarded: one account can
 * back more than one parent row. T-008's consent gate writes rows keyed by
 * parent_id, not account_id, so a caller acting as "this signed-in guardian"
 * needs this to know which parent_id(s) it may act as.
 */
export async function guardianParentIds(organizationId: string, accountId: string): Promise<string[]> {
  const rows = await query<{ parent_id: string }>(
    `select parent_id from pilot.parents where organization_id = $1 and account_id = $2`,
    [organizationId, accountId],
  );

  return rows.map((row) => row.parent_id);
}

/**
 * The ONE pilot.parents row this account backs that is a real guardian_links
 * guardian of the named athlete -- never just "the account's first parent
 * row" (see guardianConsent.ts's resolveActingParent header for the T-008
 * multi-guardian bug this exists to make structurally impossible: one
 * account can legitimately back a different parent_id per child, so any
 * resolution that doesn't name the athlete can silently write under the
 * wrong child's guardian record).
 */
export async function guardianParentIdForAthlete(
  organizationId: string,
  accountId: string,
  athleteId: string,
): Promise<{ parentId: string; fullName: string } | null> {
  /* The join onto pilot.athletes is the same deletion filter
     isGuardianLinkedToAthlete and guardianAthleteIds carry, and it is here for
     the same reason: guardian_links has no deleted_at of its own, so a link to
     a withdrawn child stays true forever and only this join can close it.

     This function was the third athlete-scoped read in the module and the one
     without it. That was not reachable -- its one caller chain
     (resolveActingParent -> POST /api/pilot/parent/consent) checks
     guardianAthleteIds first, which already excludes a deleted athlete -- but
     "safe because the caller happens to check" is a property that lasts until
     the next caller. The other two are safe on their own; now so is this. */
  const row = await queryOne<{ parent_id: string; full_name: string; dob: string | null }>(
    `select p.parent_id, p.full_name, to_char(a.dob, 'YYYY-MM-DD') as dob
     from pilot.parents p
     join pilot.guardian_links gl
       on gl.organization_id = p.organization_id and gl.parent_id = p.parent_id
     join pilot.athletes a
       on a.organization_id = gl.organization_id
      and a.athlete_id = gl.athlete_id
      and a.deleted_at is null
     where p.organization_id = $1 and p.account_id = $2 and gl.athlete_id = $3
     limit 1`,
    [organizationId, accountId, athleteId],
  );

  if (!row || guardianLinkEnded(row.dob)) return null;
  return { parentId: row.parent_id, fullName: row.full_name };
}
