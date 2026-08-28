import { query, queryOne } from './db';
import { ValidationError } from './errors';
import type { AthleteDevelopmentBlockRow } from './athleteDevelopmentBlocks';
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

export type DevelopmentBlockTargetKind = 'competition' | 'wrestling_event';

/** What the caller asks for. 'none' is how a target is cleared -- explicitly,
 *  rather than by omitting a field and hoping the write path reads that as a
 *  clear rather than as "leave it alone". */
export type DevelopmentBlockTargetInput =
  | { kind: 'none' }
  | { kind: DevelopmentBlockTargetKind; id: string };

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
 * Deliberately its own function rather than two more optional fields on the
 * block patch. Clearing a target and leaving it alone are different
 * intentions that a nullable patch field cannot tell apart, and "at most
 * one" is a rule with one enforcement point here rather than one per write
 * path. The database holds the same rule underneath.
 *
 * Returns null for a block in another organization, or one that does not
 * exist -- indistinguishable, so this cannot be used to probe for either.
 * Neither the athlete nor the creator is touched.
 */
export async function setDevelopmentBlockTarget(
  organizationId: string,
  blockId: string,
  target: DevelopmentBlockTargetInput,
): Promise<AthleteDevelopmentBlockRow | null> {
  if (target.kind !== 'none' && !target.id?.trim()) {
    throw new ValidationError(
      'A development block target needs the id of the competition or event it names.',
      'DEVELOPMENT_BLOCK_TARGET_INVALID',
    );
  }

  const competitionId = target.kind === 'competition' ? target.id.trim() : null;
  const wrestlingEventId = target.kind === 'wrestling_event' ? target.id.trim() : null;

  /* The composite foreign keys are what prove the named event exists AND
     belongs to this organization, so there is no pre-check here that could
     drift out of step with them. A bad id raises a foreign-key violation
     rather than being silently accepted, and the route turns that into a
     refusal the coach can read. */
  return queryOne<AthleteDevelopmentBlockRow>(
    `update pilot.athlete_development_blocks
     set target_competition_id = $3,
         target_wrestling_event_id = $4,
         updated_at = now()
     where organization_id = $1 and block_id = $2
     returning organization_id, block_id, athlete_id, title, training_emphasis,
               starts_on::text as starts_on, ends_on::text as ends_on, status,
               target_competition_id, target_wrestling_event_id,
               created_by_account_id, created_at, updated_at`,
    [organizationId, blockId, competitionId, wrestlingEventId],
  );
}
