import { query } from './db';

// The per-athlete readiness feed for the coach floor (register module 169).
// Wires two things that already existed separately: the tested check-in
// formula whose scores land in pilot.readiness, and the CoachWorkspace
// roster that could only ever render UNKNOWN.
//
// The honesty rules this module inherits from the workspace's own safety
// comment ("never default these to a reassuring value"):
// * Only a FRESH reading counts. A GREEN from three days ago shown as
//   today's state is false reassurance -- the exact bug the UNKNOWN default
//   exists to prevent. Anything older than the window is simply absent.
// * Athletes with no fresh reading are OMITTED from the result; the client
//   keeps them UNKNOWN. This module never emits UNKNOWN itself, so a missing
//   row can never be confused with a measured one.

/** A reading older than this is history, not today's floor state. Check-ins
 * are a daily habit; yesterday's body is not today's. */
export const READINESS_FRESHNESS_HOURS = 24;

/** Score bands over the check-in formula's 1-10 range. Operational triage
 * colors for a coach's glance, not clinical judgments: GREEN = train as
 * planned, YELLOW = check in with the athlete first, RED = adjust the plan. */
export const READINESS_GREEN_MIN = 7;
export const READINESS_YELLOW_MIN = 4;

export type ReadinessBoardStatus = 'GREEN' | 'YELLOW' | 'RED';

export interface ReadinessBoardEntry {
  athlete_id: string;
  status: ReadinessBoardStatus;
  score: number;
  measured_at: string;
}

export function readinessStatusForScore(score: number): ReadinessBoardStatus {
  if (score >= READINESS_GREEN_MIN) return 'GREEN';
  if (score >= READINESS_YELLOW_MIN) return 'YELLOW';
  return 'RED';
}

/** Latest fresh reading per athlete, mapped to a triage color. Athletes with
 * no fresh reading do not appear. */
export async function getReadinessBoard(
  organizationId: string,
  athleteIds: string[],
): Promise<ReadinessBoardEntry[]> {
  if (athleteIds.length === 0) return [];

  const rows = await query<{ athlete_id: string; score: string; measured_at: string }>(
    `select distinct on (athlete_id)
       athlete_id, score::text as score, measured_at
     from pilot.readiness
     where organization_id = $1
       and athlete_id = any($2)
       and measured_at >= now() - make_interval(hours => $3)
     order by athlete_id, measured_at desc`,
    [organizationId, athleteIds, READINESS_FRESHNESS_HOURS],
  );

  return rows.map((row) => {
    const score = Number(row.score);
    return {
      athlete_id: row.athlete_id,
      status: readinessStatusForScore(score),
      score,
      measured_at: row.measured_at,
    };
  });
}
