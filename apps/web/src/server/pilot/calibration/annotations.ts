import { query, queryOne } from '../db';
import {
  ANNOTATION_CERTAINTIES,
  CONTACT_RESULTS,
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
  ontology_version, status, created_at, submitted_at
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
    `select s.annotation_set_id, s.calibration_clip_id, s.status, s.annotator_account_id,
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
 * A second set for the same annotator and clip is refused by
 * pilot_calibration_sets_one_per_annotator_uq. That is the unit of
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

export async function getAnnotationSet(
  organizationId: string,
  annotationSetId: string,
): Promise<AnnotationSetRow | null> {
  return queryOne<AnnotationSetRow>(
    `select ${SET_COLUMNS}
       from pilot.calibration_annotation_sets
      where organization_id = $1 and annotation_set_id = $2`,
    [organizationId, annotationSetId],
  );
}

/**
 * Every set for one clip, both annotators' included.
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

/**
 * Removes an event the annotator has not yet submitted.
 *
 * Scoped so it can only touch a set still in_progress. After submission the
 * trigger refuses the delete outright, which is what keeps a submitted
 * reading from being quietly trimmed to agree with the other annotator's.
 */
export async function deleteAnnotationEvent(
  organizationId: string,
  annotationSetId: string,
  eventId: string,
): Promise<boolean> {
  const context = await loadSetContext(organizationId, annotationSetId);
  if (!context) {
    throw new Error('Not found: no such annotation set in this organization');
  }
  if (context.status !== 'in_progress') {
    throw new AnnotationSetSubmittedError();
  }

  const removed = await queryOne<{ event_id: string }>(
    `delete from pilot.calibration_annotation_events
      where organization_id = $1 and annotation_set_id = $2 and event_id = $3
      returning event_id`,
    [organizationId, annotationSetId, eventId],
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
