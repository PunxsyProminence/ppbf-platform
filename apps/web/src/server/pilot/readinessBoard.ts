import { query } from './db';

// The per-athlete readiness feed for the coach floor (register module 169).
// Wires the scores stored in pilot.readiness to the CoachWorkspace roster,
// which could otherwise only ever render UNKNOWN.
//
// WHAT THESE SCORES ARE, CORRECTED. This comment used to say the feed carried
// "the tested check-in formula whose scores land in pilot.readiness". That was
// false in both halves. No formula writes to pilot.readiness: the only
// production write path is intake.ts#createReadiness, and every score it
// stores was typed by a member of staff during intake review.
//
// readinessMath.ts#calculateReadinessL14 -- the one formula on record for
// this exact shape, registered as LEGACY-READINESS in formulas/registry.ts
// ("sleep x1.25 - soreness x0.45 + discipline x0.3") -- is not merely unused,
// it is deliberately unwired: registered `experimental_unsupported` with
// "must not clear, restrict, or prescribe training", which is precisely what
// the GREEN/YELLOW/RED triage below does. Wiring it in would violate that
// registration, so its only caller stays its own unit test.
//
// So a score reaching this board is a staff judgement, not a measurement, and
// the band it maps to is a triage colour over a human's opinion. Each entry
// therefore carries its own provenance (see ReadinessBoardEntry.method and the
// measurement-property fields) so a surface can say so rather than presenting
// an unvalidated number as a reading. See
// docs/capabilities/READINESS_PROVENANCE_FACTS.md.
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

/** Score bands over the 1-10 range these scores are entered on. Operational
 * triage colors for a coach's glance, not clinical judgments: GREEN = train as
 * planned, YELLOW = check in with the athlete first, RED = adjust the plan.
 *
 * NOT A CHECK-IN AND NOT A FORMULA. This comment said "the check-in formula's
 * 1-10 range" and both halves were wrong: pilot.readiness holds scores TYPED BY
 * STAFF during intake review (method 'staff_entered_intake' or 'UNKNOWN' -- see
 * readinessProvenance.ts), no formula writes to that table, and no athlete
 * checks anything in to it. calculateReadinessL14 exists and is deliberately
 * never called in production. The wording is corrected rather than the
 * behaviour: the bands are unchanged.
 *
 * Nor does the range validate anything. A number being between 1 and 10 is not
 * evidence that readiness was ever established as a construct; see
 * isReadinessValueInContract, which is named for the input contract it is. */
export const READINESS_GREEN_MIN = 7;
export const READINESS_YELLOW_MIN = 4;

export type ReadinessBoardStatus = 'GREEN' | 'YELLOW' | 'RED';

export interface ReadinessBoardEntry {
  athlete_id: string;
  status: ReadinessBoardStatus;
  score: number;
  measured_at: string;
  /** What produced this score. 'UNKNOWN' means provenance was never recorded. */
  method: string;
  /** The METHOD's measurement properties, not this reading's. Carried so a
   * surface can never show the colour without being able to show what stands
   * behind it. */
  reliability_status: string;
  validity_status: string;
  evidence_class: string;
}

// The provenance predicate lives in readinessProvenance.ts, which imports
// nothing, so the coach workspace can use the same rule without pulling this
// module's database import into the browser bundle.
export { isReadinessMethodValidated } from './readinessProvenance';

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

  const rows = await query<{
    athlete_id: string;
    score: string;
    measured_at: string;
    method: string;
    reliability_status: string;
    validity_status: string;
    evidence_class: string;
  }>(
    `select distinct on (athlete_id)
       athlete_id, score::text as score, measured_at,
       method, reliability_status, validity_status, evidence_class
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
      method: row.method,
      reliability_status: row.reliability_status,
      validity_status: row.validity_status,
      evidence_class: row.evidence_class,
    };
  });
}
