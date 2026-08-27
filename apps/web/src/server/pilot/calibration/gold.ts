import { query, queryOne, withTransaction } from '../db';
import { isInVocabulary } from './ontology';

// Gold / reference-dataset governance -- the deliberate act by which one
// adjudicated reading becomes part of a dataset this project is willing to
// build against, and the labels that say what it may be used for.
//
// WHY THERE IS A MODULE HERE AT ALL, AND WHY IT IS NOT THE SAFETY. The four
// slices beneath this one produce readings and decisions; none of them
// produces a DATASET. This module is the narrow door between the two. It is
// NOT where the rules live. Every rule that matters is in the database --
// pilot_slice_postgres_calibration_gold_migration.sql -- because a backfill, a
// cleanup script, a future feeder's migration and a psql session all have
// write access and none of them come through this file. The checks below exist
// to produce a clear 400 naming the field, one layer above a constraint
// violation naming a constraint.
//
// NOTHING IS PROMOTED AUTOMATICALLY, AND THERE IS NO BULK PATH. There is no
// function in this module that promotes more than one record, and there is
// deliberately no array-shaped variant of promoteGoldRecord. That is not an
// oversight to be filled in later by whoever finds it tedious: "promote
// everything adjudicated in this project" is precisely the act the owner's
// order forbids, and a bulk helper is how it arrives wearing a reasonable
// name. One record, one named human, one act.
//
// NOTHING HERE TRAINS ANYTHING. This module records what MAY be used. It reads
// no model, writes no corpus, emits no SHADOW event, exports nothing, and has
// no HTTP route. TRAINING_ELIGIBLE is a permission, not an instruction.
//
// NO SCORE. There is no accuracy, confidence, quality or agreement figure on a
// gold record, and none may be added here. A number attached to one of these
// rows would be read as a property of the reading rather than of the process
// that produced it, and nothing in this subsystem has earned the right to
// publish one.

/** Where a governance record is in its life.
 *
 * A record ARRIVES as 'candidate' -- adjudicated and nominated, but not part
 * of the reference dataset. 'gold' is reached only by promoteGoldRecord, and
 * the database refuses an INSERT that tries to arrive there (see the
 * born-candidate trigger). 'excluded' is a decision to keep a reading out. */
export const GOLD_GOVERNANCE_STATES = ['candidate', 'gold', 'excluded'] as const;
export type GoldGovernanceState = (typeof GOLD_GOVERNANCE_STATES)[number];

/** What a governed record may be used for.
 *
 * UPPERCASE VERBATIM, as the owner's order writes them, and unlike every other
 * vocabulary in this subsystem -- which is lower-case -- because these are not
 * observations. They are policy labels, and the case difference is a standing
 * reminder of which kind of value a reader is looking at.
 *
 * ORDERED LOOSEST TO TIGHTEST, and the order is load-bearing: it is the ratchet
 * this module refuses to turn backwards, and the database refuses under it. */
export const GOLD_ELIGIBILITIES = ['TRAINING_ELIGIBLE', 'VALIDATION_ONLY', 'LOCKED_TEST'] as const;
export type GoldEligibility = (typeof GOLD_ELIGIBILITIES)[number];

/**
 * How tightly held a label is. Higher is tighter.
 *
 * Used ONLY to produce a readable 400 before the database refuses the same
 * move with a constraint name. Deleting this function would not loosen the
 * rule by one row -- pilot_calibration_gold_records_eligibility_ratchet is
 * what actually holds it, because it also sees the writers that never call
 * this file.
 */
function eligibilityRank(eligibility: GoldEligibility): number {
  return GOLD_ELIGIBILITIES.indexOf(eligibility);
}

export interface GoldRecordRow {
  organization_id: string;
  gold_record_id: string;
  calibration_project_id: string;
  calibration_clip_id: string;
  video_session_id: string;
  ontology_version: string;
  adjudication_id: string;
  adjudicator_account_id: string;
  annotation_set_id_a: string;
  annotation_set_id_b: string;
  governance_state: string;
  eligibility: string;
  promoted_by_account_id: string | null;
  // TYPED AS THE REST OF pilot/* TYPES ITS TIMESTAMPS, AND THE SAME WAY WRONG.
  // db.ts overrides the type parser for OID 1082 (DATE) only, so a timestamptz
  // arrives as a JS Date, not a string -- here and in every other row interface
  // in this directory. Matched rather than corrected: a lone honest module here
  // would be the odd one out, and repairing the convention is its own change.
  promoted_at: string | null;
  notes: string | null;
  created_at: string;
}

const GOLD_COLUMNS = `
  organization_id, gold_record_id, calibration_project_id, calibration_clip_id,
  video_session_id, ontology_version, adjudication_id, adjudicator_account_id,
  annotation_set_id_a, annotation_set_id_b, governance_state, eligibility,
  promoted_by_account_id, promoted_at, notes, created_at
`;

/** The provenance a nomination copies off the decision it is made from.
 *
 * Read from the database rather than accepted from the caller -- see
 * nominateGoldCandidate. */
interface AdjudicationProvenanceRow {
  calibration_clip_id: string;
  calibration_project_id: string;
  video_session_id: string;
  ontology_version: string;
  adjudicator_account_id: string;
  annotation_set_id_a: string;
  annotation_set_id_b: string;
  resolution_type: string;
  missed_event_verdict: string | null;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value.trim();
}

export interface NominateGoldCandidateInput {
  organizationId: string;
  goldRecordId: string;
  /** The settled decision this record is a governance record FOR. */
  adjudicationId: string;
  eligibility: GoldEligibility;
  notes?: string | null;
}

/**
 * Nominates one adjudicated reading as a CANDIDATE for the reference dataset.
 *
 * NOT A PROMOTION. This is the cheap, reversible half: it says "this reading is
 * worth considering", and nothing downstream may read a candidate as reference
 * data. Promotion is promoteGoldRecord, a separate call by a separate named
 * human, and the database refuses to let this function reach 'gold' even if
 * someone later edits the insert below -- the born-candidate trigger sees it.
 * Note that governance_state is not in the column list at all: this module has
 * no syntax for arriving promoted.
 *
 * PROVENANCE IS READ, NOT ACCEPTED. The caller names an adjudication and
 * nothing else about where the reading came from. The project, the clip, the
 * source video, the ontology version, the adjudicator and BOTH annotators' set
 * ids are looked up from the adjudication and its clip inside this
 * transaction. A signature that took them as parameters would be a signature
 * that can be called with a plausible lie, and "which two people produced this
 * reading" is the one question a governed dataset must never get wrong. The
 * composite foreign keys refuse a mismatch even so; this is why they never
 * have to.
 *
 * REFUSES an adjudication that settled nothing. 'unresolvable' -- as a
 * resolution type or as a missed-event verdict -- is an honest and useful
 * result, and it is the one result there is no reading to promote from. The
 * adjudication migration's own comment says why this matters: "a gold dataset
 * built from forced verdicts would carry a confidence nobody earned". A gold
 * dataset built from UNRESOLVED ones would be worse -- it would carry a
 * verdict nobody reached.
 *
 * ONE TRANSACTION for the read and the write, so a nomination can never be
 * written against provenance that changed underneath it.
 */
export async function nominateGoldCandidate(
  input: NominateGoldCandidateInput,
): Promise<GoldRecordRow> {
  if (!isInVocabulary(GOLD_ELIGIBILITIES, input.eligibility)) {
    throw new Error(
      'Missing eligibility: must be one of TRAINING_ELIGIBLE, VALIDATION_ONLY, LOCKED_TEST',
    );
  }

  const organizationId = requireNonEmpty(input.organizationId, 'organization_id');
  const goldRecordId = requireNonEmpty(input.goldRecordId, 'gold_record_id');
  const adjudicationId = requireNonEmpty(input.adjudicationId, 'adjudication_id');

  return withTransaction(async (client) => {
    const provenance = await client.query<AdjudicationProvenanceRow>(
      `select
         adj.calibration_clip_id,
         adj.ontology_version,
         adj.adjudicator_account_id,
         adj.annotation_set_id_a,
         adj.annotation_set_id_b,
         adj.resolution_type,
         adj.missed_event_verdict,
         clip.calibration_project_id,
         clip.video_session_id
       from pilot.calibration_adjudications adj
       join pilot.calibration_clips clip
         on clip.organization_id = adj.organization_id
        and clip.calibration_clip_id = adj.calibration_clip_id
      where adj.organization_id = $1 and adj.adjudication_id = $2`,
      [organizationId, adjudicationId],
    );

    const source = provenance.rows[0];
    if (!source) {
      throw new Error('Not found: no such adjudication in this organization');
    }

    if (source.resolution_type === 'unresolvable' || source.missed_event_verdict === 'unresolvable') {
      throw new Error(
        'Missing resolution_type: an unresolvable adjudication settled no reading to govern',
      );
    }

    const inserted = await client.query<GoldRecordRow>(
      `insert into pilot.calibration_gold_records
         (organization_id, gold_record_id, calibration_project_id, calibration_clip_id,
          video_session_id, ontology_version, adjudication_id, adjudicator_account_id,
          annotation_set_id_a, annotation_set_id_b, eligibility, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning ${GOLD_COLUMNS}`,
      [
        organizationId,
        goldRecordId,
        source.calibration_project_id,
        source.calibration_clip_id,
        source.video_session_id,
        source.ontology_version,
        adjudicationId,
        source.adjudicator_account_id,
        source.annotation_set_id_a,
        source.annotation_set_id_b,
        input.eligibility,
        input.notes ?? null,
      ],
    );

    const row = inserted.rows[0];
    if (!row) {
      throw new Error('CALIBRATION_GOLD_WRITE_FAILED');
    }
    return row;
  });
}

export interface PromoteGoldRecordInput {
  organizationId: string;
  /** ONE record. There is no plural form of this parameter on purpose. */
  goldRecordId: string;
  /** The human taking responsibility for this reading being reference data. */
  promotedByAccountId: string;
}

/**
 * Promotes ONE candidate to 'gold', attributed to one named account.
 *
 * THE ACT THE OWNER'S ORDER REQUIRES TO BE DELIBERATE. Everything about this
 * function is shaped to keep it that way: it takes exactly one record id, it
 * requires a promoter, and the conditional UPDATE means a record that is
 * already gold is not silently re-promoted with a fresh timestamp and a
 * different name. The database's promotion-attestation CHECK refuses an
 * unattributed 'gold' row underneath all of it, so a caller that bypasses this
 * module gains nothing.
 *
 * PROMOTES FROM 'candidate' ONLY. An excluded record is a decision somebody
 * made to keep a reading out, and quietly reversing it through the promote
 * path would make exclusion advisory. Reversing an exclusion is a real need
 * and a real conversation; it is not this function.
 *
 * ELIGIBILITY IS NOT TOUCHED HERE. Promotion answers "is this reference data";
 * eligibility answers "what may it be used for". Fusing them would mean a
 * promotion could quietly widen a held-out record, which is the exact failure
 * this slice exists to prevent.
 */
export async function promoteGoldRecord(input: PromoteGoldRecordInput): Promise<GoldRecordRow> {
  const organizationId = requireNonEmpty(input.organizationId, 'organization_id');
  const goldRecordId = requireNonEmpty(input.goldRecordId, 'gold_record_id');
  const promotedByAccountId = requireNonEmpty(input.promotedByAccountId, 'promoted_by_account_id');

  return withTransaction(async (client) => {
    const promoted = await client.query<GoldRecordRow>(
      `update pilot.calibration_gold_records
          set governance_state = 'gold',
              promoted_by_account_id = $3,
              promoted_at = now()
        where organization_id = $1
          and gold_record_id = $2
          and governance_state = 'candidate'
        returning ${GOLD_COLUMNS}`,
      [organizationId, goldRecordId, promotedByAccountId],
    );

    const row = promoted.rows[0];
    if (row) {
      return row;
    }

    // The UPDATE matched nothing. Say WHICH of the two reasons it was, rather
    // than reporting a missing record for one that is merely already settled.
    const existing = await client.query<{ governance_state: string }>(
      `select governance_state from pilot.calibration_gold_records
        where organization_id = $1 and gold_record_id = $2`,
      [organizationId, goldRecordId],
    );
    const current = existing.rows[0];
    if (!current) {
      throw new Error('Not found: no such gold record in this organization');
    }
    throw new Error(
      `Missing governance_state: only a candidate can be promoted, and this record is '${current.governance_state}'`,
    );
  });
}

export interface ExcludeGoldRecordInput {
  organizationId: string;
  goldRecordId: string;
  notes?: string | null;
}

/**
 * Marks ONE candidate 'excluded' -- a decision to keep a reading out of the
 * reference dataset.
 *
 * FROM 'candidate' ONLY, for the mirror of the reason promotion is: undoing a
 * promotion by this path would mean the promotion attribution had to be erased
 * in the same statement to satisfy the attestation CHECK, and a record that
 * forgets it was ever promoted is worse than one that is still promoted and
 * wrong.
 *
 * KNOWN GAP, stated rather than hidden: an exclusion carries no attribution.
 * The migration says the same. Adding excluded_by/excluded_at means adding a
 * CHECK tying them to the state, and that is a decision for whoever needs the
 * exclusion audit rather than a guess made here.
 */
export async function excludeGoldRecord(input: ExcludeGoldRecordInput): Promise<GoldRecordRow> {
  const organizationId = requireNonEmpty(input.organizationId, 'organization_id');
  const goldRecordId = requireNonEmpty(input.goldRecordId, 'gold_record_id');

  return withTransaction(async (client) => {
    const excluded = await client.query<GoldRecordRow>(
      `update pilot.calibration_gold_records
          set governance_state = 'excluded',
              notes = coalesce($3, notes)
        where organization_id = $1
          and gold_record_id = $2
          and governance_state = 'candidate'
        returning ${GOLD_COLUMNS}`,
      [organizationId, goldRecordId, input.notes ?? null],
    );

    const row = excluded.rows[0];
    if (row) {
      return row;
    }

    const existing = await client.query<{ governance_state: string }>(
      `select governance_state from pilot.calibration_gold_records
        where organization_id = $1 and gold_record_id = $2`,
      [organizationId, goldRecordId],
    );
    const current = existing.rows[0];
    if (!current) {
      throw new Error('Not found: no such gold record in this organization');
    }
    throw new Error(
      `Missing governance_state: only a candidate can be excluded, and this record is '${current.governance_state}'`,
    );
  });
}

export interface TightenGoldEligibilityInput {
  organizationId: string;
  goldRecordId: string;
  eligibility: GoldEligibility;
}

/**
 * Moves ONE record to a TIGHTER eligibility. The only eligibility mutation
 * this module offers, and the name says why.
 *
 * THE RATCHET TURNS ONE WAY. TRAINING_ELIGIBLE -> VALIDATION_ONLY ->
 * LOCKED_TEST, and never back. Discovering that a clip belongs in the held-out
 * set after all must be actionable at any point, including after promotion, so
 * this works on a 'gold' record too. Discovering the opposite must NOT be
 * actionable, because that is indistinguishable -- from the database's side
 * and from a reader's -- from a held-out test set being quietly reclassified
 * as training data.
 *
 * THIS CHECK IS NOT THE SAFETY. pilot_calibration_gold_records_eligibility_
 * ratchet refuses the same move in the database, where it also sees the
 * backfills, cleanups and migrations that never call this function. What the
 * comparison below buys is a 400 that names the two labels instead of a 500
 * that names a trigger.
 */
export async function tightenGoldEligibility(
  input: TightenGoldEligibilityInput,
): Promise<GoldRecordRow> {
  if (!isInVocabulary(GOLD_ELIGIBILITIES, input.eligibility)) {
    throw new Error(
      'Missing eligibility: must be one of TRAINING_ELIGIBLE, VALIDATION_ONLY, LOCKED_TEST',
    );
  }
  const organizationId = requireNonEmpty(input.organizationId, 'organization_id');
  const goldRecordId = requireNonEmpty(input.goldRecordId, 'gold_record_id');

  return withTransaction(async (client) => {
    const existing = await client.query<{ eligibility: string }>(
      `select eligibility from pilot.calibration_gold_records
        where organization_id = $1 and gold_record_id = $2
        for update`,
      [organizationId, goldRecordId],
    );
    const current = existing.rows[0];
    if (!current) {
      throw new Error('Not found: no such gold record in this organization');
    }

    if (!isInVocabulary(GOLD_ELIGIBILITIES, current.eligibility)) {
      // Unreachable through this module and through the column's CHECK. Kept
      // because the alternative to noticing is treating an unrecognised label
      // as rank -1, which would make every move look like a tightening.
      throw new Error('Missing eligibility: the stored eligibility is not a recognised label');
    }

    if (eligibilityRank(input.eligibility) < eligibilityRank(current.eligibility)) {
      throw new Error(
        `Missing eligibility: ${current.eligibility} cannot be loosened to ${input.eligibility}`,
      );
    }

    const updated = await client.query<GoldRecordRow>(
      `update pilot.calibration_gold_records
          set eligibility = $3
        where organization_id = $1 and gold_record_id = $2
        returning ${GOLD_COLUMNS}`,
      [organizationId, goldRecordId, input.eligibility],
    );

    const row = updated.rows[0];
    if (!row) {
      throw new Error('CALIBRATION_GOLD_WRITE_FAILED');
    }
    return row;
  });
}

export async function getGoldRecord(
  organizationId: string,
  goldRecordId: string,
): Promise<GoldRecordRow | null> {
  return queryOne<GoldRecordRow>(
    `select ${GOLD_COLUMNS}
       from pilot.calibration_gold_records
      where organization_id = $1 and gold_record_id = $2`,
    [organizationId, goldRecordId],
  );
}

/**
 * Every governance record for one study, in creation order.
 *
 * Returns candidates, gold and excluded records alike. A read-out that showed
 * only the promoted rows would answer "what is in the dataset" while hiding
 * "what was considered and kept out", and the second question is the one a
 * person auditing a dataset is usually asking.
 */
export async function listGoldRecordsForProject(
  organizationId: string,
  calibrationProjectId: string,
): Promise<GoldRecordRow[]> {
  return query<GoldRecordRow>(
    `select ${GOLD_COLUMNS}
       from pilot.calibration_gold_records
      where organization_id = $1 and calibration_project_id = $2
      order by created_at asc, gold_record_id asc`,
    [organizationId, calibrationProjectId],
  );
}
