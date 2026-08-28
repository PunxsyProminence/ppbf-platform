import { isOrganizationAdminRole } from './access';
import type { PilotRole } from './contracts';
import { query, queryOne } from './db';

/**
 * A staff-only signal that release or contact restrictions apply to an athlete.
 *
 * ONE BIT, AND A POINTER TO A HUMAN. It means "restrictions apply to who may
 * collect or contact this child -- speak to the welfare lead". It does not say
 * what the restriction is, who it names, or what document it rests on, and
 * pilot.athlete_release_restrictions has no column those could be written into.
 * See that migration's header for why the absence of a text column IS the
 * design rather than an omission.
 *
 * PPBF models no custody status, protective order, authorized-pickup list or
 * travel authorization. Owner decision, 2026-08-28: a minimal staff-only
 * signal, with no legal narrative stored in the platform. Nothing here should
 * grow into the other thing without that decision being revisited.
 */

/** Who may see that an athlete carries restrictions, and who may set one.
 *
 *  A guardian is deliberately absent, in both directions. A restriction
 *  frequently concerns one of the guardians, so showing the flag to "the
 *  parent" means showing it to the person it is about -- and letting a
 *  guardian clear it would be worse. Whether the OTHER guardian should see it
 *  is a real question and the answer here is no: the platform cannot tell the
 *  two households apart well enough to be trusted with it, and getting it
 *  wrong discloses that a restriction exists to exactly the wrong person.
 *
 *  An athlete is absent for the same reason. The subject of a safeguarding
 *  restriction is not the right reader of a flag about themselves. */
export function canReadReleaseRestrictions(role: PilotRole): boolean {
  return isOrganizationAdminRole(role) || role === 'coach';
}

/** Setting and clearing is narrower than reading. A coach on the floor must
 *  KNOW; recording that a restriction exists is an administrative act with a
 *  named accountable person behind it. */
export function canWriteReleaseRestrictions(role: PilotRole): boolean {
  return isOrganizationAdminRole(role);
}

export interface ReleaseRestrictionRecord {
  athleteId: string;
  restrictionsApply: boolean;
  setByAccountId: string;
  setAt: string;
  updatedByAccountId: string;
  updatedAt: string;
}

interface ReleaseRestrictionRow {
  athlete_id: string;
  restrictions_apply: boolean;
  set_by_account_id: string;
  set_at: string;
  updated_by_account_id: string;
  updated_at: string;
}

function toRecord(row: ReleaseRestrictionRow): ReleaseRestrictionRecord {
  return {
    athleteId: row.athlete_id,
    restrictionsApply: row.restrictions_apply,
    setByAccountId: row.set_by_account_id,
    setAt: row.set_at,
    updatedByAccountId: row.updated_by_account_id,
    updatedAt: row.updated_at,
  };
}

/**
 * Does this athlete carry restrictions?
 *
 * Refuses rather than returning false for a role that may not read it. A
 * `false` would be indistinguishable from "no restriction", which is the
 * answer most likely to be acted on and the one that must never be given by
 * accident.
 */
export async function athleteHasReleaseRestrictions(
  organizationId: string,
  athleteId: string,
  readerRole: PilotRole,
): Promise<boolean> {
  if (!canReadReleaseRestrictions(readerRole)) {
    throw new Error('Forbidden: role may not read release restrictions');
  }

  const row = await queryOne<{ restrictions_apply: boolean }>(
    `select restrictions_apply
       from pilot.athlete_release_restrictions
      where organization_id = $1 and athlete_id = $2`,
    [organizationId, athleteId],
  );

  return row?.restrictions_apply === true;
}

/**
 * Every athlete in this organization currently carrying restrictions.
 *
 * Returns ids only. A floor list wants to know WHICH kids to ask about, and
 * anything richer is a projection somebody would be tempted to render.
 */
export async function athletesWithReleaseRestrictions(
  organizationId: string,
  readerRole: PilotRole,
): Promise<string[]> {
  if (!canReadReleaseRestrictions(readerRole)) {
    throw new Error('Forbidden: role may not read release restrictions');
  }

  const rows = await query<{ athlete_id: string }>(
    `select athlete_id
       from pilot.athlete_release_restrictions
      where organization_id = $1 and restrictions_apply
      order by athlete_id`,
    [organizationId],
  );

  return rows.map((row) => row.athlete_id);
}

/**
 * Record, or lift, the signal.
 *
 * The athlete must exist in this organization -- enforced by the foreign key
 * rather than by a check here, so a wrong athlete_id is a rejected write and
 * not a row nobody can see. Provenance is written on every call: set_by stays
 * as first written, updated_by always names whoever moved it last.
 */
export async function setReleaseRestrictions(params: {
  organizationId: string;
  athleteId: string;
  restrictionsApply: boolean;
  actorAccountId: string;
  actorRole: PilotRole;
}): Promise<ReleaseRestrictionRecord> {
  if (!canWriteReleaseRestrictions(params.actorRole)) {
    throw new Error('Forbidden: role may not set release restrictions');
  }

  const row = await queryOne<ReleaseRestrictionRow>(
    `insert into pilot.athlete_release_restrictions
       (organization_id, athlete_id, restrictions_apply,
        set_by_account_id, updated_by_account_id)
     values ($1, $2, $3, $4, $4)
     on conflict (organization_id, athlete_id) do update set
       restrictions_apply = excluded.restrictions_apply,
       updated_by_account_id = excluded.updated_by_account_id,
       updated_at = now()
     returning athlete_id, restrictions_apply,
               set_by_account_id, set_at::text as set_at,
               updated_by_account_id, updated_at::text as updated_at`,
    [params.organizationId, params.athleteId, params.restrictionsApply, params.actorAccountId],
  );

  if (!row) {
    throw new Error('Not found: athlete does not exist in this organization');
  }

  return toRecord(row);
}
