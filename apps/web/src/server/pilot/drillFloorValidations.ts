import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// pilot.drill_floor_validations is owned by
// infra/azure/pilot_slice_postgres_drill_floor_validations_migration.sql. A
// coach of a gym marks a draft reference drill floor-tested for THAT gym; the
// mark is what lets the gym adopt the draft (OD-2026-10-06-026 ruling 3).
//
// APPEND-ONLY. There is no update and no delete here on purpose: a re-mark
// adds a row, the newest row is the current mark, and earlier rows are the
// history of who tested the drill and when. The table's own header says the
// same.

/** The roles the owner named for the floor test; the table CHECKs the same two. */
export const FLOOR_VALIDATOR_ROLES = ['coach', 'organization_admin'] as const;

export type FloorValidatorRole = (typeof FLOOR_VALIDATOR_ROLES)[number];

export interface DrillFloorValidation {
  organization_id: string;
  validation_id: string;
  /** The pilot.drill_library row -- one VERSION of the reference drill. */
  drill_id: string;
  validated_by_account_id: string;
  validated_by_role: FloorValidatorRole;
  validated_at: string;
  note: string;
}

const FIELDS =
  'organization_id, validation_id, drill_id, validated_by_account_id, validated_by_role, validated_at, note';

/**
 * This gym's current (newest) mark for each reference drill, keyed by drill
 * id. Limited to `drillIds` when given; otherwise every drill the gym has
 * marked. A drill with no row is absent from the result.
 */
export async function listFloorValidations(
  organizationId: string,
  drillIds?: readonly string[],
): Promise<Record<string, DrillFloorValidation>> {
  const rows = await query<DrillFloorValidation>(
    `select distinct on (drill_id) ${FIELDS}
     from pilot.drill_floor_validations
     where organization_id = $1
       and ($2::text[] is null or drill_id = any($2::text[]))
     order by drill_id, validated_at desc, validation_id desc`,
    [organizationId, drillIds ? [...drillIds] : null],
  );
  const byDrill: Record<string, DrillFloorValidation> = {};
  for (const row of rows) byDrill[row.drill_id] = row;
  return byDrill;
}

/**
 * Records that a coach of this gym floor-tested a reference drill. One insert.
 *
 * Returns null when no reference drill with that id exists in this gym, so the
 * route can answer with its hidden not-found: another gym's drill id must read
 * exactly like one that does not exist. The reference's own lifecycle is not a
 * condition -- a withdrawn or superseded reference cannot be adopted anyway,
 * and a coach's record of having tested it is still true.
 */
export async function markDrillFloorTested(params: {
  organizationId: string;
  drillId: string;
  validatedByAccountId: string;
  validatedByRole: FloorValidatorRole;
  note?: string;
}): Promise<DrillFloorValidation | null> {
  const reference = await queryOne<{ drill_id: string }>(
    `select drill_id from pilot.drill_library where organization_id = $1 and drill_id = $2`,
    [params.organizationId, params.drillId],
  );
  if (!reference) {
    return null;
  }
  const rows = await query<DrillFloorValidation>(
    `insert into pilot.drill_floor_validations
       (organization_id, validation_id, drill_id, validated_by_account_id, validated_by_role, note)
     values ($1, $2, $3, $4, $5, $6)
     returning ${FIELDS}`,
    [
      params.organizationId,
      `dfv_${randomUUID()}`,
      params.drillId,
      params.validatedByAccountId,
      params.validatedByRole,
      (params.note ?? '').trim(),
    ],
  );
  return rows[0];
}
