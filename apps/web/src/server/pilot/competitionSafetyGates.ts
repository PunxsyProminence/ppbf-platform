import { assertActorCanAccessAthlete, type ActorIdentity } from './access';
import { ConflictError, ForbiddenError } from './errors';
import { getSafetyGateDefinition, recordSafetyGateEvaluation } from './safetyGateMatrix';
import { findContactEventBlockingHold } from './trainingHolds';
import { getAthleteWaiverStatus, type TrackedWaiverType, type WaiverStatus } from './waiverCompliance';

/**
 * The gate every competition capability runs before a child is linked to a
 * competitive event.
 *
 * WHY THIS MODULE EXISTS AT ALL. wrestlingLeague.ts and externalCompetition.ts
 * were both built deliberately skeletal (owner decision 2026-08-15) and both
 * shipped with the same three holes, because "skeletal" was applied to the
 * safety surface as well as the feature surface. They are the only two
 * athlete-linking capabilities in the app that consulted nothing about the
 * child before writing the link: not who the actor is to that child, not
 * whether that child is currently held out of contact, not whether a guardian
 * has consented to them travelling. The two capabilities need the identical
 * three checks, so the checks live here once. Duplicating them into two route
 * files is how one of the copies later stops matching the other.
 *
 * The modules themselves stay pure data access, which is the shape they and
 * trainingHolds.ts already document ("Role checks live at the route layer ...
 * this module records who acted"). Gate 1 needs the actor's identity, which a
 * data-access module has no business holding, so all three gates run together
 * at the route layer through this function.
 *
 * WHY ALL THREE REFUSE, RATHER THAN RECORDING A WARNING.
 *
 * The repo already has a written test for block-versus-flag, and it is not
 * "how bad is it": safetyGateSeeds.ts chose 'block' for the training-hold gate
 * because "it guards a PRE-action (class registration), where refusing loses
 * nothing; post-action records stay flag-only", and contactClearanceGate.ts is
 * a 'flag' gate for the mirror-image reason -- it records contact that ALREADY
 * HAPPENED, so refusing the write would destroy the only evidence it occurred
 * and teach whoever is logging to leave the fields blank next time.
 *
 * Adding an athlete to a season roster, and entering an athlete into a
 * competition, are both pre-actions. Nothing has happened yet; no record of
 * anything is lost by refusing; the under-reporting failure mode that governs
 * contactClearanceGate cannot apply here because there is nothing to
 * under-report. Both fall on the 'block' side of the repo's own line, so both
 * refuse -- and the scheduler's identical situation (an all-training hold
 * versus a class registration) already refuses with a 403.
 *
 * The travel waiver gets the same answer for one further reason. A training
 * hold is a judgement a person in the gym made and can lift. A travel waiver
 * is a legal consent document a guardian either signed or did not, and no
 * amount of warning-plus-proceed makes a gym lawfully able to put a child in a
 * van. There is no defensible "recorded warning" version of transporting a
 * minor without their guardian's consent on file, so this refuses too.
 *
 * WHAT IS NOT HERE. No override parameter, on purpose -- safetyGateMatrix.ts
 * states the rule for every gate wired through it: "only the underlying
 * condition a gate reads can change its outcome ... A coach/admin override
 * parameter is not something to add later -- it is something this module must
 * keep refusing to have." Lifting the hold, or collecting the waiver, is the
 * way through this gate. There is no second way.
 */

/**
 * Which competition capability is asking. Used only to word the refusal in
 * terms of the thing the caller was actually trying to do -- a refusal that
 * names the wrong event is a refusal an admin cannot act on.
 */
export type CompetitionEventKind = 'wrestling_league_season' | 'external_competition';

const EVENT_DESCRIPTION: Record<CompetitionEventKind, string> = {
  wrestling_league_season: 'a wrestling league season roster',
  external_competition: 'an external competition',
};

/**
 * The gate_key the training-hold refusal is recorded under. Reused, not
 * invented: pilot.safety_gates already carries a 'training_hold' row seeded
 * both by the safety-gate-matrix migration and by safetyGateSeeds.ts, and
 * safetyGateSeedsOwnership.test.ts fails the build if the two ever disagree.
 * A competition-specific gate row would mean a new seed AND a new migration,
 * which is not in this change's scope -- and the condition being read is the
 * same condition that row already describes.
 */
const TRAINING_HOLD_GATE_KEY = 'training_hold';

/** The waiver type that covers taking a minor off-site. */
const TRAVEL_WAIVER: TrackedWaiverType = 'travel';

/**
 * The refusal text for each non-signed travel status, worded from what the
 * status actually means.
 *
 * 'declined' and 'withdrawn' are not gaps in the paperwork -- a guardian made
 * a decision and the decision was no. Telling an admin to "collect the waiver"
 * in that case invites them to go back and press a parent who has already
 * answered, so those two say plainly that a new signature is the only route
 * and leave the asking to a human conversation, not a to-do item.
 */
// Each refusal is written as two sentences -- what is true, then what the
// reader can do about it -- and joined here so the inter-sentence space lives
// in exactly one place. The previous version ended each first sentence with a
// trailing space inside the template literal, which is invisible in review and
// double-spaces the moment somebody adds one at the join.
function joinSentences(...sentences: readonly string[]): string {
  return sentences.join(' ');
}

function travelWaiverRefusal(status: WaiverStatus, event: string): string {
  if (status === 'declined') {
    return joinSentences(
      `Travel waiver declined: this athlete's guardian declined the travel waiver, so the athlete cannot be added to ${event}.`,
      'That is a decision on file, not missing paperwork -- only a newly signed travel waiver changes it.',
    );
  }

  if (status === 'withdrawn') {
    return joinSentences(
      `Travel waiver withdrawn: this athlete's travel consent has been withdrawn, so the athlete cannot be added to ${event}.`,
      'Only a newly signed travel waiver restores it.',
    );
  }

  return joinSentences(
    `Travel waiver missing: no signed travel waiver is on file for this athlete, and ${event} means taking a minor off-site.`,
    "Record the guardian's travel consent on the athlete's consent page first; /admin/waiver-status lists who else is missing one.",
  );
}

/**
 * Runs all three gates for one athlete about to be linked to a competitive
 * event. Returns normally when the link may proceed; otherwise throws the
 * refusal the caller should surface.
 *
 * Ordering is deliberate and is itself a safeguarding property. Gate 1 (may
 * this actor act on this child at all) runs FIRST, so an actor with no
 * relationship to the child learns nothing about that child's medical holds or
 * their family's consent decisions from the error they get back. Gates 2 and 3
 * only ever speak to someone already entitled to the child's record.
 *
 * Every refusal here is a typed PilotError, which is what makes it reach the
 * caller: jsonError checks PilotError before any message-prefix matching, so
 * these messages cannot be silently reworded into a generic 500 the way a
 * prefix convention can be (errors.ts records the incident that taught the
 * repo this). Callers need no per-gate catch block.
 */
export async function assertAthleteMayBeEnteredInCompetition(input: {
  actor: ActorIdentity;
  athleteId: string;
  kind: CompetitionEventKind;
  /** The season/competition id, recorded as the gate evaluation's context. */
  contextId: string;
  /** Injectable clock, for the evaluation timestamp only. */
  at?: string;
}): Promise<void> {
  const event = EVENT_DESCRIPTION[input.kind];
  const { organizationId } = input.actor;

  // GATE 1 -- coach scoping. The same call every other athlete-scoped
  // capability makes (progression assignments, the scheduler, goals,
  // coach-reviews): coach of record or an active coach_coverage grant, admins
  // org-wide, and platform_owner/board refused outright. Its refusal messages
  // are identical whether the athlete exists, sits in another organization, or
  // simply is not this coach's, so a 403 here discloses no more than the
  // hidden not-found it replaces on the athlete arm.
  await assertActorCanAccessAthlete(input.actor, input.athleteId);

  // GATE 2 -- training holds. A match and a competition are contact and
  // maximal exertion, so both 'all_training' (STOP) and 'contact_only'
  // (REGRESS) bar entry; 'conditioning_only' does not, and the scope set lives
  // in findContactEventBlockingHold rather than here. 403 with the hold's own
  // words, matching the scheduler's 'training_hold' branch: the explanation
  // was written FOR the athlete and the lift condition is the teaching moment.
  const hold = await findContactEventBlockingHold(organizationId, input.athleteId);
  if (hold) {
    const evaluatedAt = input.at ?? new Date().toISOString();

    // Recording the blocked attempt is best-effort and gated on the gate row
    // existing -- copied wholesale from the scheduler's training_hold branch,
    // which copied it from contactClearanceGate. pilot.safety_gate_evaluations
    // has a foreign key onto (organization_id, gate_key) in
    // pilot.safety_gates, and both of those tables arrive by operator-applied
    // migration on their own schedule, so an organization can have holds
    // placeable before it has anywhere to record an evaluation. The refusal
    // itself must never depend on whether the audit write can land.
    let gate = null;
    try {
      gate = await getSafetyGateDefinition(organizationId, TRAINING_HOLD_GATE_KEY);
    } catch (error) {
      if ((error as { code?: unknown }).code !== '42P01') {
        throw error;
      }
    }

    if (gate) {
      await recordSafetyGateEvaluation({
        organizationId,
        gateKey: TRAINING_HOLD_GATE_KEY,
        athleteId: input.athleteId,
        outcome: 'blocked',
        reason: `Competition entry refused: active hold covering contact (${input.kind})`,
        evaluatedByAccountId: input.actor.accountId,
        evaluatedByRole: input.actor.role,
        contextId: input.contextId,
        metadata: { hold_id: hold.hold_id, hold_scope: hold.scope, event_kind: input.kind },
        evaluatedAt,
      });
    }

    const explanation = hold.athlete_explanation.trim();
    const liftCondition = hold.lift_condition_text.trim();
    const parts = [
      `Training hold: this athlete cannot be added to ${event} while a hold covering contact is active (scope: ${hold.scope}).`,
    ];
    if (explanation) {
      parts.push(explanation);
    }
    if (liftCondition) {
      parts.push(`What earns the lift: ${liftCondition}`);
    }

    throw new ForbiddenError(parts.join(' '), 'TRAINING_HOLD_BLOCKS_COMPETITION');
  }

  // GATE 3 -- travel waiver. 409 rather than 403 on purpose: errors.ts defines
  // ConflictError as "a precondition on a DIFFERENT resource than the one
  // addressed", and cites GuardianConsentMissingError -- a missing guardian
  // consent -- as the case it was written for. This is that case exactly. A
  // 403 would say the caller may not do this (they may -- an admin entering an
  // athlete is entirely in their remit) and a 400 would blame their input,
  // when what is missing is a document on the athlete's consent record.
  //
  // Every competition is treated as travel. The skeletons store `location` as
  // free text with no home/away flag, so there is no honest way to tell an
  // away meet from a home one, and guessing wrong in the permissive direction
  // is a child in a vehicle without consent. Fail closed until a real
  // home/away distinction exists to read.
  const travelStatus = await getAthleteWaiverStatus(organizationId, input.athleteId, TRAVEL_WAIVER);
  if (travelStatus !== 'signed') {
    throw new ConflictError(travelWaiverRefusal(travelStatus, event), 'TRAVEL_WAIVER_NOT_SIGNED');
  }
}
