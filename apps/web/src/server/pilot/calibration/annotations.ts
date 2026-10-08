import type { PoolClient } from 'pg';

import { query, queryOne, withTransaction } from '../db';
import { PilotError } from '../errors';
import {
  ANNOTATION_CERTAINTIES,
  BODY_POINT_ONTOLOGY_VERSIONS,
  CONTACT_RESULTS,
  CONTACT_RESULTS_WITH_CONTACT,
  CONTACT_ZONES,
  DEFENSE_TYPES,
  EVENT_CLASSES,
  HAND_ROLES,
  PHYSICAL_HANDS,
  PUNCH_TYPES,
  STANCES,
  TARGET_ZONES,
  VISIBILITIES,
  isInVocabulary,
  type AnnotationCertainty,
  type ContactResult,
  type ContactZone,
  type DefenseType,
  type EventClass,
  type HandRole,
  type PhysicalHand,
  type PunchType,
  type Stance,
  type TargetZone,
  type Visibility,
} from './ontology';

// One annotator's independent pass over one clip, and the events in it.
//
// THE ORIGINAL IS NEVER OVERWRITTEN. Editing and deleting are possible only
// while a set is in_progress. After submission the database refuses every
// write through a trigger, so this module's checks below are for producing a
// clear 400 rather than for safety -- the safety is one layer down, where a
// backfill or a well-meant cleanup script also has to obey it.
//
// EVERY VOCABULARY IS REJECTED, NEVER COERCED. An unrecognised label is a 400
// naming the field. It is never rewritten to 'unknown', because 'unknown' is
// a recorded observation -- "the annotator looked and could not tell" -- and
// manufacturing one out of a bug produces a fabricated row indistinguishable
// from a real one forever after.
//
// UNKNOWN IS NOT NO. A null column means "not recorded". An 'unknown' value
// means "recorded as unobservable". Nothing here may treat them as the same,
// and nothing downstream may treat either as a negative.

export interface AnnotationSetRow {
  organization_id: string;
  annotation_set_id: string;
  calibration_clip_id: string;
  annotator_account_id: string;
  ontology_version: string;
  status: string;
  /** 1 for a first reading; 2 and up for the same annotator labelling the
   *  clip again. Every inter-annotator reader takes first passes only. */
  pass_number: number;
  // TYPED AS THE REST OF pilot/* TYPES ITS TIMESTAMPS, AND THE SAME WAY WRONG.
  // db.ts overrides the type parser for OID 1082 (DATE) only, so a timestamptz
  // arrives as a JS Date, not a string -- here and in every other row
  // interface in this directory. It goes unnoticed because JSON.stringify
  // turns a Date into exactly the ISO string the annotation says it is, so the
  // lie is invisible at an HTTP boundary and visible to anything that compares
  // two of them. Matched rather than corrected: a lone honest module here
  // would be the odd one out, and repairing the convention is its own change.
  created_at: string;
  submitted_at: string | null;
}

export interface AnnotationEventRow {
  organization_id: string;
  event_id: string;
  annotation_set_id: string;
  calibration_clip_id: string;
  clip_start_ms: number;
  clip_end_ms: number;
  event_class: string;
  actor_track: string;
  opponent_track: string | null;
  start_ms: number;
  end_ms: number;
  contact_ms: number | null;
  peak_ms: number | null;
  physical_hand: string | null;
  hand_role: string | null;
  stance: string | null;
  punch_type: string | null;
  target_zone: string | null;
  contact_result: string | null;
  contact_zone: string | null;
  defense_type: string | null;
  visibility: string;
  certainty: string;
  combination_group: string | null;
  sequence_order: number | null;
  counter_against_event_id: string | null;
  defends_against_event_id: string | null;
  created_at: string;
}

const SET_COLUMNS = `
  organization_id, annotation_set_id, calibration_clip_id, annotator_account_id,
  ontology_version, status, pass_number, created_at, submitted_at
`;

const EVENT_COLUMNS = `
  organization_id, event_id, annotation_set_id, calibration_clip_id,
  clip_start_ms, clip_end_ms, event_class, actor_track, opponent_track,
  start_ms, end_ms, contact_ms, peak_ms,
  physical_hand, hand_role, stance,
  punch_type, target_zone, contact_result, contact_zone,
  defense_type, visibility, certainty,
  combination_group, sequence_order,
  counter_against_event_id, defends_against_event_id, created_at
`;

/** Raised when a write is attempted against a set that has been submitted.
 *
 * The database raises this too, from a trigger. This class exists so the
 * ordinary path produces a clean refusal rather than surfacing a constraint
 * name, NOT so the trigger becomes redundant -- the trigger is what holds
 * when the write does not come through this module. */
export class AnnotationSetSubmittedError extends Error {
  constructor() {
    super('Forbidden: this annotation set has been submitted and can no longer be changed');
    this.name = 'AnnotationSetSubmittedError';
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value.trim();
}

function requireOffsetMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Missing ${field}: expected a whole number of milliseconds, zero or greater`);
  }
  return value;
}

function optionalOffsetMs(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requireOffsetMs(value, field);
}

/** Validates one controlled-vocabulary field, naming it in the refusal. */
function requireVocabulary<T extends string>(
  vocabulary: readonly T[],
  value: unknown,
  field: string,
): T {
  if (!isInVocabulary(vocabulary, value)) {
    throw new Error(`Missing ${field}: not a value in boxing-ontology-0.1`);
  }
  return value;
}

function optionalVocabulary<T extends string>(
  vocabulary: readonly T[],
  value: unknown,
  field: string,
): T | null {
  if (value === null || value === undefined) return null;
  return requireVocabulary(vocabulary, value, field);
}

interface SetContextRow {
  annotation_set_id: string;
  calibration_clip_id: string;
  status: string;
  ontology_version: string;
  annotator_account_id: string;
  clip_start_ms: number;
  clip_end_ms: number;
}

/**
 * The set, plus the bounds of the clip it is about.
 *
 * One query rather than two, because an event write needs both and reading
 * them separately opens a window where the clip could change between them.
 */
async function loadSetContext(
  organizationId: string,
  annotationSetId: string,
): Promise<SetContextRow | null> {
  return queryOne<SetContextRow>(
    `select s.annotation_set_id, s.calibration_clip_id, s.status, s.ontology_version,
            s.annotator_account_id,
            c.start_ms as clip_start_ms, c.end_ms as clip_end_ms
       from pilot.calibration_annotation_sets s
       join pilot.calibration_clips c
         on c.organization_id = s.organization_id
        and c.calibration_clip_id = s.calibration_clip_id
      where s.organization_id = $1 and s.annotation_set_id = $2`,
    [organizationId, annotationSetId],
  );
}

export interface OpenAnnotationSetInput {
  organizationId: string;
  annotationSetId: string;
  calibrationClipId: string;
  annotatorAccountId: string;
  ontologyVersion: string;
}

/**
 * Opens one annotator's pass over one clip.
 *
 * Always starts in_progress with a null submitted_at. There is no input that
 * can create a set already submitted: a set that arrives finished has no
 * account of when it was finished, and the ordering of two submissions is
 * exactly what a blinding audit needs to read.
 *
 * Always a FIRST pass, by the column default. A second first pass for the
 * same annotator and clip is refused by
 * pilot_calibration_sets_one_per_annotator_pass_uq. That is the unit of
 * measurement, so it is a database constraint rather than a convention.
 */
export async function openAnnotationSet(
  input: OpenAnnotationSetInput,
): Promise<AnnotationSetRow> {
  const row = await queryOne<AnnotationSetRow>(
    `insert into pilot.calibration_annotation_sets
       (organization_id, annotation_set_id, calibration_clip_id, annotator_account_id,
        ontology_version, status, submitted_at)
     values ($1, $2, $3, $4, $5, 'in_progress', null)
     returning ${SET_COLUMNS}`,
    [
      input.organizationId,
      requireNonEmpty(input.annotationSetId, 'annotation_set_id'),
      requireNonEmpty(input.calibrationClipId, 'calibration_clip_id'),
      requireNonEmpty(input.annotatorAccountId, 'annotator_account_id'),
      requireNonEmpty(input.ontologyVersion, 'ontology_version'),
    ],
  );
  if (!row) {
    throw new Error('CALIBRATION_ANNOTATION_SET_WRITE_FAILED');
  }
  return row;
}

/**
 * Opens the same annotator's NEXT pass over a clip they have already
 * labelled and submitted, or answers null.
 *
 * ONE STATEMENT DECIDES AND WRITES. The pass number is the latest pass plus
 * one, and the row is inserted only if that latest pass is submitted, so
 * there is no gap between "is the last one finished" and the insert for a
 * second tab to fall into. Null covers every case in which nothing was
 * opened: no earlier pass, an earlier pass still in progress, an earlier pass
 * labelled under another vocabulary than the one asked for (a repeat reading
 * under a different vocabulary is a different measurement), or another
 * request opening the same pass first (`on conflict do nothing` rather than a
 * key violation). The caller re-reads to tell which.
 *
 * `afterPassNumber` IS THE PASS THE CALLER DECIDED ON. The row is inserted
 * only if that is still the latest pass, so a request that read pass 1 as
 * finished cannot come back holding pass 3 because another window opened and
 * submitted pass 2 while it waited.
 *
 * The database holds the same rule in pilot_calibration_sets_pass_guard, for
 * writes that do not come through here.
 *
 * WHAT IT DOES NOT DO: it copies nothing from the earlier pass. A repeat
 * reading starts empty and is made without the first -- annotatorGate.ts and
 * blinding.ts stop the earlier pass being read back from the moment this
 * returns a row.
 */
export interface OpenNextAnnotationPassInput extends OpenAnnotationSetInput {
  afterPassNumber: number;
}

export async function openNextAnnotationPass(
  input: OpenNextAnnotationPassInput,
): Promise<AnnotationSetRow | null> {
  if (!Number.isInteger(input.afterPassNumber) || input.afterPassNumber < 1) {
    throw new Error('Missing after_pass_number: expected the pass being repeated, 1 or greater');
  }
  return queryOne<AnnotationSetRow>(
    `insert into pilot.calibration_annotation_sets
       (organization_id, annotation_set_id, calibration_clip_id, annotator_account_id,
        ontology_version, status, submitted_at, pass_number)
     select $1, $2, $3, $4, $5, 'in_progress', null, latest.pass_number + 1
       from (
         select pass_number, status, ontology_version
           from pilot.calibration_annotation_sets
          where organization_id = $1
            and calibration_clip_id = $3
            and annotator_account_id = $4
          order by pass_number desc
          limit 1
       ) latest
      where latest.status = 'submitted'
        and latest.ontology_version = $5
        and latest.pass_number = $6
     on conflict (organization_id, calibration_clip_id, annotator_account_id, pass_number)
       do nothing
     returning ${SET_COLUMNS}`,
    [
      input.organizationId,
      requireNonEmpty(input.annotationSetId, 'annotation_set_id'),
      requireNonEmpty(input.calibrationClipId, 'calibration_clip_id'),
      requireNonEmpty(input.annotatorAccountId, 'annotator_account_id'),
      requireNonEmpty(input.ontologyVersion, 'ontology_version'),
      input.afterPassNumber,
    ],
  );
}

/** A set read by id, and whether its annotator has since opened a later pass
 *  on the same clip. */
export interface AnnotationSetLookupRow extends AnnotationSetRow {
  superseded_by_later_pass: boolean;
}

/**
 * One set by id.
 *
 * `superseded_by_later_pass` comes back in the same statement as the row, so
 * the annotator gate decides on one read: an earlier pass must stop being
 * served the moment a later one exists, and a second query would leave a gap
 * between the two.
 */
export async function getAnnotationSet(
  organizationId: string,
  annotationSetId: string,
): Promise<AnnotationSetLookupRow | null> {
  return queryOne<AnnotationSetLookupRow>(
    `select ${SET_COLUMNS},
            exists (
              select 1
                from pilot.calibration_annotation_sets later
               where later.organization_id = s.organization_id
                 and later.calibration_clip_id = s.calibration_clip_id
                 and later.annotator_account_id = s.annotator_account_id
                 and later.pass_number > s.pass_number
            ) as superseded_by_later_pass
       from pilot.calibration_annotation_sets s
      where s.organization_id = $1 and s.annotation_set_id = $2`,
    [organizationId, annotationSetId],
  );
}

/**
 * Every set for one clip, every annotator's and every pass included.
 *
 * ORGANIZATION-SCOPED ONLY. This function applies NO blinding, and callers
 * must not treat it as if it did: it is the adjudicator's and the QA
 * read-out's view. The annotator-facing gate that refuses one annotator sight
 * of another's unsubmitted work is a separate, explicit surface and is not
 * implemented in this slice. Wiring this function to an annotator screen
 * without that gate would defeat the entire study.
 */
export async function listAnnotationSetsForClip(
  organizationId: string,
  calibrationClipId: string,
): Promise<AnnotationSetRow[]> {
  return query<AnnotationSetRow>(
    `select ${SET_COLUMNS}
       from pilot.calibration_annotation_sets
      where organization_id = $1 and calibration_clip_id = $2
      order by created_at asc, annotation_set_id asc`,
    [organizationId, calibrationClipId],
  );
}

/**
 * Marks a pass finished. One direction only.
 *
 * Scoped to in_progress in the WHERE, so submitting twice returns null rather
 * than re-stamping submitted_at -- a second stamp would move the set's
 * position in the submission order, which is the record a blinding audit
 * reads.
 */
export async function submitAnnotationSet(
  organizationId: string,
  annotationSetId: string,
): Promise<AnnotationSetRow | null> {
  return queryOne<AnnotationSetRow>(
    `update pilot.calibration_annotation_sets
        set status = 'submitted', submitted_at = now()
      where organization_id = $1
        and annotation_set_id = $2
        and status = 'in_progress'
      returning ${SET_COLUMNS}`,
    [organizationId, annotationSetId],
  );
}

export interface RecordAnnotationEventInput {
  organizationId: string;
  eventId: string;
  annotationSetId: string;
  eventClass: EventClass;
  actorTrack: string;
  opponentTrack?: string | null;
  startMs: number;
  endMs: number;
  contactMs?: number | null;
  peakMs?: number | null;
  physicalHand?: PhysicalHand | null;
  handRole?: HandRole | null;
  stance?: Stance | null;
  punchType?: PunchType | null;
  targetZone?: TargetZone | null;
  contactResult?: ContactResult | null;
  contactZone?: ContactZone | null;
  defenseType?: DefenseType | null;
  visibility: Visibility;
  certainty: AnnotationCertainty;
  combinationGroup?: string | null;
  sequenceOrder?: number | null;
  counterAgainstEventId?: string | null;
  defendsAgainstEventId?: string | null;
}

interface ResolvedEventShape {
  physicalHand: PhysicalHand | null;
  handRole: HandRole | null;
  punchType: PunchType | null;
  targetZone: TargetZone | null;
  contactResult: ContactResult | null;
  contactZone: ContactZone | null;
  defenseType: DefenseType | null;
  combinationGroup: string | null;
  sequenceOrder: number | null;
  counterAgainstEventId: string | null;
  defendsAgainstEventId: string | null;
}

/**
 * Resolves the class-conditional half of an event, refusing a row that mixes
 * the two classes.
 *
 * Mirrors pilot_calibration_events_class_shape deliberately. The database is
 * the authority; this exists so a caller gets "Missing punch_type" instead of
 * a 500 naming a constraint. If the two ever disagree the database wins, and
 * calibrationAnnotations.pg.test.ts asserts both refuse the same rows.
 *
 * A DEFENSE carries no punch fields -- not because a block has no target, but
 * because v0.1 ratifies no vocabulary for one, and inventing a reading for
 * `target_zone` on a defense is exactly the kind of quiet definition this
 * build is not authorized to make. physical_hand, hand_role and stance ARE
 * permitted on both: they describe the actor's body, which is observable
 * whichever thing the actor was doing with it.
 */
function resolveEventShape(input: RecordAnnotationEventInput): ResolvedEventShape {
  const physicalHand = optionalVocabulary(PHYSICAL_HANDS, input.physicalHand, 'physical_hand');
  const handRole = optionalVocabulary(HAND_ROLES, input.handRole, 'hand_role');

  if (input.eventClass === 'punch') {
    if (input.defenseType !== null && input.defenseType !== undefined) {
      throw new Error('Missing defense_type: a punch cannot carry a defense type');
    }
    if (input.defendsAgainstEventId) {
      throw new Error('Missing defends_against_event_id: a punch defends against nothing');
    }
    const sequenceOrder = input.sequenceOrder ?? null;
    if (sequenceOrder !== null && (!Number.isInteger(sequenceOrder) || sequenceOrder < 1)) {
      throw new Error('Missing sequence_order: expected a position of 1 or greater');
    }

    return {
      physicalHand: requireVocabulary(PHYSICAL_HANDS, input.physicalHand, 'physical_hand'),
      handRole: requireVocabulary(HAND_ROLES, input.handRole, 'hand_role'),
      punchType: requireVocabulary(PUNCH_TYPES, input.punchType, 'punch_type'),
      targetZone: requireVocabulary(TARGET_ZONES, input.targetZone, 'target_zone'),
      contactResult: requireVocabulary(CONTACT_RESULTS, input.contactResult, 'contact_result'),
      contactZone: optionalVocabulary(CONTACT_ZONES, input.contactZone, 'contact_zone'),
      defenseType: null,
      combinationGroup: input.combinationGroup ? requireNonEmpty(input.combinationGroup, 'combination_group') : null,
      sequenceOrder,
      counterAgainstEventId: input.counterAgainstEventId ?? null,
      defendsAgainstEventId: null,
    };
  }

  for (const [field, value] of [
    ['punch_type', input.punchType],
    ['target_zone', input.targetZone],
    ['contact_result', input.contactResult],
    ['contact_zone', input.contactZone],
    ['combination_group', input.combinationGroup],
    ['sequence_order', input.sequenceOrder],
    ['counter_against_event_id', input.counterAgainstEventId],
  ] as const) {
    if (value !== null && value !== undefined) {
      throw new Error(`Missing ${field}: a defense cannot carry it in boxing-ontology-0.1`);
    }
  }

  return {
    physicalHand,
    handRole,
    punchType: null,
    targetZone: null,
    contactResult: null,
    contactZone: null,
    defenseType: requireVocabulary(DEFENSE_TYPES, input.defenseType, 'defense_type'),
    combinationGroup: null,
    sequenceOrder: null,
    counterAgainstEventId: null,
    defendsAgainstEventId: input.defendsAgainstEventId ?? null,
  };
}

interface ResolvedEventFields {
  eventClass: EventClass;
  visibility: Visibility;
  certainty: AnnotationCertainty;
  stance: Stance | null;
  startMs: number;
  endMs: number;
  contactMs: number | null;
  peakMs: number | null;
  shape: ResolvedEventShape;
}

/** The checks an event's own fields must pass whatever set it is in: the
 * vocabularies, the span, and the class-conditional shape. One function so
 * recording and editing in place cannot come to accept different rows. */
function resolveEventFields(input: RecordAnnotationEventInput): ResolvedEventFields {
  const eventClass = requireVocabulary(EVENT_CLASSES, input.eventClass, 'event_class');
  const visibility = requireVocabulary(VISIBILITIES, input.visibility, 'visibility');
  const certainty = requireVocabulary(ANNOTATION_CERTAINTIES, input.certainty, 'certainty');
  const stance = optionalVocabulary(STANCES, input.stance, 'stance');

  const startMs = requireOffsetMs(input.startMs, 'start_ms');
  const endMs = requireOffsetMs(input.endMs, 'end_ms');
  if (startMs >= endMs) {
    throw new Error('Missing end_ms: an event must end after it starts');
  }

  // Independent of each other on purpose: a punch may have an observable
  // contact and no observable peak, or the reverse.
  const contactMs = optionalOffsetMs(input.contactMs, 'contact_ms');
  if (contactMs !== null && (contactMs < startMs || contactMs > endMs)) {
    throw new Error('Missing contact_ms: must fall within the event');
  }
  const peakMs = optionalOffsetMs(input.peakMs, 'peak_ms');
  if (peakMs !== null && (peakMs < startMs || peakMs > endMs)) {
    throw new Error('Missing peak_ms: must fall within the event');
  }

  const shape = resolveEventShape({ ...input, eventClass });
  return { eventClass, visibility, certainty, stance, startMs, endMs, contactMs, peakMs, shape };
}

/**
 * Records one observed event.
 *
 * The clip's bounds are read from the clip and written onto the row, where a
 * composite foreign key ties them back to it -- so the containment CHECK
 * cannot be satisfied by a lie about where the clip starts.
 */
export async function recordAnnotationEvent(
  input: RecordAnnotationEventInput,
): Promise<AnnotationEventRow> {
  const fields = resolveEventFields(input);
  const { eventClass, visibility, certainty, stance, startMs, endMs, contactMs, peakMs, shape } = fields;

  const context = await loadSetContext(
    input.organizationId,
    requireNonEmpty(input.annotationSetId, 'annotation_set_id'),
  );
  if (!context) {
    throw new Error('Not found: no such annotation set in this organization');
  }
  if (context.status !== 'in_progress') {
    throw new AnnotationSetSubmittedError();
  }
  if (startMs < context.clip_start_ms || endMs > context.clip_end_ms) {
    throw new Error('Missing start_ms: the event falls outside the clip it belongs to');
  }
  // The same named refusals an edit in place gives. Without this the 0.2+
  // rules were the trigger's alone, and its refusal reached the caller as a
  // 500 with no field in it.
  assertVersionEventRules(context.ontology_version, fields);

  const row = await queryOne<AnnotationEventRow>(
    `insert into pilot.calibration_annotation_events
       (organization_id, event_id, annotation_set_id, calibration_clip_id,
        clip_start_ms, clip_end_ms, event_class, actor_track, opponent_track,
        start_ms, end_ms, contact_ms, peak_ms,
        physical_hand, hand_role, stance,
        punch_type, target_zone, contact_result, contact_zone,
        defense_type, visibility, certainty,
        combination_group, sequence_order,
        counter_against_event_id, defends_against_event_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
     returning ${EVENT_COLUMNS}`,
    [
      input.organizationId,
      requireNonEmpty(input.eventId, 'event_id'),
      context.annotation_set_id,
      context.calibration_clip_id,
      context.clip_start_ms,
      context.clip_end_ms,
      eventClass,
      requireNonEmpty(input.actorTrack, 'actor_track'),
      input.opponentTrack ?? null,
      startMs,
      endMs,
      contactMs,
      peakMs,
      shape.physicalHand,
      shape.handRole,
      stance,
      shape.punchType,
      shape.targetZone,
      shape.contactResult,
      shape.contactZone,
      shape.defenseType,
      visibility,
      certainty,
      shape.combinationGroup,
      shape.sequenceOrder,
      shape.counterAgainstEventId,
      shape.defendsAgainstEventId,
    ],
  );

  if (!row) {
    throw new Error('CALIBRATION_ANNOTATION_EVENT_WRITE_FAILED');
  }
  return row;
}

/* ------------------------------------------------------------------ *
 * EDITING AN EVENT IN PLACE
 *
 * An event of a body-point set can hold marks: up to three moments, each with
 * its points, and a stance type. They hang off the event's id, so replacing
 * the event (a new row, the old one deleted) removes them by cascade. An edit
 * in place keeps the id and so keeps the marks.
 *
 * THE DATABASE DECIDES WHETHER AN EVENT HOLDS MARKS, not this module, which
 * never reads the body-point tables (bodyPoints.ts is the one place that
 * does). The body-points migrations freeze the facts a moment was checked
 * against: start, end, contact time, class and actor while the event holds a
 * moment, and the actor while it holds a stance type. This module sends the
 * update and turns that refusal into words that name the field.
 * ------------------------------------------------------------------ */

/** Raised when a change would move an event under its marks. */
export class EventHoldsBodyMarksError extends PilotError {
  constructor(message: string) {
    super(409, message, 'CALIBRATION_EVENT_HAS_BODY_MARKS');
  }
}

/** Module field -> column, for every field an edit may carry. */
const EVENT_FIELD_COLUMNS = {
  eventClass: 'event_class', actorTrack: 'actor_track', opponentTrack: 'opponent_track',
  startMs: 'start_ms', endMs: 'end_ms', contactMs: 'contact_ms', peakMs: 'peak_ms',
  physicalHand: 'physical_hand', handRole: 'hand_role', stance: 'stance',
  punchType: 'punch_type', targetZone: 'target_zone', contactResult: 'contact_result',
  contactZone: 'contact_zone', defenseType: 'defense_type', visibility: 'visibility',
  certainty: 'certainty', combinationGroup: 'combination_group', sequenceOrder: 'sequence_order',
  counterAgainstEventId: 'counter_against_event_id', defendsAgainstEventId: 'defends_against_event_id',
} as const satisfies Record<keyof Omit<RecordAnnotationEventInput, 'organizationId' | 'eventId' | 'annotationSetId'>, string>;

/** The 0.2+ rules on the event row, as refusals that name the field. The
 * calibration-body-point-rules migration holds the same three. */
function assertVersionEventRules(ontologyVersion: string, fields: ResolvedEventFields): void {
  if (!isInVocabulary(BODY_POINT_ONTOLOGY_VERSIONS, ontologyVersion)) return;
  if (fields.stance !== null) {
    throw new Error(`Missing stance: ${ontologyVersion} records the lead side at each marked moment, not a stance on the event`);
  }
  if (fields.peakMs !== null) {
    throw new Error(`Missing peak_ms: ${ontologyVersion} has no peak time`);
  }
  if (
    fields.eventClass === 'punch'
    && isInVocabulary(CONTACT_RESULTS_WITH_CONTACT, fields.shape.contactResult) !== (fields.contactMs !== null)
  ) {
    throw new Error(`Missing contact_ms: in ${ontologyVersion} a punch carries a contact time exactly when its result made contact`);
  }
}

/**
 * The database's refusals of an event update, in the shapes jsonError maps.
 * `moved` is the frozen facts this edit tried to change, in plain words, so
 * the refusal can name them. Anything not recognised is rethrown as it came.
 * (A submitted set is not here: updateAnnotationEvent checks it under a lock
 * the submission has to wait for.)
 */
function translateEventUpdateRefusal(error: unknown, moved: string[]): never {
  const refusal = (error ?? {}) as { message?: unknown; code?: unknown; constraint?: unknown };
  for (const field of ['counter', 'defends'] as const) {
    if (refusal.code === '23503' && refusal.constraint === `pilot_calibration_events_${field}_fk`) {
      throw new Error(`Missing ${field}_against_event_id: no such event in this annotation set`);
    }
  }
  // Contact time, class and actor are held by a trigger. Start and end are
  // held by the foreign key of the moments anchored to them, and that is the
  // only other foreign key an update of these columns can break (the event's
  // own two are handled above). It is recognised by that, not by name: this
  // module names no body-point table.
  const spanHeld = refusal.code === '23503' && (moved.includes('start') || moved.includes('end'));
  if (refusal.message === 'CALIBRATION_EVENT_HAS_BODY_MOMENTS' || spanHeld) {
    throw new EventHoldsBodyMarksError(
      `Conflict: this event has marked moments, so its ${moved.join(', ')} cannot change. `
      // The actor is also held by a stance type, which this refusal came before.
      + `Remove its marked moments${moved.includes('actor') ? ' and its stance type' : ''} first, then edit it.`,
    );
  }
  if (refusal.message === 'CALIBRATION_EVENT_HAS_STANCE_LABEL') {
    throw new EventHoldsBodyMarksError(
      'Conflict: this event has a stance type, so its actor cannot change. Remove the stance type first, then edit it.',
    );
  }
  throw error;
}

export interface UpdateAnnotationEventInput
  extends Partial<Omit<RecordAnnotationEventInput, 'organizationId' | 'eventId' | 'annotationSetId'>> {
  organizationId: string;
  annotationSetId: string;
  eventId: string;
}

/**
 * Corrects an event in place, keeping its id and so everything attached to it:
 * its moments, their points, its stance type, and any relationship another
 * event points at it.
 *
 * A field left undefined stays as stored; null clears an optional one. The
 * MERGED row is then held to every rule a new event is (resolveEventFields,
 * the clip's bounds, the set's version), so an edit cannot reach a row that
 * recording would have refused. Changing the class means also clearing the
 * old class's fields; nothing is dropped on the caller's behalf.
 *
 * WHILE THE EVENT HOLDS MARKS its start, end, contact time, class and actor
 * cannot change (see the section note). That is refused naming the field; it
 * never falls back to replacing the event.
 *
 * The event row is locked before it is read, so two edits of one event merge
 * one after the other instead of the second writing the first one's fields
 * back; and the set's status is read under that lock, so an edit and a
 * submission cannot both go through.
 */
export async function updateAnnotationEvent(
  input: UpdateAnnotationEventInput,
): Promise<AnnotationEventRow> {
  const annotationSetId = requireNonEmpty(input.annotationSetId, 'annotation_set_id');
  const eventId = requireNonEmpty(input.eventId, 'event_id');

  const context = await loadSetContext(input.organizationId, annotationSetId);
  if (!context) {
    throw new Error('Not found: no such annotation set in this organization');
  }
  if (context.status !== 'in_progress') {
    throw new AnnotationSetSubmittedError();
  }

  const moved: string[] = [];
  return withTransaction(async (client) => {
    const where = 'where organization_id = $1 and annotation_set_id = $2 and event_id = $3';
    // NO KEY UPDATE: enough to make a second edit, and a moment or stance
    // type being added, wait for this one; it does not block another event's
    // relationship from pointing here.
    const current = (await client.query<AnnotationEventRow>(
      `select ${EVENT_COLUMNS} from pilot.calibration_annotation_events ${where} for no key update`,
      [input.organizationId, annotationSetId, eventId],
    )).rows[0];
    if (!current) {
      throw new Error('Not found: no such event in this annotation set');
    }
    // The set is read again, FOR SHARE, so a submission either committed
    // before this line (refused here, as submitted) or waits for this edit.
    // Without it an edit racing a submission is refused by whichever trigger
    // fires first, which under marks says "remove the marks".
    const set = (await client.query<{ status: string }>(
      `select status from pilot.calibration_annotation_sets
        where organization_id = $1 and annotation_set_id = $2 for share`,
      [input.organizationId, annotationSetId],
    )).rows[0];
    if (set?.status !== 'in_progress') {
      throw new AnnotationSetSubmittedError();
    }

    // Sent over stored, field by field. The cast below asserts nothing:
    // resolveEventFields re-checks every value, stored or sent.
    const merged: Record<string, unknown> = { organizationId: input.organizationId, eventId, annotationSetId };
    for (const [field, column] of Object.entries(EVENT_FIELD_COLUMNS)) {
      const sent = (input as unknown as Record<string, unknown>)[field];
      merged[field] = sent === undefined ? (current as unknown as Record<string, unknown>)[column] : sent;
    }
    const fields = resolveEventFields(merged as unknown as RecordAnnotationEventInput);
    // An actor that was not sent is written back exactly as stored.
    const actorTrack = input.actorTrack === undefined
      ? current.actor_track
      : requireNonEmpty(input.actorTrack, 'actor_track');
    if (merged.opponentTrack !== null && typeof merged.opponentTrack !== 'string') {
      throw new Error('Missing opponent_track: expected text, or nothing');
    }
    if (fields.startMs < current.clip_start_ms || fields.endMs > current.clip_end_ms) {
      throw new Error('Missing start_ms: the event falls outside the clip it belongs to');
    }
    assertVersionEventRules(context.ontology_version, fields);

    // A relationship never points at the event itself. That it stays inside
    // this set is the composite foreign keys' to hold; their refusal is
    // translated below.
    for (const [field, target] of [
      ['counter_against_event_id', fields.shape.counterAgainstEventId],
      ['defends_against_event_id', fields.shape.defendsAgainstEventId],
    ] as const) {
      if (target !== null && requireNonEmpty(target, field) === eventId) {
        throw new Error(`Missing ${field}: an event cannot point at itself`);
      }
    }

    moved.push(...([
      ['start', fields.startMs !== current.start_ms],
      ['end', fields.endMs !== current.end_ms],
      ['contact time', fields.contactMs !== current.contact_ms],
      ['class', fields.eventClass !== current.event_class],
      ['actor', actorTrack !== current.actor_track],
    ] as const).filter(([, changed]) => changed).map(([name]) => name));

    const row = (await client.query<AnnotationEventRow>(
      `update pilot.calibration_annotation_events
          set event_class = $4, actor_track = $5, opponent_track = $6,
              start_ms = $7, end_ms = $8, contact_ms = $9, peak_ms = $10,
              physical_hand = $11, hand_role = $12, stance = $13,
              punch_type = $14, target_zone = $15, contact_result = $16, contact_zone = $17,
              defense_type = $18, visibility = $19, certainty = $20,
              combination_group = $21, sequence_order = $22,
              counter_against_event_id = $23, defends_against_event_id = $24
        ${where}
        returning ${EVENT_COLUMNS}`,
      [
        input.organizationId, annotationSetId, eventId,
        fields.eventClass, actorTrack, merged.opponentTrack ?? null,
        fields.startMs, fields.endMs, fields.contactMs, fields.peakMs,
        fields.shape.physicalHand, fields.shape.handRole, fields.stance,
        fields.shape.punchType, fields.shape.targetZone, fields.shape.contactResult, fields.shape.contactZone,
        fields.shape.defenseType, fields.visibility, fields.certainty,
        fields.shape.combinationGroup, fields.shape.sequenceOrder,
        fields.shape.counterAgainstEventId, fields.shape.defendsAgainstEventId,
      ],
    )).rows[0];
    if (!row) {
      throw new Error('CALIBRATION_ANNOTATION_EVENT_WRITE_FAILED');
    }
    return row;
  }).catch((error) => translateEventUpdateRefusal(error, moved));
}

/**
 * Removes an event the annotator has not yet submitted.
 *
 * Scoped so it can only touch a set still in_progress. After submission the
 * trigger refuses the delete outright, which is what keeps a submitted
 * reading from being quietly trimmed to agree with the other annotator's.
 *
 * `keepIf` is for the replace path, whose delete must not take an event's
 * body marks with it. The event row is locked, THEN `keepIf` is asked on the
 * same connection; a yes leaves the event and returns false. Anything being
 * attached to the event at that instant has either committed before the
 * question or waits for the answer. This module still reads no body-point
 * table: the caller supplies the question.
 */
export async function deleteAnnotationEvent(
  organizationId: string,
  annotationSetId: string,
  eventId: string,
  options: { keepIf?: (client: PoolClient) => Promise<boolean> } = {},
): Promise<boolean> {
  const context = await loadSetContext(organizationId, annotationSetId);
  if (!context) {
    throw new Error('Not found: no such annotation set in this organization');
  }
  if (context.status !== 'in_progress') {
    throw new AnnotationSetSubmittedError();
  }

  const where = 'where organization_id = $1 and annotation_set_id = $2 and event_id = $3';
  const params = [organizationId, annotationSetId, eventId];
  const { keepIf } = options;
  if (keepIf) {
    return withTransaction(async (client) => {
      const locked = await client.query(
        `select 1 from pilot.calibration_annotation_events ${where} for update`,
        params,
      );
      if (locked.rows.length === 0 || (await keepIf(client))) return false;
      const gone = await client.query(`delete from pilot.calibration_annotation_events ${where}`, params);
      return gone.rowCount === 1;
    });
  }

  const removed = await queryOne<{ event_id: string }>(
    `delete from pilot.calibration_annotation_events ${where} returning event_id`,
    params,
  );
  return removed !== null;
}

export async function listAnnotationEvents(
  organizationId: string,
  annotationSetId: string,
): Promise<AnnotationEventRow[]> {
  return query<AnnotationEventRow>(
    `select ${EVENT_COLUMNS}
       from pilot.calibration_annotation_events
      where organization_id = $1 and annotation_set_id = $2
      order by start_ms asc, event_id asc`,
    [organizationId, annotationSetId],
  );
}
