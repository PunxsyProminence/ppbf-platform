import { athleteIdsForCoach } from './access';
import type { CoachRosterAthlete } from './contracts';
import { getAthletesForCoach } from './entities';

/**
 * The athletes a coach may ACT on, with the names needed to name them.
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
 * Whatever this returns is a claim that the coach may reach that athlete
 * through assertActorCanAccessAthlete -- both read the same union, so a
 * picker built on this cannot offer an option the write path will refuse.
 * It is still not a substitute for that assertion: a selector is a
 * convenience, the server-side check is the boundary, and every write route
 * keeps its own.
 */
export async function coachAuthorizedRoster(
  organizationId: string,
  coachAccountId: string,
): Promise<CoachRosterAthlete[]> {
  const accessible = new Set(await athleteIdsForCoach(organizationId, coachAccountId));
  const roster = await getAthletesForCoach(organizationId, coachAccountId);
  return roster.filter((athlete) => accessible.has(athlete.athlete_id));
}
