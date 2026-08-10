import { query } from './db';
import { getWallTimeZone } from './env';
import {
  WALL_OF_NAMES_MAX,
  buildWallOfNames,
  type WallOfNamesAthleteRow,
  type WallOfNamesBoard,
} from './wallOfNames';
import type { WallNameMode, WallWaiverRow } from './wallDisplay';

/**
 * The reads behind the Wall of Names.
 *
 * The column list is the privacy boundary, exactly as it is in wallDisplayDb.ts:
 *
 *   - pilot.athletes.weight_class, .gym_status and .emergency_contact are NOT
 *     read. They sit on the same row as the name, and none of them is anybody
 *     else's business on a shared surface.
 *   - pilot.readiness, pilot.medical_intake, pilot.coach_observations and
 *     pilot.assessments are not queried at all.
 *   - pilot.sessions is not queried either, and that is a decision rather than
 *     an omission: a per-person session count on a shared board ranks children
 *     against each other, which achievementPaths.ts forbids platform-wide.
 *   - waivers.notes and .signed_by_name are not read. The name gate needs the
 *     type, the status, the signer's ROLE and the date, and nothing else.
 *
 * There is no DDL here and none anywhere under app/api -- pilot.* is owned by
 * infra/azure migrations (httpRoutesCarryNoDdl.test.ts pins that). This feature
 * added no table and needed no migration: every column it reads already exists.
 */

export async function loadWallOfNames(input: {
  organizationId: string;
  mode: WallNameMode;
  now?: Date;
  timeZone?: string;
}): Promise<WallOfNamesBoard> {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? getWallTimeZone();

  // Ordered oldest-first at the database so the cap, if it is ever reached,
  // keeps the oldest end of the lineage rather than a random slice of it.
  const athletes = await query<WallOfNamesAthleteRow>(
    `select athlete_id,
            full_name,
            dob::text as dob,
            active_flag,
            created_at::text as first_recorded_at
       from pilot.athletes
      where organization_id = $1
      order by created_at asc, full_name asc
      limit ${WALL_OF_NAMES_MAX + 1}`,
    [input.organizationId],
  );

  // Only the people on the board, and only the four columns the gate needs.
  const athleteIds = athletes.map((row) => row.athlete_id);
  const waivers = athleteIds.length
    ? await query<WallWaiverRow>(
      `select athlete_id, waiver_type, status, signed_by_role, signed_at::text
         from pilot.waivers
        where organization_id = $1 and athlete_id = any($2::text[])`,
      [input.organizationId, athleteIds],
    )
    : [];

  return buildWallOfNames({
    organizationId: input.organizationId,
    now,
    timeZone,
    mode: input.mode,
    athletes,
    waivers,
    truncated: athletes.length > WALL_OF_NAMES_MAX,
  });
}
