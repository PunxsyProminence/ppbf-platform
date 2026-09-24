/**
 * THE COACH GLANCE MODEL.
 *
 * One derivation of the facts the coach board states at a glance, so that two
 * layouts can render the same truth instead of each computing its own.
 *
 * WHY THIS FILE EXISTS. The coach board is gaining a second layout: BOARD, one
 * hand-built panel carrying every instrument, and ROOM, the same facts as
 * separate gym objects -- a wall clock, a peg board with hanging tags,
 * clipboards on nails. A coach toggles between them.
 *
 * The obvious way to build that is two components that each read state and each
 * work out their own numbers. That way is already known to be wrong here,
 * because the repository contains a live example of the failure. The coach
 * board prints `{escalations.length} open` over all four severities while
 * SafetyAttentionBadge renders nothing at all unless `critical + high > 0`, and
 * the board additionally keeps counting a row it has already acknowledged
 * because the acknowledgement replaces the row in place rather than removing
 * it. Two instruments, one queue, disagreeing by construction AND by timing --
 * the badge does not re-poll for two minutes. Nobody wrote that on purpose. It
 * is what happens when a fact has two owners.
 *
 * A layout toggle is the fastest way in the world to create nine more of those.
 * So the rule this file enforces is structural rather than advisory: a renderer
 * may change the SHAPE of a fact -- a segmented bar, a peg board, a clipboard --
 * but it may not change its MEANING, because it never computes it.
 *
 * WHAT BELONGS HERE: pure functions of already-loaded state. No fetching, no
 * React, no DOM. That is what lets the honesty suite drive this directly and
 * lets both layouts be tested against one model.
 *
 * WHAT DOES NOT BELONG HERE: anything that decides how a fact LOOKS. Tone names
 * are the one deliberate exception, and only because the tone carries meaning
 * rather than taste -- see reviewQueueBadgeFor.
 *
 * The input types are narrow on purpose. They describe only the fields each
 * derivation actually reads, so this module does not need the component's full
 * interfaces and the component does not need to import its own types back out
 * of here. Structural typing makes the two line up.
 */

/** A readiness band. UNKNOWN is a real state, not a missing value: it means the
 *  feed was asked and this athlete has no fresh reading a coach may act on. */
export type GlanceReadinessBand = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

/** Tones carry meaning, not taste. `restricted` is "look closer"; `locked` is
 *  reserved for a clinician's refusal and is deliberately absent from anything
 *  this module can return. */
export type GlanceBadgeTone = 'cleared' | 'monitor' | 'restricted' | 'locked' | 'neutral';

export interface GlanceBadge {
  readonly tone: GlanceBadgeTone;
  readonly label: string;
}

/** The read-state of the SHADOW review queue. Three states, because "we have
 *  not looked yet" and "we looked and it is empty" and "we could not look" are
 *  three different things a coach needs told apart. */
export type GlanceShadowQueueState = 'loading' | 'loaded' | 'unavailable';

/** Only the fields the readiness derivation reads. */
export interface GlanceAthleteReadiness {
  readonly readiness: GlanceReadinessBand;
}

/** A staff judgement that was recorded but may not be presented as a
 *  measurement. It leaves the athlete UNKNOWN and lands here instead. */
export interface GlanceContextualReading {
  readonly athleteId: string;
}

/** Only the fields the task derivation reads. */
export interface GlanceShadowItem {
  readonly intake_case_id: string;
  readonly status: 'pending_review' | 'approved' | 'rejected' | 'promoted';
  readonly summary: string;
  readonly updated_at: string;
}

export interface GlanceCoachTask {
  readonly id: string;
  readonly title: string;
  readonly when: string;
  readonly priority: 'High';
  readonly status: 'Open';
}

/**
 * Elapsed time as a coach reads it between rounds.
 *
 * A negative or non-finite total is floored to zero rather than rendered. The
 * server owns elapsed time; a clock that briefly runs backwards through a
 * clock-skew correction should read `0m 00s`, not `-3m 41s`, which looks like a
 * defect in the session rather than in the arithmetic.
 */
export function formatElapsed(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export interface ReadinessGlance {
  readonly red: number;
  readonly yellow: number;
  readonly unknown: number;
  /** Readings that became a band because their method is established. */
  readonly banded: number;
  /** Readings that did not, and may not be presented as measurements. */
  readonly unvalidated: number;
  /** banded + unvalidated. What the feed returned in total. */
  readonly tracked: number;
  /** Whether the feed said ANYTHING. Not "whether anybody has a band". */
  readonly trackingAvailable: boolean;
}

/**
 * The readiness counts, from the two sources SEPARATELY.
 *
 * Both halves of this have been wrong before, in ways that were invisible
 * without a test, and the comments survive the move because the traps do.
 *
 * `trackingAvailable` was once `athletes.some(a => a.readiness !== 'UNKNOWN')`.
 * That was the same question while every reading became a band. Once
 * unvalidated readings stopped being promoted, an organization whose scores are
 * all staff judgements -- which is every organization today -- had no athlete
 * with a band, so the tile fell to "No signal": it called a working feed a dead
 * one, and took the provenance caveat down with it, because the caveat renders
 * inside that branch. "No signal" has to keep meaning no signal.
 *
 * `unvalidated` is counted from the contextual list, never derived from the
 * roster. An earlier draft derived it from the roster and returned 0 for
 * exactly the rows it was meant to count, so the caveat silently stopped
 * rendering the moment the provenance gate started working -- the opposite of
 * the intent.
 */
export function readinessGlance(
  athletes: ReadonlyArray<GlanceAthleteReadiness>,
  contextualReadiness: ReadonlyArray<GlanceContextualReading>,
): ReadinessGlance {
  const banded = athletes.filter((athlete) => athlete.readiness !== 'UNKNOWN').length;
  const unvalidated = contextualReadiness.length;
  return {
    red: athletes.filter((athlete) => athlete.readiness === 'RED').length,
    yellow: athletes.filter((athlete) => athlete.readiness === 'YELLOW').length,
    unknown: athletes.filter((athlete) => athlete.readiness === 'UNKNOWN').length,
    banded,
    unvalidated,
    tracked: banded + unvalidated,
    trackingAvailable: banded > 0 || unvalidated > 0,
  };
}

/**
 * The coach's task list, DERIVED from real pending work rather than stored.
 *
 * The platform has no coach-task store. The fabricated five-item list this
 * replaced showed every coach the same stale to-dos with due dates that had
 * already passed. When a real task store exists, this function is the seam.
 *
 * `when` is a full sentence worded here rather than a date, because a derived
 * task has no real due date and rendering a fabricated one is the exact defect
 * being avoided.
 */
export function coachTasksFrom(
  shadowQueue: ReadonlyArray<GlanceShadowItem>,
): ReadonlyArray<GlanceCoachTask> {
  return shadowQueue
    .filter((item) => item.status === 'pending_review')
    .map((item) => ({
      id: item.intake_case_id,
      title: `Review intake case: ${item.summary}`,
      when: `In review queue since ${item.updated_at.slice(0, 10)}`,
      priority: 'High' as const,
      status: 'Open' as const,
    }));
}

/**
 * The SHADOW slat: the board's permanent statement about the queue, so a coach
 * learns on arrival whether anything is waiting without opening the view.
 *
 * Four readings, all said out loud:
 *
 *   checking      the read is in flight -- NOT zero
 *   0 pending     the read succeeded and the queue is empty. This is the good
 *                 news a coach came for, and it used to be silence.
 *   N pending     the read succeeded and there is work
 *   unavailable   the read failed. Never rendered as a count.
 *
 * The failure tone is `restricted`, never `locked`. A network read that did not
 * come back is not a safeguarding state, and borrowing the reserved rung for an
 * unreachable endpoint would teach a coach that it can mean "try again later".
 */
export function reviewQueueBadgeFor(
  shadowQueueState: GlanceShadowQueueState,
  pendingCount: number,
): GlanceBadge {
  if (shadowQueueState === 'loading') return { tone: 'monitor', label: 'checking' };
  if (shadowQueueState === 'unavailable') return { tone: 'restricted', label: 'unavailable' };
  return { tone: 'monitor', label: `${pendingCount} pending` };
}
