import type { PilotRole } from '../contracts';
import { isOrganizationAdminRole } from '../access';
import {
  getAnnotationSet,
  listAnnotationEvents,
  listAnnotationSetsForClip,
  type AnnotationEventRow,
  type AnnotationSetRow,
} from './annotations';

// BLINDING. Two people label the same clip and neither may anchor on the
// other's work.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS AT ALL.
//
// annotations.ts::listAnnotationSetsForClip is organization-scoped and applies
// no blinding. Its docblock says so in as many words. That function is the
// right shape for the adjudicator and for a QA read-out, and it is the wrong
// shape for the screen an annotator sits in front of -- wiring it to that
// screen would defeat the entire study while every test in the repo stayed
// green. This module is the gate that was named there and not built there.
//
// Slice 2 froze a SUBMITTED set so it can never be revised. That makes
// "independent" true after the fact. It does nothing about the far cheaper
// failure: A reads B's finished set, then writes their own to match. Nothing
// was overwritten, every trigger held, and the study measured one reading
// against a copy of itself. Freezing is about WRITES; this file is about
// READS, and both are needed.
//
// ---------------------------------------------------------------------------
// THE RULE, in full.
//
//   1. An annotator may always read their OWN set, in any state.
//   2. An annotator may read ANOTHER annotator's set on the same clip only
//      when that set AND the reader's own set on that clip are both
//      submitted. A reader with no set on the clip is not an annotator of it
//      and reads nothing here.
//   3. Rule 2 applies REGARDLESS OF ROLE, organization administrators
//      included. An admin who wanders onto the annotator surface must not
//      break blinding by accident.
//   4. Reading both raw sets is a separate, explicit act with its own
//      surface, its own role gate, and its own precondition -- see
//      listAnnotationSetsForAdjudication.
//
// ---------------------------------------------------------------------------
// ABSENCE, NOT REDACTION. The trap this file is written around.
//
// The natural implementation returns every set on the clip and nulls the
// fields of the ones the reader may not see. That leaks. The row's presence
// discloses that a second annotator exists, its id discloses which set to ask
// about later, its created_at discloses when they started, and an event count
// beside it discloses how much they found. "Two hidden sets, 41 events
// between them" is enough for an annotator to calibrate their own count
// against, which is exactly the anchoring the study is trying to measure the
// absence of.
//
// So a blinded set is ABSENT from the list, and a blinded set asked for by id
// answers with null -- the same null a set that does not exist answers with.
// That is http.ts::hiddenNotFound's contract at the module level: a route
// turns either null into the same 404, and the two cases stay
// indistinguishable to the caller. calibrationBlinding.pg.test.ts asserts
// absence rather than redaction, because the redacting version passes any
// test that only checks for nulled fields.
//
// ---------------------------------------------------------------------------
// DEFAULT TO LESS. Every unknown here resolves to blinded: a status string
// this build does not recognise is not 'submitted', a set whose organization
// does not match the reader's is refused before anything else is considered,
// and a sibling on another clip or in another tenant counts toward nothing.

/**
 * The minimum a set has to say about itself for the rule to decide.
 *
 * A structural subset of AnnotationSetRow on purpose, so a row straight out of
 * annotations.ts can be passed unchanged, while the decision function stays
 * callable from a test with a four-line literal and no database.
 */
export interface BlindingSubjectSet {
  readonly organization_id: string;
  readonly annotation_set_id: string;
  readonly calibration_clip_id: string;
  readonly annotator_account_id: string;
  readonly status: string;
}

export type AnnotationSetVisibilityReason =
  /** The reader is the annotator. Rule 1 -- state is irrelevant. */
  | 'own_set'
  /** Rule 2 satisfied: this set and the reader's own are both submitted. */
  | 'mutually_submitted';

export type AnnotationSetBlindedReason =
  /** The set belongs to another tenant. Refused before anything else. */
  | 'different_organization'
  /** The reader has no set of their own on this clip, so they are not one of
   *  its annotators and this surface owes them nothing. */
  | 'not_an_annotator_of_this_clip'
  /** The reader has not submitted yet. Seeing a finished set now is exactly
   *  the anchoring being prevented. */
  | 'reader_not_submitted'
  /** The other annotator is still working. */
  | 'sibling_not_submitted';

/**
 * The answer, and WHY.
 *
 * Deliberately not a boolean. A boolean cannot tell "there is no such set" from
 * "there is one and you are too early" from "that is another gym's data" --
 * and those three need different handling: the first is a 404, the second is a
 * state a QA read-out has to be able to report on, and the third is a tenancy
 * bug if it ever happens on a real request. The route still collapses all of
 * them to one indistinguishable 404 on the way out; the distinction lives here
 * so it can be withheld deliberately rather than never existing.
 */
export type AnnotationSetVisibility =
  | { readonly outcome: 'visible'; readonly reason: AnnotationSetVisibilityReason }
  | { readonly outcome: 'blinded'; readonly reason: AnnotationSetBlindedReason };

export interface AnnotationSetVisibilityInput {
  readonly actorAccountId: string;
  readonly actorOrganizationId: string;
  /**
   * Accepted and DELIBERATELY NOT CONSULTED.
   *
   * Rule 3. Keeping the parameter means the annotator surface's indifference
   * to role is written down where the decision is made, and means the day
   * somebody decides an admin should see more, the diff that does it is
   * visible in this function rather than buried in a caller. If this field is
   * ever read below, that is the bug.
   */
  readonly actorRole: PilotRole;
  readonly requestedSet: BlindingSubjectSet;
  /**
   * Every set on the same clip. The requested set and the reader's own may be
   * present or absent -- the decision does not depend on either appearing
   * here, so a caller can pass the raw result of a clip query without first
   * partitioning it.
   */
  readonly siblingSets: readonly BlindingSubjectSet[];
}

/** The one submitted-ness test. Anything that is not exactly the ratified
 *  token is not submitted, including 'SUBMITTED' and any status a later
 *  migration adds -- an unrecognised state is not evidence that somebody
 *  finished. */
function isSubmitted(set: BlindingSubjectSet): boolean {
  return set.status === 'submitted';
}

/**
 * THE DECISION. Pure, total, and the only place the rule is written.
 *
 * Order is load-bearing. Tenancy is checked first so a foreign set can never
 * reach the account-id comparison; ownership second so rule 1 cannot be
 * weakened by anything below it; then the reader's standing on the clip, then
 * the reader's own submission, then the sibling's. Each refusal names the
 * first thing that failed, not the last.
 */
export function resolveAnnotationSetVisibility(
  input: AnnotationSetVisibilityInput,
): AnnotationSetVisibility {
  const { actorAccountId, actorOrganizationId, requestedSet, siblingSets } = input;

  // Tenancy first. An account id from another gym that happens to collide
  // with one here must never be able to reach the ownership branch below --
  // nothing in this schema promises account ids are distinct across tenants,
  // and "your own set" resolved on the id alone would be a cross-tenant read
  // wearing rule 1 as a disguise.
  if (requestedSet.organization_id !== actorOrganizationId) {
    return { outcome: 'blinded', reason: 'different_organization' };
  }

  // Rule 1. Unconditional, and above every state check on purpose: an
  // annotator locked out of their own in-progress work cannot do the task.
  if (requestedSet.annotator_account_id === actorAccountId) {
    return { outcome: 'visible', reason: 'own_set' };
  }

  // Rule 2. "The reader's own set" means: same tenant, same clip, same
  // account. All three predicates matter. Same-tenant keeps another gym's row
  // from conferring standing; same-clip keeps submitting on clip 2 from
  // unlocking clip 1, because independence is a property of one clip at a
  // time.
  const readerOwnSet = siblingSets.find(
    (set) =>
      set.organization_id === actorOrganizationId
      && set.calibration_clip_id === requestedSet.calibration_clip_id
      && set.annotator_account_id === actorAccountId,
  );

  if (!readerOwnSet) {
    return { outcome: 'blinded', reason: 'not_an_annotator_of_this_clip' };
  }

  // Checked before the sibling's state, so the commonest refusal names the
  // reader's own outstanding work -- which is also the only half of the
  // answer they are entitled to know.
  if (!isSubmitted(readerOwnSet)) {
    return { outcome: 'blinded', reason: 'reader_not_submitted' };
  }

  if (!isSubmitted(requestedSet)) {
    return { outcome: 'blinded', reason: 'sibling_not_submitted' };
  }

  return { outcome: 'visible', reason: 'mutually_submitted' };
}

export type AdjudicationRefusalReason =
  /** Not an organization administrator. Checked FIRST, so a refusal to a
   *  coach says nothing about how far the clip has got. */
  | 'role_not_permitted'
  /** Nothing has been annotated here. There is no comparison to make, and
   *  "every set is submitted" is vacuously true of zero sets -- which would
   *  otherwise report an empty clip as ready for review. */
  | 'no_sets_on_clip'
  /** At least one set on the clip is unfinished. */
  | 'annotation_in_progress'
  /** Exactly one set on the clip, and it is submitted.
   *
   *  The zero case above is guarded because "every set is submitted" is
   *  vacuously true of an empty list. One set is the same mistake one step
   *  along: the predicate genuinely holds, but the premise this function
   *  exists to establish -- that there are TWO independent readings to put
   *  side by side -- does not. Reporting that as eligible promises a caller
   *  a pair and hands it a single reading.
   *
   *  Kept distinct from the two refusals above rather than folded into
   *  either, because both would be false statements about this clip. It is
   *  not empty, and nothing on it is unfinished. */
  | 'insufficient_sets_for_comparison'
  /** The actor produced one of the readings on this clip.
   *
   *  OD-2026-08-29-002. A person who produced one of the two readings cannot
   *  settle the disagreement between them: the whole point of two blind
   *  readings is that a third party resolves them, and a party to the
   *  disagreement grading their own work makes the calibration data unusable
   *  as evidence.
   *
   *  Checked before any state condition, for the reason the role check is
   *  first: an annotator refused here learns nothing about how far the OTHER
   *  annotator has got. Refusing them only once the clip was ready would leak
   *  the other reading's progress by the timing of the refusal.
   *
   *  The ratified cost: an organization whose only administrator also
   *  annotates has clips nobody can adjudicate. That was on the page when the
   *  decision was made -- it is a consequence, not an oversight, and not a
   *  thing to route around. `platform_owner` is refused on this surface
   *  deliberately, so it is not the escape hatch either. */
  | 'adjudicator_annotated_this_clip';

export type AdjudicationEligibility =
  | { readonly outcome: 'eligible'; readonly submittedSetCount: number }
  | { readonly outcome: 'refused'; readonly reason: AdjudicationRefusalReason };

export interface AdjudicationEligibilityInput {
  readonly actorRole: PilotRole;
  /** The person asking. Compared against every annotator on the clip. */
  readonly actorAccountId: string;
  /** Every set on the clip, already organization-scoped by the caller. */
  readonly sets: readonly BlindingSubjectSet[];
}

/**
 * MAY THIS PERSON SEE BOTH RAW READINGS YET.
 *
 * Two independent conditions, in this order.
 *
 * ROLE. Organization administrators only, via access.ts's own
 * isOrganizationAdminRole so that the legacy 'admin' spelling is honoured
 * here exactly as it is everywhere else. (There are two requireRole helpers
 * in this codebase: access.ts's, which knows admin and organization_admin are
 * one role, and http.ts's, which does not and would 403 every un-migrated
 * admin row. A route built on this module must take the access.ts one. This
 * function stays pure and consults the same alias table rather than
 * manufacturing an ActorIdentity to ask through.)
 *
 * platform_owner is absent, and that is a decision rather than an omission.
 * This surface exists so an organization can settle a disagreement between
 * its own two annotators; a platform-wide role is not a party to that, and
 * adding it here would be this file inventing a reach into tenant research
 * data that nobody ratified.
 *
 * STATE. Two sets on the clip, both submitted. Partial eligibility is not a
 * concept: an adjudicator who could read A while B is still working is a
 * channel from A into B by way of a conversation, which is the same leak the
 * annotator surface refuses, just routed through a third person.
 *
 * The count is part of the state condition, not a caller's problem. Zero
 * sets and one set both satisfy "every set is submitted" without there
 * being a pair to read, and this function promises its caller a pair.
 */
export function resolveAdjudicationEligibility(
  input: AdjudicationEligibilityInput,
): AdjudicationEligibility {
  if (!isOrganizationAdminRole(input.actorRole)) {
    return { outcome: 'refused', reason: 'role_not_permitted' };
  }

  // Identity before state, per the reason above. `sets` is already
  // organization-scoped by the caller, so an id matching here is a reading on
  // THIS clip in THIS organization and not a coincidence of account ids.
  if (input.sets.some((set) => set.annotator_account_id === input.actorAccountId)) {
    return { outcome: 'refused', reason: 'adjudicator_annotated_this_clip' };
  }

  if (input.sets.length === 0) {
    return { outcome: 'refused', reason: 'no_sets_on_clip' };
  }

  if (!input.sets.every(isSubmitted)) {
    return { outcome: 'refused', reason: 'annotation_in_progress' };
  }

  // Submission is checked before the count so that a lone UNSUBMITTED set is
  // reported as work in progress, which is both true and the more useful
  // thing to tell an adjudicator: a second reading may yet arrive.
  if (input.sets.length < 2) {
    return { outcome: 'refused', reason: 'insufficient_sets_for_comparison' };
  }

  return { outcome: 'eligible', submittedSetCount: input.sets.length };
}

/** Raised when the adjudication surface refuses.
 *
 * Carries the reason so a caller can log or report WHICH refusal happened,
 * the same way VideoNotClippableError carries the status it found. The
 * message prefixes are chosen for http.ts::jsonError: 'Forbidden' becomes a
 * 403 and 'Not found' a 404. A clip with no annotation sets is reported as a
 * 404 rather than a 403 because from the adjudicator's side there is nothing
 * there to be refused access to. */
export class AdjudicationNotPermittedError extends Error {
  readonly reason: AdjudicationRefusalReason;

  constructor(reason: AdjudicationRefusalReason) {
    super(
      reason === 'role_not_permitted'
        ? 'Forbidden: adjudication is limited to organization administrators'
        : reason === 'no_sets_on_clip'
          ? 'Not found: no annotation sets on this clip'
          : reason === 'annotation_in_progress'
            ? 'Forbidden: this clip is not ready for adjudication -- an annotation set on it has not been submitted'
            : reason === 'insufficient_sets_for_comparison'
              ? 'Forbidden: this clip has 1 submitted annotation set, and adjudication is '
                + 'pairwise -- it puts exactly two independent readings side by side'
              : 'Forbidden: you annotated this clip, and adjudication is settled by someone '
                + 'who did not produce either reading',
    );
    this.name = 'AdjudicationNotPermittedError';
    this.reason = reason;
  }
}

export interface AnnotatorReadContext {
  readonly organizationId: string;
  readonly actorAccountId: string;
  readonly actorRole: PilotRole;
}

/**
 * THE ANNOTATOR-FACING READ. The one a labelling screen may call.
 *
 * Returns only the sets this reader is entitled to see. A blinded set is
 * omitted from the array entirely -- not returned with its fields nulled --
 * so the response carries no count, no id, no created_at and no "one other
 * annotator is working on this" for the reader to calibrate against. The
 * result of an in-progress double annotation is a one-element array
 * containing the reader's own set, and it is indistinguishable from a clip
 * only that reader was ever assigned.
 *
 * A reader with no set on the clip gets an empty array, whatever their role.
 */
export async function listAnnotationSetsForAnnotator(
  context: AnnotatorReadContext,
  calibrationClipId: string,
): Promise<AnnotationSetRow[]> {
  // The unblinded org-scoped read, which is what this module exists to wrap.
  // Reusing it rather than restating its SQL keeps one definition of "the
  // sets on this clip"; the blinding is applied below, on every row, before
  // anything is returned.
  const sets = await listAnnotationSetsForClip(context.organizationId, calibrationClipId);

  return sets.filter(
    (set) =>
      resolveAnnotationSetVisibility({
        actorAccountId: context.actorAccountId,
        actorOrganizationId: context.organizationId,
        actorRole: context.actorRole,
        requestedSet: set,
        siblingSets: sets,
      }).outcome === 'visible',
  );
}

/**
 * One set by id, or null.
 *
 * NULL MEANS BOTH THINGS. A set that does not exist and a set the reader is
 * blinded from both answer null, so a caller cannot use this to discover that
 * a second annotator exists. The route above this turns null into
 * http.ts::hiddenNotFound() and the two remain the same 404 to the client.
 */
export async function getAnnotationSetForAnnotator(
  context: AnnotatorReadContext,
  annotationSetId: string,
): Promise<AnnotationSetRow | null> {
  const set = await getAnnotationSet(context.organizationId, annotationSetId);
  if (!set) {
    return null;
  }

  const siblingSets = await listAnnotationSetsForClip(
    context.organizationId,
    set.calibration_clip_id,
  );

  const visibility = resolveAnnotationSetVisibility({
    actorAccountId: context.actorAccountId,
    actorOrganizationId: context.organizationId,
    actorRole: context.actorRole,
    requestedSet: set,
    siblingSets,
  });

  return visibility.outcome === 'visible' ? set : null;
}

/**
 * The events of one set, or null.
 *
 * Gated by the same decision as the set itself, because the events ARE the
 * annotation -- a surface that hid the set row and served its events would
 * have blinded the label and disclosed the thing the label names. Null
 * carries the same double meaning as in getAnnotationSetForAnnotator: no such
 * set, or not yours to know about.
 *
 * An empty ARRAY is a real answer -- a visible set with nothing recorded in it
 * yet -- and must not be conflated with the null.
 */
export async function listAnnotationEventsForAnnotator(
  context: AnnotatorReadContext,
  annotationSetId: string,
): Promise<AnnotationEventRow[] | null> {
  const set = await getAnnotationSetForAnnotator(context, annotationSetId);
  if (!set) {
    return null;
  }

  return listAnnotationEvents(context.organizationId, annotationSetId);
}

export interface AdjudicationReadContext {
  readonly organizationId: string;
  readonly actorRole: PilotRole;
  /** The person asking, so the gate can refuse an annotator of this clip. */
  readonly actorAccountId: string;
}

/**
 * THE ADJUDICATION SURFACE. Separate, explicit, and narrow.
 *
 * Everything the annotator surface withholds is available here, and only
 * here, and only once resolveAdjudicationEligibility says so. It THROWS
 * rather than returning an empty list: an adjudicator who asked too early
 * needs to be told the clip is not ready, and an empty array would read as
 * "nobody annotated this" -- a false statement, and one that would send them
 * looking for a problem that does not exist.
 *
 * The refusal messages are safe to show. Their audience is an organization
 * administrator asking about their own organization's clip, who may already
 * read every set on it through the QA path; what this gate adds is that they
 * cannot do it through a surface that presents itself as review, and cannot
 * do it before the annotation is finished.
 *
 * NO COMPARISON, NO SCORING, NO ADJUDICATION RECORD. This function hands back
 * two raw readings. What is done with them is a later slice's concern and
 * must not be smuggled in here.
 */
export async function listAnnotationSetsForAdjudication(
  context: AdjudicationReadContext,
  calibrationClipId: string,
): Promise<AnnotationSetRow[]> {
  const sets = await listAnnotationSetsForClip(context.organizationId, calibrationClipId);

  const eligibility = resolveAdjudicationEligibility({
    actorRole: context.actorRole,
    actorAccountId: context.actorAccountId,
    sets,
  });

  if (eligibility.outcome === 'refused') {
    throw new AdjudicationNotPermittedError(eligibility.reason);
  }

  return sets;
}

/**
 * The events of one set, for adjudication.
 *
 * Gated on the CLIP's eligibility, not the set's, for the reason
 * resolveAdjudicationEligibility gives: reading one annotator's events while
 * the other is still working turns the adjudicator into the channel between
 * them.
 *
 * Returns null when the set is not on this clip in this organization, so a
 * mismatched pair of ids cannot be used to reach a set whose own clip is
 * nowhere near eligible.
 */
export async function listAnnotationEventsForAdjudication(
  context: AdjudicationReadContext,
  calibrationClipId: string,
  annotationSetId: string,
): Promise<AnnotationEventRow[] | null> {
  const sets = await listAnnotationSetsForAdjudication(context, calibrationClipId);

  const target = sets.find((set) => set.annotation_set_id === annotationSetId);
  if (!target) {
    return null;
  }

  return listAnnotationEvents(context.organizationId, annotationSetId);
}
