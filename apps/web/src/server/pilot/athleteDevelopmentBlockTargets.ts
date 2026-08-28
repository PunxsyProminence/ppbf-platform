import { type ActorIdentity } from './access';
import { query, queryOne } from './db';
import {
  updateDevelopmentBlock,
  type AthleteDevelopmentBlockRow,
  type DevelopmentBlockTargetInput,
  type DevelopmentBlockTargetKind,
} from './athleteDevelopmentBlocks';
import type { CompetitionStatus } from './externalCompetition';
import type { LeagueEventStatus } from './wrestlingLeague';

/**
 * What a development block is preparing for.
 *
 * THE WHOLE OF WHAT A TARGET MEANS: a name, a date, where it is, who
 * sanctions it if anybody recorded that, and whether it is still happening.
 * Both competition surfaces are skeletal by prior owner decision -- no
 * brackets, no weight classes, no qualification rules, no results-to-date --
 * so there is nothing here a taper, a peak, a volume curve or a weight plan
 * could be derived from, and nothing in this module derives one. Pointing a
 * block at an event says when the coach is aiming. It does not say what to
 * do about it, and this platform does not hold that doctrine.
 *
 * This module reads the two competition tables by primary key and nothing
 * else. It does not reimplement competition or league logic, does not write
 * to either table, and adds no column to either: those modules stay exactly
 * as skeletal as the owner decision left them.
 */

/* Both types live on athleteDevelopmentBlocks, with the row and the write
   that owns them, and are re-exported here so a caller reading about targets
   finds them where it is looking. One declaration, two names for it. */
export type { DevelopmentBlockTargetInput, DevelopmentBlockTargetKind };

/**
 * A resolved target, in the shape the order asks a coach to be shown.
 *
 * `sanctioning_body` is null for a wrestling league event because
 * pilot.wrestling_league_events HAS NO SUCH COLUMN. That is a fact about the
 * schema, not a gap to fill: the reading surface says nothing rather than
 * inventing a body, and "where stored" is exactly how the order words it.
 */
export interface ResolvedDevelopmentBlockTarget {
  kind: DevelopmentBlockTargetKind;
  id: string;
  name: string;
  date: string;
  location: string;
  sanctioning_body: string | null;
  status: CompetitionStatus | LeagueEventStatus;
}

/**
 * The target a block names, resolved, or null when it names none.
 *
 * Returns null for a block with no target. THROWS for nothing: a block
 * pointing at a row that cannot be read is not a case this can reach --
 * both columns carry a composite foreign key, so the row exists and is in
 * this organization or the block could not have been written. If that
 * invariant is ever broken the read below returns null and the surface says
 * the target could not be read, which is the honest rendering; it never
 * invents a name or a date.
 */
export async function resolveDevelopmentBlockTarget(
  organizationId: string,
  block: Pick<AthleteDevelopmentBlockRow, 'target_competition_id' | 'target_wrestling_event_id'>,
): Promise<ResolvedDevelopmentBlockTarget | null> {
  if (block.target_competition_id) {
    const row = await queryOne<{
      competition_id: string;
      competition_name: string;
      competition_date: string;
      location: string;
      sanctioning_body: string;
      status: CompetitionStatus;
    }>(
      `select competition_id, competition_name, competition_date::text as competition_date,
              location, sanctioning_body, status
       from pilot.external_competitions
       where organization_id = $1 and competition_id = $2`,
      [organizationId, block.target_competition_id],
    );
    if (!row) return null;
    return {
      kind: 'competition',
      id: row.competition_id,
      name: row.competition_name,
      date: row.competition_date,
      location: row.location,
      /* Stored as NOT NULL DEFAULT '' on this table, so an empty string means
         "nobody recorded one" and must not render as a body named ''. */
      sanctioning_body: row.sanctioning_body.trim() ? row.sanctioning_body : null,
      status: row.status,
    };
  }

  if (block.target_wrestling_event_id) {
    const row = await queryOne<{
      event_id: string;
      event_name: string;
      event_date: string;
      location: string;
      status: LeagueEventStatus;
    }>(
      `select event_id, event_name, event_date::text as event_date, location, status
       from pilot.wrestling_league_events
       where organization_id = $1 and event_id = $2`,
      [organizationId, block.target_wrestling_event_id],
    );
    if (!row) return null;
    return {
      kind: 'wrestling_event',
      id: row.event_id,
      name: row.event_name,
      date: row.event_date,
      location: row.location,
      // No such column on this table. Said as null, never as ''.
      sanctioning_body: null,
      status: row.status,
    };
  }

  return null;
}

/**
 * The events a coach may point a block at, for a picker.
 *
 * Both reads are organization-scoped and carry no athlete data at all -- a
 * competition is a fixture, not a record about a child -- so this is
 * deliberately not athlete-gated. Which BLOCK a caller may attach one to is
 * the athlete-access question, and it is answered where it belongs: on the
 * write, against the block's own athlete.
 *
 * Cancelled events are INCLUDED and marked. A coach whose target was called
 * off still needs to see it in order to change it, and a picker that hides
 * cancelled events would make a cancelled target indistinguishable from a
 * deleted one.
 */
export async function listDevelopmentBlockTargetOptions(
  organizationId: string,
): Promise<ResolvedDevelopmentBlockTarget[]> {
  const [competitions, events] = await Promise.all([
    query<{
      competition_id: string;
      competition_name: string;
      competition_date: string;
      location: string;
      sanctioning_body: string;
      status: CompetitionStatus;
    }>(
      `select competition_id, competition_name, competition_date::text as competition_date,
              location, sanctioning_body, status
       from pilot.external_competitions
       where organization_id = $1
       order by competition_date desc, competition_id asc`,
      [organizationId],
    ),
    query<{
      event_id: string;
      event_name: string;
      event_date: string;
      location: string;
      status: LeagueEventStatus;
    }>(
      `select event_id, event_name, event_date::text as event_date, location, status
       from pilot.wrestling_league_events
       where organization_id = $1
       order by event_date desc, event_id asc`,
      [organizationId],
    ),
  ]);

  const resolved: ResolvedDevelopmentBlockTarget[] = [
    ...competitions.map((row) => ({
      kind: 'competition' as const,
      id: row.competition_id,
      name: row.competition_name,
      date: row.competition_date,
      location: row.location,
      sanctioning_body: row.sanctioning_body.trim() ? row.sanctioning_body : null,
      status: row.status,
    })),
    ...events.map((row) => ({
      kind: 'wrestling_event' as const,
      id: row.event_id,
      name: row.event_name,
      date: row.event_date,
      location: row.location,
      sanctioning_body: null,
      status: row.status,
    })),
  ];

  // One list, soonest-first by the date the coach is aiming at. Ties broken
  // by id so the order is stable across reads rather than whatever the two
  // queries happened to interleave.
  return resolved.sort((left, right) =>
    right.date.localeCompare(left.date) || left.id.localeCompare(right.id));
}

/**
 * Points a block at one event, or clears its target.
 *
 * Kept as its own function for callers whose whole intention is the target,
 * but it is a thin call onto updateDevelopmentBlock rather than a second
 * write: see below. Clearing a target and leaving it alone stay different
 * intentions -- `{ kind: 'none' }` against an omitted field -- which is why
 * the input is a value rather than a nullable column.
 *
 * Returns null for a block in another organization, one about an athlete this
 * actor cannot reach, or one that does not exist -- indistinguishable, so this
 * cannot be used to probe for any of them. Neither the athlete nor the creator
 * is touched.
 *
 * Takes an actor rather than an organization id because updateDevelopmentBlock
 * does: #762 moved the athlete-access gate out of the route and into the data
 * layer, on the grounds that an athlete and a guardian can now read a block, so
 * the gate belongs beside the row rather than in the one route that happens to
 * exist. A target write is a write to that row and gets the same gate.
 */
export async function setDevelopmentBlockTarget(
  actor: ActorIdentity,
  blockId: string,
  target: DevelopmentBlockTargetInput,
): Promise<AthleteDevelopmentBlockRow | null> {
  /* Delegates rather than writing its own UPDATE. Two statements that both
     move this row are two things to keep in step, and the one that mattered
     was atomicity: a target write separate from the field write left a caller
     told "that failed" looking at a row whose title and dates had already
     changed. One write path, one enforcement point.

     The composite foreign keys are still what prove the named event exists
     AND belongs to this organization, so there is no pre-check here that
     could drift out of step with them. A bad id raises a foreign-key
     violation and the whole statement rolls back, fields included. */
  return updateDevelopmentBlock(actor, blockId, { target });
}
