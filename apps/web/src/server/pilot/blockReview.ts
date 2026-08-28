import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';
import { ValidationError } from './errors';

// Plan versus what was actually recorded, and the coach's judgement about the
// difference.
//
// TWO HALVES THAT ARE NOT THE SAME KIND OF THING, and keeping them apart is
// the whole design:
//
//   THE JUDGEMENT is stored. A human picks one of five states and writes what
//   departed from the plan, why, what worked, what did not, and what they
//   intend to adjust.
//
//   THE EVIDENCE is not stored. It is read, at read time, out of records that
//   already exist for that athlete in that block's window. This module keeps
//   no copy, derives no figure from it, and does not decide what it means.
//
// THE ORDER REFUSES THE NUMBER, AND SO DOES THIS: "Do not invent an adherence
// percentage. If adherence needs a judgment, use a human-selected state such
// as the existing intervention vocabulary." So ADHERENCE_STATES below is
// pilot.intervention_executions' vocabulary, imported rather than restated,
// and nothing here computes a ratio, a coverage figure, a completion
// percentage or a score.
//
// WHAT A COUNT MEANS HERE, precisely, because this is the one surface in the
// lane that counts anything at all. Every earlier surface refused to count,
// so that this question would arrive undecided; the order asks for "what was
// actually recorded", and a count of records IS what was recorded. It is a
// statement about the RECORD, never about the coach or the athlete:
//
//   "12 training attempts recorded"   is a fact about the database.
//   "12 of 20 sessions delivered"     would be a fact about a coach, and
//                                     there is no denominator anywhere that
//                                     could honestly produce one.
//
// AND A ZERO IS NOT A FINDING. Nothing recorded means nobody recorded
// anything -- not that the athlete did not train, and not that the coach
// neglected the block. Every count below is labelled `recorded` for that
// reason, and every caller is obliged to keep the word.
//
// EVERY SOURCE IS WINDOWED ON WHEN THE THING HAPPENED, NEVER ON WHEN THE ROW
// WAS WRITTEN. That is not free: two of the six carry a NULLABLE event date.
// pilot.assessments.administered_on is null for one that was scheduled and
// not yet done -- the assessment_protocols migration indexes exactly that as
// the pending case -- and pilot.intervention_executions.actual_start is null
// for one that has not started. Windowing either by created_at instead would
// count a scheduled-and-never-administered assessment as evidence that a plan
// was carried out, which is the most flattering possible way to be wrong.
//
// SO A THIRD STATE EXISTS AND IS KEPT SEPARATE. A row with no event date is
// not "in the window" and not "outside" it: no window can place it. Every
// source carries `undated` beside `recorded` for that reason, and the
// surfaces show both. Folding them together in either direction is a lie --
// one way invents activity, the other hides records that exist.

export const ADHERENCE_STATES = [
  'delivered_as_planned',
  'delivered_with_deviations',
  'under_delivered',
  'not_delivered',
  'unknown',
] as const;

export type AdherenceState = (typeof ADHERENCE_STATES)[number];

export interface BlockReviewRow {
  organization_id: string;
  review_id: string;
  block_id: string;
  adherence_state: AdherenceState;
  deviations: string;
  reason: string;
  what_worked: string;
  what_did_not: string;
  next_adjustment: string;
  reviewed_by_account_id: string;
  created_at: string;
}

export interface BlockReviewInput {
  adherenceState?: AdherenceState;
  deviations?: string;
  reason?: string;
  whatWorked?: string;
  whatDidNot?: string;
  nextAdjustment?: string;
}

/**
 * One evidence source's contribution to the "actual" half.
 *
 * Two counts, because there are two honest answers and only one of them is
 * about the window.
 */
export interface EvidenceSource {
  key: string;
  label: string;
  /** How many rows this source has in the window. A count of the RECORD. */
  recorded: number;
  /**
   * Rows this source holds for this athlete that carry NO event date, so no
   * window can place them -- a scheduled assessment nobody has administered,
   * an intervention that has not started. Always 0 for the four sources whose
   * event date is NOT NULL.
   *
   * Kept separate rather than added to `recorded` (which would claim activity
   * that has not happened) or dropped (which would hide records that exist).
   */
  undated: number;
  /** The most recent few, so a coach reads entries rather than a number. */
  recent: { when: string; detail: string }[];
}

const REVIEW_FIELDS = `organization_id, review_id, block_id, adherence_state,
  deviations, reason, what_worked, what_did_not, next_adjustment,
  reviewed_by_account_id, created_at`;

/**
 * The reason a review input is refused, or null when it is sound.
 *
 * Restates the table's own CHECK constraints where a caller can be told which
 * one they broke. The database remains the authority; this existing is not a
 * reason to trust a write path that skips it.
 */
export function blockReviewShapeError(input: BlockReviewInput): string | null {
  const state = input.adherenceState ?? 'unknown';
  if (!(ADHERENCE_STATES as readonly string[]).includes(state)) {
    return `Unknown adherence state '${state}'.`;
  }
  if (state === 'delivered_with_deviations' && !input.deviations?.trim()) {
    // The rule the intervention ledger already holds: an adherence state that
    // names a departure without recording it is a judgement nobody can review.
    return 'Recording "delivered with deviations" means saying what the deviations were.';
  }
  return null;
}

/**
 * Records a coach's review of a block.
 *
 * The caller is responsible for clearing the block through
 * getDevelopmentBlock first -- a block id is only obtainable from a read that
 * did, and this module deliberately does not reach for the session principal.
 * Reviews are never amended: a judgement someone recorded at the time is a
 * fact about that time, so a changed mind is a new dated row.
 */
export async function recordBlockReview(input: BlockReviewInput & {
  organizationId: string;
  blockId: string;
  reviewedByAccountId: string;
}): Promise<BlockReviewRow> {
  const shapeError = blockReviewShapeError(input);
  if (shapeError) {
    throw new ValidationError(shapeError, 'BLOCK_REVIEW_INVALID');
  }

  const reviewId = randomUUID();
  await queryOne(
    `insert into pilot.athlete_development_block_reviews
       (organization_id, review_id, block_id, adherence_state, deviations,
        reason, what_worked, what_did_not, next_adjustment, reviewed_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning review_id`,
    [
      input.organizationId,
      reviewId,
      input.blockId,
      input.adherenceState ?? 'unknown',
      input.deviations?.trim() ?? '',
      input.reason?.trim() ?? '',
      input.whatWorked?.trim() ?? '',
      input.whatDidNot?.trim() ?? '',
      input.nextAdjustment?.trim() ?? '',
      input.reviewedByAccountId,
    ],
  );

  const created = await queryOne<BlockReviewRow>(
    `select ${REVIEW_FIELDS} from pilot.athlete_development_block_reviews
     where organization_id = $1 and review_id = $2`,
    [input.organizationId, reviewId],
  );
  if (!created) throw new Error('BLOCK_REVIEW_VANISHED');
  return created;
}

/**
 * A block's reviews, newest first.
 *
 * All of them, not just the latest: an earlier review saying the block was
 * off track and a later one saying it recovered are both true, and showing
 * only the second erases the more useful half.
 */
export async function listBlockReviews(
  organizationId: string,
  blockId: string,
): Promise<BlockReviewRow[]> {
  return query<BlockReviewRow>(
    `select ${REVIEW_FIELDS} from pilot.athlete_development_block_reviews
     where organization_id = $1 and block_id = $2
     order by created_at desc, review_id`,
    [organizationId, blockId],
  );
}

const RECENT_LIMIT = 5;

/**
 * What is actually on record for this block's athlete, in this block's window.
 *
 * SIX SOURCES, ALL PRE-EXISTING. Nothing here writes, and nothing here is a
 * new store of training facts -- the order says "Use existing factual records
 * only" and this reads exactly that.
 *
 * The sessions source is the strongest of the six and is the only one that is
 * not merely date-adjacent: it comes from the link a coach explicitly made
 * (#784), so it says "this class served this plan" rather than "this class
 * happened while this plan was running". The other five are windowed on the
 * athlete and the dates, which is an association, not a claim of purpose --
 * and the surfaces are obliged to say so.
 *
 * Each source is read independently. One failing is not made to look like a
 * zero: the caller gets an exception and renders unavailability, because a
 * silent 0 here would be indistinguishable from "nothing was recorded", which
 * is the one confusion this whole panel exists to avoid.
 */
export async function blockEvidence(
  organizationId: string,
  athleteId: string,
  blockId: string,
  startsOn: string,
  endsOn: string,
): Promise<EvidenceSource[]> {
  const window = [organizationId, athleteId, startsOn, endsOn];

  /* Two groups, run together. The first six are the window reads; the last
     two count the rows no window can place. Nested so the tuple types stay
     tuples -- one flat Promise.all over eight differently-shaped queries
     infers a union and loses which is which. */
  const [
    [sessions, attempts, activity, assessments, executions, reviews],
    [undatedAssessments, undatedExecutions],
  ] = await Promise.all([
    Promise.all([
      /* The coach's own statement of which delivered sessions served this
         block. Scoped by the LINK, not by the date window -- a coach who
         links a session outside the block's stated dates meant to, and
         second-guessing them here would silently drop the record. */
      query<{ when: string; detail: string }>(
        `select r.delivered_on::text as when, s.name as detail
         from pilot.session_run_development_block_links l
         join pilot.session_script_runs r
           on r.organization_id = l.organization_id and r.run_id = l.run_id
         join pilot.session_scripts s
           on s.organization_id = r.organization_id and s.script_id = r.script_id
         where l.organization_id = $1 and l.block_id = $2
         order by r.delivered_on desc, r.run_id`,
        [organizationId, blockId],
      ),
      query<{ when: string; detail: string }>(
        `select a.attempted_at::date::text as when,
                coalesce(nullif(a.context_type, ''), 'attempt') as detail
         from pilot.training_attempts a
         where a.organization_id = $1 and a.athlete_id = $2
           and a.attempted_at::date between $3::date and $4::date
         order by a.attempted_at desc`,
        window,
      ),
      /* BOXING ROWS ONLY, which is CT-13's own rank-1 rule rather than a new
         one. pilot.activity_log is cross-domain -- schoolwork, community
         service and work-study hours live in it beside training -- and all
         ten Full Spectrum domains a block's objectives can name are athletic.
         A tutoring session counted as evidence that a TRAINING plan was
         carried out would be a true record answering a question nobody asked.

         This is a single-source read of one athlete's own rows, labelled as
         entries recorded. It is not a participation figure and no rate is
         derived from it, so it does not cross the sources CT-13 forbids
         crossing -- see attendancePrecedence.test.ts, where this file is
         registered with that reason. */
      query<{ when: string; detail: string }>(
        `select l.occurred_on::text as when,
                coalesce(nullif(l.what_was_worked_on, ''), l.activity_type) as detail
         from pilot.activity_log l
         where l.organization_id = $1 and l.athlete_id = $2
           and l.activity_domain = 'boxing_training'
           and l.occurred_on between $3::date and $4::date
         order by l.occurred_on desc`,
        window,
      ),
      /* administered_on, which is when the assessment was ADMINISTERED --
         not created_at, which is when somebody made the row. The difference
         is not academic: administered_on is null precisely for an assessment
         that was scheduled and never done (the assessment_protocols migration
         indexes exactly that as the pending case), so windowing by created_at
         would count a test nobody administered as evidence that a plan was
         carried out. Those rows are counted below instead. */
      query<{ when: string; detail: string }>(
        `select a.administered_on::text as when, a.assessment_type as detail
         from pilot.assessments a
         where a.organization_id = $1 and a.athlete_id = $2
           and a.administered_on between $3::date and $4::date
         order by a.administered_on desc`,
        window,
      ),
      /* actual_start, for the same reason: an execution that has not started
         has none, and its created_at would place a plan inside the window as
         though it had been delivered. */
      query<{ when: string; detail: string }>(
        `select e.actual_start::date::text as when, e.adherence as detail
         from pilot.intervention_executions e
         where e.organization_id = $1 and e.athlete_id = $2
           and e.actual_start::date between $3::date and $4::date
         order by e.actual_start desc`,
        window,
      ),
      /* Coach reviews reach an athlete only through the session they are
         about, and pilot.sessions carries a real date -- so this one is
         windowed on when the session HAPPENED, not when the review was
         typed. */
      query<{ when: string; detail: string }>(
        `select s.date::text as when, cr.decision as detail
         from pilot.coach_reviews cr
         join pilot.sessions s
           on s.organization_id = cr.organization_id and s.session_id = cr.session_id
         where cr.organization_id = $1 and s.athlete_id = $2
           and s.date between $3::date and $4::date
         order by s.date desc, cr.review_id`,
        window,
      ),
    ]),
    /* The two undated counts. Deliberately NOT window-scoped: there is no
       date to scope them by, which is the entire reason they are counted
       apart from the six above. */
    Promise.all([
      queryOne<{ undated: string }>(
        `select count(*)::text as undated from pilot.assessments a
         where a.organization_id = $1 and a.athlete_id = $2
           and a.administered_on is null`,
        [organizationId, athleteId],
      ),
      queryOne<{ undated: string }>(
        `select count(*)::text as undated from pilot.intervention_executions e
         where e.organization_id = $1 and e.athlete_id = $2
           and e.actual_start is null`,
        [organizationId, athleteId],
      ),
    ]),
  ]);

  const build = (
    key: string,
    label: string,
    rows: { when: string; detail: string }[],
    undated = 0,
  ): EvidenceSource => ({
    key,
    label,
    recorded: rows.length,
    undated,
    recent: rows.slice(0, RECENT_LIMIT),
  });

  return [
    build('sessions', 'Sessions linked to this block', sessions),
    build('training_attempts', 'Training attempts recorded', attempts),
    build('activity_log', 'Training activity entries recorded', activity),
    build('coach_reviews', 'Coach reviews of sessions', reviews),
    build('assessments', 'Assessments administered', assessments,
      Number(undatedAssessments?.undated ?? 0)),
    build('intervention_executions', 'Intervention executions recorded', executions,
      Number(undatedExecutions?.undated ?? 0)),
  ];
}
