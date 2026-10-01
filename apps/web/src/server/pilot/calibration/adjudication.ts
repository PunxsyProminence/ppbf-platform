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
  /** Which answer this is for its disagreement -- the pair of marks it names
   * (OD-2026-08-29-005). The highest revision is the current one; earlier
   * revisions are retained as the record of what was thought before. Assigned
   * by the server, never by a caller. */
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

/** The unique index that arbitrates two concurrent writers, named here because
 * the route matches it by name (the pg driver reports a unique index's name in
 * the error's `constraint` field). OD-2026-08-29-005 chose no row lock, so this
 * index is the ONLY thing that stops two administrators landing two rows that
 * both claim to be the same revision of the same disagreement. The route's 409
 * matches SQLSTATE 23505 together with this exact string, so an unrelated
 * duplicate key is never reported as a concurrent correction.
 * Declared in pilot_slice_postgres_calibration_adjudication_revisions_migration.sql. */
export const ADJUDICATION_PAIR_REVISION_CONSTRAINT =
  'pilot_calibration_adjudications_decision_revision_uq';

/** What an administrator is told when their decision was made against an
 * answer that is no longer the current one. One wording, two detection points:
 * the reviewed-revision check in `recordAdjudication` catches the ordinary
 * case before anything is written, and the unique index catches the narrow
 * one where two requests pass that check before either commits. They are the
 * same event to the person it happens to, so they read the same. The wording
 * is part of the owner's decision, not a nicety: it says what happened and
 * what to do about it, in place of a duplicate-key dump naming a constraint. */
export const ADJUDICATION_SUPERSEDED_CODE = 'CALIBRATION_ADJUDICATION_SUPERSEDED';
export const ADJUDICATION_SUPERSEDED_MESSAGE =
  'Someone corrected this adjudication while you were deciding. Reload and review their answer before replacing it.';

/**
 * "This row is the current answer to its disagreement", as SQL, for a reader
 * that must not count or act on superseded history.
 *
 * `alias` is the reader's alias for pilot.calibration_adjudications. The
 * grouping is the one the index, the trigger, the backfill and
 * `recordAdjudication` use: the two readings and the two marks, NULL-safe.
 * Written once here so a reader cannot drift onto a different idea of what
 * one disagreement is. The alias is interpolated, so it is checked rather
 * than trusted.
 */
export function currentAdjudicationPredicate(alias: string): string {
  // `later_revision` is the name the subquery uses for the row it compares
  // against. A reader that used it too would compare a row with itself and
  // every row would read as current.
  if (!/^[a-z_][a-z0-9_]*$/.test(alias) || alias === 'later_revision') {
    throw new Error('CALIBRATION_ADJUDICATION_ALIAS_INVALID');
  }
  return `not exists (
    select 1
      from pilot.calibration_adjudications later_revision
     where later_revision.organization_id = ${alias}.organization_id
       and later_revision.calibration_clip_id = ${alias}.calibration_clip_id
       and later_revision.annotation_set_id_a = ${alias}.annotation_set_id_a
       and later_revision.annotation_set_id_b = ${alias}.annotation_set_id_b
       and later_revision.source_event_id_a is not distinct from ${alias}.source_event_id_a
       and later_revision.source_event_id_b is not distinct from ${alias}.source_event_id_b
       and later_revision.revision > ${alias}.revision
  )`;
}

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
  /** The revision of this disagreement the adjudicator actually had in front
   * of them, or 0 if they were looking at one nobody had settled. It is a
   * claim about WHAT WAS REVIEWED and is only ever compared: the server
   * computes the revision it writes. Required, with no default -- a caller
   * that omitted it would get the stale overwrite back, and a default of 0
   * would refuse every correction. */
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

  if (
    typeof input.expectedCurrentRevision !== 'number'
    || !Number.isInteger(input.expectedCurrentRevision)
    || input.expectedCurrentRevision < 0
  ) {
    throw new Error(
      'Missing expected_current_revision: the revision this decision was reviewed against must be a whole number, 0 or more',
    );
  }

  const calibrationClipId = requireNonEmpty(input.calibrationClipId, 'calibration_clip_id');
  const annotationSetIdA = requireNonEmpty(input.annotationSetIdA, 'annotation_set_id_a');
  const annotationSetIdB = requireNonEmpty(input.annotationSetIdB, 'annotation_set_id_b');

  return withTransaction(async (client) => {
    /* THE NEXT REVISION FOR THIS DISAGREEMENT, DELIBERATELY WITHOUT A LOCK
     * (OD-2026-08-29-005).
     *
     * A disagreement is the pair of MARKS this decision names, inside the pair
     * of readings: a clip carries one row per disagreement, so counting over
     * the two readings alone would number unrelated decisions as corrections
     * of each other. `is not distinct from` because either mark may be null
     * (one annotator recorded nothing), and two decisions about the same lone
     * mark are the same disagreement.
     *
     * No `for update`, no advisory lock, no serialisable retry. Two
     * administrators may read the same highest revision and both compute the
     * same next one; the unique index named above refuses the second
     * insert with 23505, and the route turns that into a 409 telling them to
     * read the answer that landed while they were deciding.
     *
     * coalesce(max, 0) + 1 rather than count(*) + 1: a count would hand out a
     * revision that is still in use if an EARLIER row were ever removed, and
     * the insert would then collide with nobody racing it. Neither form
     * avoids reusing the number of a removed HIGHEST row.
     *
     * The index alone only refuses two inserts that OVERLAP. The far more
     * likely case is handled just below, before anything is written. */
    const currentResult = await client.query<{ current_revision: number }>(
      `select coalesce(max(revision), 0)::int as current_revision
         from pilot.calibration_adjudications
        where organization_id = $1
          and calibration_clip_id = $2
          and annotation_set_id_a = $3
          and annotation_set_id_b = $4
          and source_event_id_a is not distinct from $5
          and source_event_id_b is not distinct from $6`,
      [
        input.organizationId,
        calibrationClipId,
        annotationSetIdA,
        annotationSetIdB,
        sourceEventIdA,
        sourceEventIdB,
      ],
    );
    const currentRevision = currentResult.rows[0]?.current_revision;
    if (typeof currentRevision !== 'number' || !Number.isInteger(currentRevision) || currentRevision < 0) {
      throw new Error('CALIBRATION_ADJUDICATION_REVISION_UNRESOLVED');
    }

    /* THE STALE DECISION, REFUSED BEFORE ANYTHING IS WRITTEN.
     *
     * An administrator opens the desk at revision 1, thinks for ten minutes
     * while somebody else records revision 2, and submits. Numbering that as
     * revision 3 would make current a decision reached without ever seeing
     * revision 2 -- the harm the refusal sentence describes, and the reason
     * the owner chose a collision that sends the second person to read the
     * first correction.
     *
     * Compared, never coerced: an expectation that is BEHIND and one that is
     * AHEAD both mean the reviewer was looking at something other than what
     * stands now.
     *
     * Still no lock. This narrows the window to the gap between the read
     * above and the insert below; the unique index closes that remainder, and
     * both give the same refusal. */
    if (currentRevision !== input.expectedCurrentRevision) {
      throw new ConflictError(ADJUDICATION_SUPERSEDED_MESSAGE, ADJUDICATION_SUPERSEDED_CODE);
    }

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
        currentRevision + 1,
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
