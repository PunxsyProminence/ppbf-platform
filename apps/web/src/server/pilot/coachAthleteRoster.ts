import { athleteIdsForCoach } from './access';
import type { CoachRosterAthlete, PilotAthlete } from './contracts';
import { query } from './db';
import { getAthletesForCoach } from './entities';

/**
 * A coach's OWN athletes ("my athletes"), with the names needed to name them.
 *
 * NOT THE SET A COACH MAY ACT ON. Since issue #1480 (OD-2026-10-11-007) a
 * coach reaches every live athlete of their own gym, so a picker of athletes
 * to act on reads organizationActionableRoster, as /api/pilot/coach/athletes
 * does. This is the narrower "my athletes" set -- coach of record UNION
 * active coverage -- kept for the queues the ruling leaves scoped to a
 * coach's own athletes (progression suggestions).
 *
 * Two reads, and the split between them is the whole point:
 *
 *   athleteIdsForCoach   the central access contract -- coach of record UNION
 *                        active, unexpired coverage. This decides membership.
 *   getAthletesForCoach  a DISPLAY projection that deliberately returns every
 *                        athlete in the organization with dob and
 *                        emergency_contact redacted for the ones this coach is
 *                        unrelated to. This supplies names, and nothing else.
 *
 * getAthletesForCoach IS NOT AN AUTHORIZATION BOUNDARY and must never be used
 * as one. Its own header says so and /api/pilot/coach/intelligence's says so
 * again; this function exists so that the correct pairing lives in one place
 * instead of being re-derived by each caller that needs a coach-scoped picker.
 * /api/pilot/progression/suggestions had the first copy of it, inline.
 *
 * Every athlete this returns is one the coach may reach through
 * assertActorCanAccessAthlete (the gym is a superset of "my athletes"). It
 * is still not a substitute for that assertion: a list is a convenience, the
 * server-side check is the boundary, and every write route keeps its own.
 */
export async function coachAuthorizedRoster(
  organizationId: string,
  coachAccountId: string,
): Promise<CoachRosterAthlete[]> {
  const accessible = new Set(await athleteIdsForCoach(organizationId, coachAccountId));
  const roster = await getAthletesForCoach(organizationId, coachAccountId);
  return roster.filter((athlete) => accessible.has(athlete.athlete_id));
}

/**
 * The athletes an ORGANIZATION ADMIN -- or, since issue #1480, a COACH -- may
 * act on: every live athlete of the organization.
 *
 * getAthletesByOrganization was the obvious call here and was the wrong one:
 * it was `select * from pilot.athletes where organization_id = $1` with no
 * deletion predicate, while assertAthleteBelongsToOrganization -- the gate
 * every write then passes through -- refuses an athlete whose deleted_at is
 * set. Built on the unfiltered read, a picker offered archived children whose
 * every subsequent read and write was refused, and the refusal arrived after
 * the admin had typed something in.
 *
 * The coach half has never had this problem: athleteIdsForCoach carries
 * `deleted_at is null` in both branches of its union. This is that same
 * predicate, applied to the other role, so the two halves of
 * /api/pilot/coach/athletes agree with the gate and with each other.
 *
 * Written before getAthletesByOrganization took the same predicate (audit
 * finding ADMIN-01, 2026-10-08): at the time that function had many callers
 * with different questions, and narrowing it from here would have changed
 * surfaces this change had no business touching. By 2026-10-08 it had one
 * caller left and took the filter itself. This read stays: "which athletes
 * may I act on" is its own question, and the two halves of
 * /api/pilot/coach/athletes are read side by side here.
 */
export async function organizationActionableRoster(
  organizationId: string,
): Promise<PilotAthlete[]> {
  return query<PilotAthlete>(
    `select * from pilot.athletes
     where organization_id = $1 and deleted_at is null
     order by created_at desc`,
    [organizationId],
  );
}
