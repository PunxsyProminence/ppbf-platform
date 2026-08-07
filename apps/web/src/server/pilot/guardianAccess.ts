import { query, queryOne } from './db';

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
 * True when the account holds a guardian link to the athlete inside this
 * organization. The parents subselect is organization-scoped on BOTH
 * levels: the link row and the parent row must each name the same gym.
 */
export async function isGuardianLinkedToAthlete(
  organizationId: string,
  accountId: string,
  athleteId: string,
): Promise<boolean> {
  const linked = await queryOne<{ athlete_id: string }>(
    `select athlete_id
     from pilot.guardian_links
     where organization_id = $1 and athlete_id = $2 and parent_id in (
       select parent_id
       from pilot.parents
       where organization_id = $1 and account_id = $3
     )`,
    [organizationId, athleteId, accountId],
  );

  return Boolean(linked);
}

/**
 * Every athlete this parent account is linked to in this organization.
 * Distinct, because one account may back more than one parent row and a
 * scope list must not carry duplicates. An empty array means an empty
 * scope -- callers must pass it through as [] (matches nothing), never
 * widen it to undefined (matches everything).
 */
export async function guardianAthleteIds(organizationId: string, accountId: string): Promise<string[]> {
  const rows = await query<{ athlete_id: string }>(
    `select distinct gl.athlete_id
     from pilot.guardian_links gl
     join pilot.parents p
       on p.organization_id = gl.organization_id
      and p.parent_id = gl.parent_id
     where gl.organization_id = $1 and p.account_id = $2`,
    [organizationId, accountId],
  );

  return rows.map((row) => row.athlete_id);
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
  const row = await queryOne<{ parent_id: string; full_name: string }>(
    `select p.parent_id, p.full_name
     from pilot.parents p
     join pilot.guardian_links gl
       on gl.organization_id = p.organization_id and gl.parent_id = p.parent_id
     where p.organization_id = $1 and p.account_id = $2 and gl.athlete_id = $3
     limit 1`,
    [organizationId, accountId, athleteId],
  );

  if (!row) return null;
  return { parentId: row.parent_id, fullName: row.full_name };
}
