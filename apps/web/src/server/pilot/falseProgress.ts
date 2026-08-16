import { query } from './db';

// False-progress detection (register module 053): the honesty check on
// gains. A rep that holds in drills and vanishes in sparring is not
// progress yet -- it is practice-context skill that has not transferred.
// This module DETECTS that pattern deterministically from the attempts
// ledger and surfaces it as a flag for coach review with the raw counts
// attached. It stores nothing, decides nothing, and scores nothing --
// the coach looks at the facts and coaches.
//
// Context classes: controlled (session, drill_assignment, assessment)
// versus live (the four sparring contexts). open_floor and film_study are
// deliberately in NEITHER class -- open floor is unsupervised-mixed and
// film study is observation, so counting either side would blur the
// comparison this module exists to sharpen.
//
// One athlete at a time, their own attempts only. No cross-athlete reads,
// ever.

export const CONTROLLED_CONTEXTS = ['session', 'drill_assignment', 'assessment'] as const;
export const LIVE_CONTEXTS = ['technical_sparring', 'sparring_games', 'sparring_drills', 'open_sparring'] as const;

export const TRANSFER_WINDOW_DAYS = 60;

// Flag thresholds -- display rules for review flags, never stored
// verdicts. All raw counts travel with every flag so a coach can disagree
// with the rule by looking at the same facts.
export const MIN_ATTEMPTS_PER_SIDE = 3;
export const CONTROLLED_STRONG_RATE = 0.7;
export const LIVE_WEAK_RATE = 0.3;

export type TransferState =
  | 'not_transferring'      // strong in practice, weak live -- the false-progress flag
  | 'untested_live'         // strong in practice, no live attempts at all
  | 'transferring'          // strong in practice AND holding live
  | 'insufficient_evidence'; // not enough targeted attempts to say anything

export interface MetricTransferReadout {
  metric_kind: string;
  controlled_makes: number;
  controlled_misses: number;
  live_makes: number;
  live_misses: number;
  state: TransferState;
}

/** Pure classification over the four counts. Exported so tests pin every
 * boundary: the default is insufficient_evidence -- unknown is not clear,
 * and a thin record never produces a flag in either direction. */
export function classifyTransfer(counts: {
  controlledMakes: number;
  controlledMisses: number;
  liveMakes: number;
  liveMisses: number;
}): TransferState {
  const controlledTotal = counts.controlledMakes + counts.controlledMisses;
  const liveTotal = counts.liveMakes + counts.liveMisses;

  if (controlledTotal < MIN_ATTEMPTS_PER_SIDE) return 'insufficient_evidence';
  const controlledRate = counts.controlledMakes / controlledTotal;
  if (controlledRate < CONTROLLED_STRONG_RATE) return 'insufficient_evidence';

  // Practice is strong. What does live say?
  if (liveTotal === 0) return 'untested_live';
  if (liveTotal < MIN_ATTEMPTS_PER_SIDE) return 'insufficient_evidence';

  const liveRate = counts.liveMakes / liveTotal;
  if (liveRate <= LIVE_WEAK_RATE) return 'not_transferring';
  return 'transferring';
}

/** Per-metric transfer readout for one athlete over the window. Only
 * TARGETED attempts count (made is not null): a measurement without a
 * target carries no verdict and therefore no transfer signal. */
export async function getTransferReadout(
  organizationId: string,
  athleteId: string,
  windowDays: number = TRANSFER_WINDOW_DAYS,
): Promise<MetricTransferReadout[]> {
  const rows = await query<{
    metric_kind: string;
    controlled_makes: string;
    controlled_misses: string;
    live_makes: string;
    live_misses: string;
  }>(
    `select metric_kind,
       count(*) filter (where context_type = any($4) and made) as controlled_makes,
       count(*) filter (where context_type = any($4) and not made) as controlled_misses,
       count(*) filter (where context_type = any($5) and made) as live_makes,
       count(*) filter (where context_type = any($5) and not made) as live_misses
     from pilot.training_attempts
     where organization_id = $1 and athlete_id = $2
       and made is not null
       and attempted_at >= now() - make_interval(days => $3)
     group by metric_kind
     order by metric_kind`,
    [organizationId, athleteId, windowDays, [...CONTROLLED_CONTEXTS], [...LIVE_CONTEXTS]],
  );

  return rows.map((row) => {
    const counts = {
      controlledMakes: Number(row.controlled_makes),
      controlledMisses: Number(row.controlled_misses),
      liveMakes: Number(row.live_makes),
      liveMisses: Number(row.live_misses),
    };
    return {
      metric_kind: row.metric_kind,
      controlled_makes: counts.controlledMakes,
      controlled_misses: counts.controlledMisses,
      live_makes: counts.liveMakes,
      live_misses: counts.liveMisses,
      state: classifyTransfer(counts),
    };
  });
}
