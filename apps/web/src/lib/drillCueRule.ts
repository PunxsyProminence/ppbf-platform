// The drill cue rule (OD-2026-10-06-026 ruling 2, "Required except
// conditioning"): a technique drill needs at least one coaching cue before it can
// be used; a conditioning drill does not.
//
// PURE and client-safe, so the server refusals (promote, create, edit, restore)
// and the coach page's "not ready" list say the same thing from one place.
//
// WHAT "CONDITIONING" IS. A reference drill (pilot.drill_library) carries a
// discipline, and discipline = 'conditioning' marks the 25 conditioning drills
// the ruling counted (its category is free text, and only 8 of them use the word
// "conditioning"). An operational drill (pilot.drills) has no discipline column,
// so a drill the gym wrote by hand is conditioning when its category says so.
// An adopted drill carries its reference drill's discipline instead.

const CONDITIONING = 'conditioning';

export function isConditioningLabel(value: string | null | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === CONDITIONING;
}

type CueLike = string | { cue_text: string };

/** A cue nobody wrote is not a cue: blank text does not count. */
export function hasCoachingCue(cues: readonly CueLike[]): boolean {
  return cues.some((cue) => (typeof cue === 'string' ? cue : cue.cue_text).trim().length > 0);
}

/** True when the rule is broken: a non-conditioning drill with no cue. */
export function breaksCueRule(drill: { conditioning: boolean; cues: readonly CueLike[] }): boolean {
  return !drill.conditioning && !hasCoachingCue(drill.cues);
}

/** The line the adoption checklist shows. */
export const NO_CUE_READINESS_MESSAGE =
  'It has no coaching cue. A technique drill needs at least one; a conditioning drill does not.';

/** The refusal for a drill the gym already holds or is writing. */
export function cueRequiredMessage(drillName: string): string {
  const name = drillName.trim();
  return `${name ? `"${name}"` : 'This drill'} has no coaching cue. A technique drill needs at least one `
    + 'coaching cue before it can be used; only a conditioning drill may go without. Add a cue first.';
}
