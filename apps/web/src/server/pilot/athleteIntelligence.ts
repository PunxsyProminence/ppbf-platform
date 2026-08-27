// athleteIntelligence.ts -- the Athlete Intelligence READ MODEL.
//
// One athlete. Four sources that already exist and had never been read
// together: the latest value of every formula output, the training-attempts
// ledger, the controlled-versus-live transfer readout, and the Film Study
// material a coach has actually worked on. This module reads. It writes
// nothing, creates no table, and adds no migration.
//
// WHAT THIS DELIBERATELY DOES NOT DO, and why each one is a rule rather than a
// preference:
//
//   * NO COMBINED SCORE. There is no overall number here and there must not
//     be. Four sources with four different meanings, four different sample
//     sizes and four different provenances do not average into anything true,
//     and a single number is the one output nobody can argue with by looking at
//     the facts underneath it.
//   * NO RANKING. The signature takes ONE athleteId and returns ONE athlete.
//     Widening it to a list is the single refactor that turns this into a
//     leaderboard, which pilot.training_attempts is forbidden to carry
//     ("failure data describes training, never the child").
//   * NO INJURY RISK, NO PRESCRIPTION. Nothing here infers a risk or suggests a
//     drill. progressionSuggestions.getGapSuggestions already joins transfer
//     and performance and emits prescriptive prose over many athletes; it is
//     not reused for exactly those two reasons.
//   * NO UNSETTLED PROPOSAL BECOMES A FACT. Film Study material arrives
//     through `listReviewedFilmStudyMaterial`, which is filtered to ACCEPTED
//     ONLY. A rejected proposal is not evidence and never appears; neither
//     does a 'corrected' one, which is a coach's replacement wording on a
//     proposal still sitting in their queue -- work in progress, not a
//     verdict. Accepted-only is an owner decision (2026-08-27).
//   * ABSENCE IS NOT IMPROVEMENT. An athlete with no rows reads
//     `none_recorded`, which says nothing was recorded and nothing else. It is
//     not "no problems", not "improving", and not zero.
//   * PROVENANCE IS NOT HIDDEN. FormulaResult, MetricTransferReadout and
//     TrainingAttemptRow are passed through structurally intact -- whole
//     objects, not picked fields. Any flattening done here would be the thing
//     nobody can un-flatten later.
//
// AUTHORIZATION IS THE CALLER'S, ONCE, BEFORE ANY READ. This module takes an
// organizationId and an athleteId and trusts them, exactly like
// falseProgress.getTransferReadout and trainingAttempts.listAttempts do. The
// route calls `assertActorCanAccessAthlete` -- the standing authority, which
// refuses platform_owner and board by name and fails closed on an unknown role
// -- once, before getAthleteIntelligence is invoked. `accessibleAthleteIds` is
// deliberately NOT used: it takes a list, and a list is the multi-athlete
// signature this module must never grow.

import {
  listLatestFormulaResultsPerOutput,
} from './formulas/repository';
import type { FormulaResult } from './formulas/types';
import { getTransferReadout, TRANSFER_WINDOW_DAYS, type MetricTransferReadout } from './falseProgress';
import { listReviewedFilmStudyMaterial, type ReviewedFilmStudyRow } from './shadowFilmStudyProposals';
import { listAttempts, type TrainingAttemptRow } from './trainingAttempts';

/**
 * Whether a source has anything recorded for this athlete, per source.
 *
 * Four unrelated unavailability vocabularies already exist across the modules
 * read here -- a formula result's `unavailableReason`, its `validation.state`,
 * the transfer readout's `insufficient_evidence`, and Film Study validation's
 * `insufficient_data`. None of them is the same question, and none is
 * translated into this one: each arrives intact inside its own items.
 *
 * This is the narrower question of whether the source produced anything at
 * all, modelled on `FilmStudyValidationStatus` (filmStudyValidation.ts), which
 * is the existing precedent for saying "the sample is too thin to speak" out
 * loud rather than reporting a confident zero.
 *
 * `none_recorded` means NOTHING WAS RECORDED. It does not mean the athlete is
 * fine, improving, or without problems. Absence of evidence is not evidence.
 */
export type IntelligenceSourceAvailability = 'available' | 'none_recorded';

export interface IntelligenceSection<TItem> {
  readonly availability: IntelligenceSourceAvailability;
  readonly items: readonly TItem[];
}

/**
 * One formula output at its latest computed value.
 *
 * `result` is the whole FormulaResult, unmodified: value, unit, computedAt,
 * inputObservationIds, provenance, validation (state + hardBlocks + warnings)
 * and quality (confidence + completeness + worstSourceQuality) all travel
 * together.
 *
 * That grouping is load-bearing for MVP-10, which can carry
 * `confidence: 'INSUFFICIENT'` beside a REAL value and `state: 'valid'` (the
 * engine's confidenceOverride). Read alone, that confidence says "insufficient"
 * over a number that is fine. Because validation and quality are nested in one
 * object here, no consumer can pick up a bare confidence without the state that
 * qualifies it.
 */
export interface FormulaOutputEntry {
  readonly result: FormulaResult;
  /**
   * The registry constant, under a name that says what it is.
   *
   * `human_review_required` on pilot.shadow_formula_results is copied from the
   * formula DEFINITION at compute time (engine.ts <- registry.ts). It is a
   * property of the FORMULA, identical on every result that formula ever
   * produces. Nothing computes it per result and NOTHING EVER CLEARS IT --
   * there is no `update pilot.shadow_formula_results` anywhere in this
   * repository (grep over apps/web, 2026-08-27: no match).
   *
   * So it must never be rendered as "awaiting review": it would never stop
   * saying so, for every result of that formula, forever.
   */
  readonly formulaRequiresHumanReview: boolean;
  /**
   * DATA GAP, present in the payload rather than absent from it.
   *
   * There is no per-result review state for formula results -- no column, no
   * table, no writer. A coach cannot mark one result reviewed, and this read
   * model does not invent a place to put that. Always null; when a review state
   * is actually built, this is where it lands.
   */
  readonly perResultReviewState: null;
}

export interface AthleteIntelligenceReadModel {
  readonly organizationId: string;
  readonly athleteId: string;
  /** When this read ran. Not a data timestamp -- every item carries its own. */
  readonly generatedAt: string;
  /** Latest value of every formula output, one entry per (formulaId, outputKey). */
  readonly formulaOutputs: IntelligenceSection<FormulaOutputEntry>;
  /** The attempts ledger, newest first. `made: null` means there was NO TARGET
   * -- a measurement, not a failure -- and stays distinct from false. */
  readonly trainingAttempts: IntelligenceSection<TrainingAttemptRow>;
  /** Controlled versus live, per metric, with all four raw counts attached to
   * every state so a coach can disagree with the rule by looking at the same
   * facts. `open_floor` and `film_study` attempts are in NEITHER transfer class
   * and are not folded in; they appear in trainingAttempts instead. */
  readonly metricTransfer: IntelligenceSection<MetricTransferReadout> & {
    readonly windowDays: number;
  };
  /** ACCEPTED Film Study material only. Pending, rejected and corrected rows
   * are excluded from this READ and remain untouched in the table. */
  readonly reviewedFilmStudy: IntelligenceSection<ReviewedFilmStudyRow>;
}

/** `none_recorded` on empty, `available` otherwise. Nothing else: this function
 * must never grow a third state that means "probably fine". */
function availabilityOf(items: readonly unknown[]): IntelligenceSourceAvailability {
  return items.length > 0 ? 'available' : 'none_recorded';
}

/**
 * Assemble the read model for ONE athlete.
 *
 * The caller must already have authorized this actor for this athlete; see the
 * module header. Every underlying reader filters organization_id, and the
 * organizationId passed here is the principal's own, never a caller-supplied
 * value.
 */
export async function getAthleteIntelligence(input: {
  organizationId: string;
  athleteId: string;
  transferWindowDays?: number;
  attemptLimit?: number;
  filmStudyLimit?: number;
}): Promise<AthleteIntelligenceReadModel> {
  const windowDays = input.transferWindowDays ?? TRANSFER_WINDOW_DAYS;

  const [formulaResults, attempts, transfer, filmStudy] = await Promise.all([
    listLatestFormulaResultsPerOutput({
      organizationId: input.organizationId,
      athleteId: input.athleteId,
    }),
    listAttempts(input.organizationId, input.athleteId, { limit: input.attemptLimit }),
    getTransferReadout(input.organizationId, input.athleteId, windowDays),
    listReviewedFilmStudyMaterial({
      organizationId: input.organizationId,
      athleteId: input.athleteId,
      limit: input.filmStudyLimit,
    }),
  ]);

  const formulaOutputs = formulaResults.map((result): FormulaOutputEntry => ({
    result,
    // Read off the result rather than restated, so the renamed field and the
    // column can never drift apart.
    formulaRequiresHumanReview: result.humanReviewRequired,
    perResultReviewState: null,
  }));

  return {
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    generatedAt: new Date().toISOString(),
    formulaOutputs: { availability: availabilityOf(formulaOutputs), items: formulaOutputs },
    trainingAttempts: { availability: availabilityOf(attempts), items: attempts },
    metricTransfer: { availability: availabilityOf(transfer), items: transfer, windowDays },
    reviewedFilmStudy: { availability: availabilityOf(filmStudy), items: filmStudy },
  };
}
