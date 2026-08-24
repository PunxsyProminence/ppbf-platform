// shadowPersonalizationGate.ts — the ONE place that decides whether inferred
// personalization may reach a model prompt, and the ONE vocabulary for how a
// remembered fact's support is described.
//
// WHY THIS EXISTS. `strong_personalization` was already a real feature flag
// with a real threshold and three activation modes, and the chat route already
// checked it -- once, around `buildPersonalizationPrompt`. But the same request
// then spliced `contextOutput.context` into the prompt unconditionally, and
// that context carried the user's inferred `communication_style` and their
// `remembered_facts` with no check at all. Two paths into the same prompt; one
// gate. Locking the feature stopped one of them.
//
// So the gate is not "checked in more places" -- it is a single argument that
// every personalization decision reads, threaded from the one place that
// evaluates unlock state. A caller cannot forget to check it, because without
// it the builder does not compile.
//
// WHAT IS AND IS NOT PERSONALIZATION. Gated: anything INFERRED about a person
// -- communication style, remembered facts. Not gated: the authenticated role,
// the organization, the evidence boundary, the safety and authority sections.
// Those are authorization facts the request cannot be served without, they are
// not derived from watching someone, and withholding them would make SHADOW
// less safe rather than more private.

import type { ShadowUnlockState } from './shadowUnlocks';
import { isFeatureEnabled } from './shadowUnlocks';

/**
 * Whether inferred personalization may enter a model prompt for this request.
 *
 * Null unlock state resolves to FALSE. The chat route evaluates unlock state
 * with `.catch(() => null)`, so a database hiccup produces null -- and the
 * honest reading of "we could not determine whether this was unlocked" is that
 * it is not. Closed on failure, in the direction that shares less.
 */
export function personalizationAllowed(unlockState: ShadowUnlockState | null): boolean {
  // An explicit early return rather than `Boolean(x) && f(x as T)`. The cast
  // was load-bearing for nothing: it silenced the compiler on a fact the
  // narrowing already knows, and a cast on the argument to a privacy gate is
  // exactly where a later type change should be made to shout.
  if (!unlockState) return false;
  return isFeatureEnabled(unlockState, 'strong_personalization');
}

/**
 * How much repetition sits behind a remembered fact. ORDINAL, NOT A PROBABILITY.
 *
 * The stored `confidence` number on a fact is a hand-picked heuristic weight --
 * 0.6, 0.7, 0.75, 0.8, chosen by a developer reading a switch statement, not
 * measured against anything. Rendering it as "80% confidence" told the model,
 * and anyone reading a transcript, that a calibrated probability had been
 * computed. None was. There is no held-out set, no calibration, and no event
 * whose frequency those numbers estimate.
 *
 * This describes the only thing actually known: how many separate positive
 * signals produced the fact. One is one. It is deliberately a word rather than
 * a number, so there is nothing to mistake for a percentage.
 */
export type FactSupport = 'single observation' | 'repeated' | 'consistent';

/** Observations required before a fact stops reading as a one-off. */
export const REPEATED_OBSERVATION_MINIMUM = 2;
/** Observations required before a fact reads as an established pattern. */
export const CONSISTENT_OBSERVATION_MINIMUM = 5;

/**
 * Facts written before observation counting existed have no count. They are
 * read as a single observation -- the weakest reading -- because that is what
 * is actually known about them: one signal was seen at least once, and nothing
 * in the row evidences more. Assuming more from a missing field would be
 * inventing the very support this module exists to stop inventing.
 */
export function describeFactSupport(observationCount: number | undefined): FactSupport {
  // Clamped to a whole number of at least 1, because the field is a COUNT of
  // things that happened: 0, a negative and 4.7 are all impossible readings,
  // and the value arrives from a jsonb column no CHECK constraint guards.
  //
  // IT CHANGES NO OUTPUT TODAY, and saying so is the point of this comment.
  // `Math.floor(x) >= n` is identical to `x >= n` for integer n, and both
  // minimums below are integers; a value under 1 already falls to the weakest
  // band on its own. This was added on review as defence, and it was verified
  // by mutation that removing it fails nothing -- so it is documentation of an
  // invariant, not a fix for a live defect. It starts earning its keep the day
  // a minimum stops being a whole number, which is exactly when nobody would
  // think to re-derive this.
  const raw = typeof observationCount === 'number' && Number.isFinite(observationCount)
    ? Math.floor(observationCount)
    : 1;
  const observed = Math.max(1, raw);
  if (observed >= CONSISTENT_OBSERVATION_MINIMUM) return 'consistent';
  if (observed >= REPEATED_OBSERVATION_MINIMUM) return 'repeated';
  return 'single observation';
}
