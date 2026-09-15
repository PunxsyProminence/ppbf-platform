import { query, queryOne, withTransaction } from '../db';
import { ConflictError } from '../errors';
import { DISAGREEMENT_CATEGORIES, type DisagreementCategory } from './comparison';
import { isInVocabulary } from './ontology';

// A human deciding what two annotators' disagreement actually was.
//
// THE ORIGINALS ARE NEVER TOUCHED. An adjudication is a new row that
// REFERENCES the two source events. There is no code path in this module that
// writes to pilot.calibration_annotation_events or _sets, and there could not
// usefully be one: those rows are frozen by trigger after submission. The two
// readings ARE the measurement, and a reviewer who could edit them would be
// destroying the data in the act of interpreting it.
//
// AN ADJUDICATION IS NOT A THIRD ANNOTATION. It is a record of a decision,
// carrying who made it, when, under which vocabulary, and from which two
// readings. Strip that provenance and it becomes indistinguishable from an
// annotation -- and the difference is the whole point.
//
// UNRESOLVABLE IS A RESULT. Some disagreements cannot be settled from the
// footage. Recording that honestly beats a forced verdict, and a gold dataset
// assembled from forced verdicts would carry a confidence nobody earned.

/** What the reviewer concluded about a disagreement.
 *
 * 'agreement' is a real outcome and not a no-op: it records that a human
 * looked at a flagged difference and found the two readings equivalent, which
 * is a different state from a difference nobody has reviewed. */
export const ADJUDICATION_RESOLUTION_TYPES = [
  'agreement',
  'accept_a',
  'accept_b',
  'new_adjudicated_value',
  'unresolvable',
] as const;
export type AdjudicationResolutionType = (typeof ADJUDICATION_RESOLUTION_TYPES)[number];

/** The separate question an EVENT_MISSED case asks -- not "whose label is
 * right" but "did this happen at all".
 *
 * 'both_distinct' is the member that matters most and is easiest to omit. Two
 * annotators may EACH have recorded a real event, at overlapping times, that
 * were never the same event. Without this value a reviewer's only honest
 * options would misrepresent that, and a true observation would be deleted to
 * make the disagreement tidy. */
export const MISSED_EVENT_VERDICTS = [
  'a_event_real',
  'b_event_real',
  'both_distinct',
  'neither_valid',
  'unresolvable',
] as const;
export type MissedEventVerdict = (typeof MISSED_EVENT_VERDICTS)[number];

/** Where an accepted field value came from.
 *
 * 'adjudicator' must stay distinguishable from accepting one of the two
 * annotators: a gold dataset built mostly of adjudicator-supplied values is a
 * very different artefact from one built mostly of annotator agreement, and
 * only this column can tell the two apart afterward. */
export const RESOLVED_FROM_SOURCES = ['annotator_a', 'annotator_b', 'adjudicator'] as const;
export type ResolvedFromSource = (typeof RESOLVED_FROM_SOURCES)[number];

export interface AdjudicationRow {
  organization_id: string;
  adjudication_id: string;
  calibration_clip_id: string;
  annotation_set_id_a: string;
  annotation_set_id_b: string;
  source_event_id_a: string | null;
  source_event_id_b: string | null;
  resolution_type: string;
  missed_event_verdict: string | null;
  /** Which answer this is for its pair. Highest revision is the current one;
   * earlier revisions are retained as the record of what was thought before.
   * Assigned by the server (OD-2026-08-29-005) and never accepted from a
   * caller. */
  revision: number;
  adjudicator_account_id: string;
  adjudicated_at: string;
  ontology_version: string;
  notes: string | null;
  created_at: string;
}

export interface AdjudicatedFieldRow {
  organization_id: string;
  adjudicated_field_id: string;
  adjudication_id: string;
  field_name: string;
  disagreement_category: string;
  resolved_from: string;
  resolved_value: string | null;
  unresolved: boolean;
  created_at: string;
}

const ADJUDICATION_COLUMNS = `
  organization_id, adjudication_id, calibration_clip_id,
  annotation_set_id_a, annotation_set_id_b,
  source_event_id_a, source_event_id_b,
  resolution_type, missed_event_verdict, revision,
  adjudicator_account_id, adjudicated_at, ontology_version, notes, created_at
`;

/** The unique constraint that arbitrates two concurrent writers, named here
 * because the route matches it by name. OD-2026-08-29-005 chose no row lock, so
 * this constraint is the ONLY thing that stops two administrators landing two
 * rows both claiming to be the same revision of the same pair -- and the route's
 * 409 translation matches SQLSTATE 23505 together with this exact string, so an
 * unrelated duplicate key is never reported as a concurrent correction. */
export const ADJUDICATION_PAIR_REVISION_CONSTRAINT =
  'pilot_calibration_adjudications_pair_revision_uq';

/** One refusal, one wording, two detection points.
 *
 * A stale expected revision and a lost insert race are the SAME event as far as
 * the administrator is concerned -- somebody answered while they were deciding --
 * so they must read identically. They are detected differently: the expected
 * check catches the common case before any write, the unique constraint catches
 * the narrow case where two requests both pass that check before either commits.
 * Defined once here so the two cannot drift into two different explanations of
 * one situation. */
export const ADJUDICATION_SUPERSEDED_CODE = 'CALIBRATION_ADJUDICATION_SUPERSEDED';
export const ADJUDICATION_SUPERSEDED_MESSAGE =
  'Someone corrected this adjudication while you were deciding. Reload and review their answer before replacing it.';

const FIELD_COLUMNS = `
  organization_id, adjudicated_field_id, adjudication_id, field_name,
  disagreement_category, resolved_from, resolved_value, unresolved, created_at
`;

export interface AdjudicatedFieldInput {
  adjudicatedFieldId: string;
  fieldName: string;
  disagreementCategory: DisagreementCategory;
  resolvedFrom: ResolvedFromSource;
  resolvedValue?: string | null;
  unresolved?: boolean;
}

export interface RecordAdjudicationInput {
  organizationId: string;
  adjudicationId: string;
  calibrationClipId: string;
  annotationSetIdA: string;
  annotationSetIdB: string;
  sourceEventIdA?: string | null;
  sourceEventIdB?: string | null;
  resolutionType: AdjudicationResolutionType;
  missedEventVerdict?: MissedEventVerdict | null;
  adjudicatorAccountId: string;
  ontologyVersion: string;
  notes?: string | null;
  fields?: readonly AdjudicatedFieldInput[];
  /** The revision the adjudicator actually reviewed, or 0 if they were looking
   * at an unadjudicated pair. Carried from the GET, never edited, and never the
   * new revision -- the server computes that. Required, with no default: a
   * caller that omitted it would get the stale-overwrite behaviour back, and a
   * default of 0 would refuse every second decision instead. */
  expectedCurrentRevision: number;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value.trim();
}

/**
 * Records one adjudication and its field-level decisions.
 *
 * ONE TRANSACTION, and this is a deliberate correction of a shape already in
 * this codebase. resolveFilmStudyProposal writes its proposal update and its
 * revision row as two separate statements with no transaction, so a failure
 * between them leaves a proposal showing corrected wording with no revision
 * recording who corrected it. The equivalent failure here would be worse: an
 * adjudication claiming 'new_adjudicated_value' with none of the values it
 * claims to carry, sitting in a table a gold dataset is later built from.
 *
 * REFUSES rather than writing a row that cannot be read back honestly:
 *
 *   * 'new_adjudicated_value' with no adjudicator-supplied field. The
 *     resolution type asserts the reviewer supplied a value; a row making that
 *     claim and recording none is a lie the schema alone cannot catch, because
 *     the field decisions live in another table.
 *   * a missed-event verdict on a decision that has both source events. That
 *     vocabulary answers "did this happen at all", which is not the question
 *     when both annotators recorded it.
 *   * any value outside a controlled vocabulary -- rejected, never coerced.
 */
export async function recordAdjudication(
  input: RecordAdjudicationInput,
): Promise<{ adjudication: AdjudicationRow; fields: AdjudicatedFieldRow[] }> {
  if (!isInVocabulary(ADJUDICATION_RESOLUTION_TYPES, input.resolutionType)) {
    throw new Error('Missing resolution_type: not an allowed adjudication result');
  }

  const missedEventVerdict = input.missedEventVerdict ?? null;
  if (missedEventVerdict !== null && !isInVocabulary(MISSED_EVENT_VERDICTS, missedEventVerdict)) {
    throw new Error('Missing missed_event_verdict: not an allowed verdict');
  }

  const sourceEventIdA = input.sourceEventIdA ?? null;
  const sourceEventIdB = input.sourceEventIdB ?? null;
  if (sourceEventIdA === null && sourceEventIdB === null) {
    throw new Error('Missing source_event_id_a: an adjudication must be about at least one event');
  }

  // The missed-event vocabulary answers a question that only arises when one
  // side recorded nothing. Allowing it alongside two events would let a
  // reviewer file "neither_valid" against a pair both annotators saw.
  if (missedEventVerdict !== null && sourceEventIdA !== null && sourceEventIdB !== null) {
    throw new Error(
      'Missing missed_event_verdict: only applies where one annotator recorded no event',
    );
  }

  const fields = input.fields ?? [];
  for (const field of fields) {
    if (!isInVocabulary(DISAGREEMENT_CATEGORIES, field.disagreementCategory)) {
      throw new Error('Missing disagreement_category: not a recognised category');
    }
    if (!isInVocabulary(RESOLVED_FROM_SOURCES, field.resolvedFrom)) {
      throw new Error('Missing resolved_from: not a recognised source');
    }
    if (field.unresolved === true && field.resolvedValue !== null && field.resolvedValue !== undefined) {
      throw new Error('Missing resolved_value: an unresolved field carries no value');
    }
  }

  if (input.resolutionType === 'new_adjudicated_value') {
    const supplied = fields.filter(
      (field) => field.resolvedFrom === 'adjudicator' && field.unresolved !== true,
    );
    if (supplied.length === 0) {
      throw new Error(
        'Missing fields: a new_adjudicated_value resolution must record the value the adjudicator supplied',
      );
    }
  }

  const calibrationClipId = requireNonEmpty(input.calibrationClipId, 'calibration_clip_id');
  const annotationSetIdA = requireNonEmpty(input.annotationSetIdA, 'annotation_set_id_a');
  const annotationSetIdB = requireNonEmpty(input.annotationSetIdB, 'annotation_set_id_b');

  return withTransaction(async (client) => {
    /* THE NEXT REVISION FOR THIS PAIR, AND DELIBERATELY WITHOUT A LOCK
     * (OD-2026-08-29-005).
     *
     * No `for update`, no advisory lock, no serialisable retry. Two
     * administrators may read the same highest revision and both compute the
     * same next one; the unique constraint named above refuses the second, and
     * the route turns that refusal into a 409 telling them to read the answer
     * that landed while they were deciding.
     *
     * That is the better trade for this surface. Adjudicating takes minutes of
     * human thought, so a lock would hold a row across a coffee break, and it
     * would still leave the loser with a silent overwrite rather than a reason.
     *
     * coalesce(max, 0) + 1 rather than count(*) + 1: a count would reuse a
     * revision if any row for the pair were ever removed, and the FKs on this
     * table cascade from clips and annotation sets.
     */
    const actualResult = await client.query<{ actual_revision: number }>(
      `select coalesce(max(revision), 0) as actual_revision
         from pilot.calibration_adjudications
        where organization_id = $1
          and calibration_clip_id = $2
          and annotation_set_id_a = $3
          and annotation_set_id_b = $4`,
      [input.organizationId, calibrationClipId, annotationSetIdA, annotationSetIdB],
    );

    const actualRevision = actualResult.rows[0]?.actual_revision;
    if (typeof actualRevision !== 'number' || !Number.isInteger(actualRevision) || actualRevision < 0) {
      throw new Error('CALIBRATION_ADJUDICATION_REVISION_UNRESOLVED');
    }

    /* THE STALE DECISION, REFUSED BEFORE ANYTHING IS WRITTEN.
     *
     * The unique constraint alone does not cover this, and that gap was the
     * defect. It catches two INSERTS that overlap; it says nothing about an
     * administrator who opened the desk at revision 1, thought for ten minutes
     * while somebody else recorded revision 2, and then submitted. max+1 would
     * quietly assign revision 3 and make a decision current that was reached
     * without ever seeing revision 2 -- which is precisely the harm the refusal
     * message describes.
     *
     * Compared, never coerced. An expected revision that is merely BEHIND is not
     * a lesser problem than one that is ahead: both mean the reviewer was looking
     * at something other than what stands now.
     *
     * Still no lock (OD-2026-08-29-005). This check narrows the window to the
     * gap between this SELECT and the INSERT below; the unique constraint closes
     * that remainder, and both surface the same refusal. */
    if (actualRevision !== input.expectedCurrentRevision) {
      throw new ConflictError(ADJUDICATION_SUPERSEDED_MESSAGE, ADJUDICATION_SUPERSEDED_CODE);
    }

    const nextRevision = actualRevision + 1;

    const adjudicationResult = await client.query<AdjudicationRow>(
      `insert into pilot.calibration_adjudications
         (organization_id, adjudication_id, calibration_clip_id,
          annotation_set_id_a, annotation_set_id_b,
          source_event_id_a, source_event_id_b,
          resolution_type, missed_event_verdict, revision,
          adjudicator_account_id, ontology_version, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning ${ADJUDICATION_COLUMNS}`,
      [
        input.organizationId,
        requireNonEmpty(input.adjudicationId, 'adjudication_id'),
        calibrationClipId,
        annotationSetIdA,
        annotationSetIdB,
        sourceEventIdA,
        sourceEventIdB,
        input.resolutionType,
        missedEventVerdict,
        nextRevision,
        requireNonEmpty(input.adjudicatorAccountId, 'adjudicator_account_id'),
        requireNonEmpty(input.ontologyVersion, 'ontology_version'),
        input.notes ?? null,
      ],
    );

    const adjudication = adjudicationResult.rows[0];
    if (!adjudication) {
      throw new Error('CALIBRATION_ADJUDICATION_WRITE_FAILED');
    }

    const written: AdjudicatedFieldRow[] = [];
    for (const field of fields) {
      const fieldResult = await client.query<AdjudicatedFieldRow>(
        `insert into pilot.calibration_adjudicated_fields
           (organization_id, adjudicated_field_id, adjudication_id, field_name,
            disagreement_category, resolved_from, resolved_value, unresolved)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${FIELD_COLUMNS}`,
        [
          input.organizationId,
          requireNonEmpty(field.adjudicatedFieldId, 'adjudicated_field_id'),
          adjudication.adjudication_id,
          requireNonEmpty(field.fieldName, 'field_name'),
          field.disagreementCategory,
          field.resolvedFrom,
          field.unresolved === true ? null : (field.resolvedValue ?? null),
          field.unresolved === true,
        ],
      );
      const row = fieldResult.rows[0];
      if (!row) {
        throw new Error('CALIBRATION_ADJUDICATED_FIELD_WRITE_FAILED');
      }
      written.push(row);
    }

    return { adjudication, fields: written };
  });
}

export async function getAdjudication(
  organizationId: string,
  adjudicationId: string,
): Promise<AdjudicationRow | null> {
  return queryOne<AdjudicationRow>(
    `select ${ADJUDICATION_COLUMNS}
       from pilot.calibration_adjudications
      where organization_id = $1 and adjudication_id = $2`,
    [organizationId, adjudicationId],
  );
}

export async function listAdjudicatedFields(
  organizationId: string,
  adjudicationId: string,
): Promise<AdjudicatedFieldRow[]> {
  return query<AdjudicatedFieldRow>(
    `select ${FIELD_COLUMNS}
       from pilot.calibration_adjudicated_fields
      where organization_id = $1 and adjudication_id = $2
      order by field_name asc`,
    [organizationId, adjudicationId],
  );
}

export async function listAdjudicationsForClip(
  organizationId: string,
  calibrationClipId: string,
): Promise<AdjudicationRow[]> {
  return query<AdjudicationRow>(
    `select ${ADJUDICATION_COLUMNS}
       from pilot.calibration_adjudications
      where organization_id = $1 and calibration_clip_id = $2
      order by adjudicated_at asc, adjudication_id asc`,
    [organizationId, calibrationClipId],
  );
}
