import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { query, queryOne, withTransaction } from '../db';
import { PilotError } from '../errors';
import { AnnotationSetSubmittedError } from './annotations';
import {
  BODY_POINT_ONTOLOGY_VERSIONS,
  BODY_POINT_STATES,
  BODY_POINTS_BY_VERSION,
  GUARD_TYPES,
  LEAD_SIDES,
  MOMENT_SLOTS,
  STANCE_TYPES,
  isInVocabulary,
  type BodyPoint,
  type BodyPointOntologyVersion,
  type BodyPointState,
  type GuardType,
  type LeadSide,
  type MomentKind,
  type MomentSlot,
  type StanceType,
} from './ontology';

// A coach's hand-marked body points on one annotation set (TEACH-BIOMECH-01-d).
//
// WHAT THIS MODULE IS. The one place runtime code reads or writes
// pilot.calibration_body_moments, pilot.calibration_body_points and
// pilot.calibration_event_stance_labels. bodyPoints.test.ts holds that line
// with a source grep, so body points cannot quietly become an input to gold
// records, an export or a model: using them for training is a later,
// separately governed item (OD-2026-10-02-011 section 3).
//
// EVERY RULE LIVES IN THE DATABASE FIRST. The two body-point migrations hold
// the version gate, the submitted freeze, the per-version point list, the
// placed-or-not-visible shape, the moment timing and everything else in their
// headers. What this module adds is the part a trigger cannot do: it DERIVES
// the moment's time and kind from the event, so the client never says when
// "start" is; it refuses bad input with a 400 that names the field before any
// write; and it turns the database's refusals into the repo's shapes. Where
// the two disagree the database wins. calibrationBodyPointsModule.pg.test.ts
// writes a sample of the rows this module refuses straight to the tables and
// shows the database refuses them too (a time off the event, a position off
// the picture, a point outside the version, a lead side outside the list, any
// write on a 0.1 or a submitted set); bodyPoints.test.ts covers every branch
// of translateDatabaseRefusal.
//
// EVERY VOCABULARY IS REJECTED, NEVER COERCED, as in annotations.ts: an
// unknown guard is "Missing guard_type", never 'unknown' -- which is a recorded
// observation ("the coach looked and could not tell") and must not be
// manufactured from a bug.
//
// WHOSE SET. Every function here is scoped to (organization_id,
// annotation_set_id), and a moment, point or event that is not in that set is
// reported as absent, never found under another set. That the set is the
// CALLER'S is the route's job (annotatorGate.loadOwnAnnotationSet), as it is
// for events: the module does not know who is asking.
//
// NO SCORE, NO JUDGEMENT, NO MACHINE. Nothing here says a point is well placed,
// a guard is good, or a stance is right; nothing proposes a point.

export interface BodyMomentRow {
  organization_id: string;
  body_moment_id: string;
  annotation_set_id: string;
  calibration_clip_id: string;
  event_id: string;
  event_start_ms: number;
  event_end_ms: number;
  moment_slot: string;
  moment_kind: string;
  observation_ms: number;
  lead_side: string | null;
  guard_type: string | null;
  source_frame_width_px: number | null;
  source_frame_height_px: number | null;
  // Typed as annotations.ts types its timestamps (a Date at runtime; see the
  // note on AnnotationSetRow.created_at).
  created_at: string;
}

export interface BodyPointRow {
  organization_id: string;
  body_point_id: string;
  annotation_set_id: string;
  body_moment_id: string;
  point_code: string;
  state: string;
  x_norm: number | null;
  y_norm: number | null;
  created_at: string;
  updated_at: string;
}

export interface EventStanceLabelRow {
  organization_id: string;
  annotation_set_id: string;
  event_id: string;
  stance_type: string;
  created_at: string;
  updated_at: string;
}

const MOMENT_COLUMNS = `
  organization_id, body_moment_id, annotation_set_id, calibration_clip_id, event_id,
  event_start_ms, event_end_ms, moment_slot, moment_kind, observation_ms,
  lead_side, guard_type, source_frame_width_px, source_frame_height_px, created_at
`;

const POINT_COLUMNS = `
  organization_id, body_point_id, annotation_set_id, body_moment_id,
  point_code, state, x_norm, y_norm, created_at, updated_at
`;

const STANCE_COLUMNS = `
  organization_id, annotation_set_id, event_id, stance_type, created_at, updated_at
`;

/**
 * Raised when a set's vocabulary has no body points (a 0.1 set).
 *
 * The database raises CALIBRATION_BODY_POINTS_NOT_IN_THIS_VERSION too; this
 * exists so the ordinary path says which version the set is on, in the words
 * annotation-set/route.ts already uses for a project the build cannot label.
 * 'Forbidden', not 'Missing': the input was fine, the set cannot take it.
 */
export class BodyPointsNotInThisVersionError extends Error {
  constructor(ontologyVersion: string) {
    super(
      `Forbidden: this annotation set is stamped ${ontologyVersion}, which has no body points; `
      + `body points belong to ${BODY_POINT_ONTOLOGY_VERSIONS.join(', ')}`,
    );
    this.name = 'BodyPointsNotInThisVersionError';
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value.trim();
}

function requireVocabulary<T extends string>(vocabulary: readonly T[], value: unknown, field: string): T {
  if (!isInVocabulary(vocabulary, value)) {
    throw new Error(`Missing ${field}: not a value in the body-point vocabulary`);
  }
  return value;
}

function optionalVocabulary<T extends string>(vocabulary: readonly T[], value: unknown, field: string): T | null {
  if (value === null || value === undefined) return null;
  return requireVocabulary(vocabulary, value, field);
}

/** The column is a Postgres integer; past its range the database would raise
 * out-of-range (22003), a 500 for what is bad input. */
const MAX_PIXELS = 2_147_483_647;

function optionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_PIXELS) {
    throw new Error(`Missing ${field}: expected a whole number of pixels, greater than zero`);
  }
  return value;
}

/** A fraction of the picture: a finite number from 0 to 1. NaN and infinity
 * are refused here by name; the database's range CHECK refuses them too. */
function requireFraction(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Missing ${field}: expected a number from 0 to 1, a fraction of the picture`);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * THE SET AND THE EVENT A WRITE IS ABOUT
 * ------------------------------------------------------------------ */

interface BodySetContext {
  annotation_set_id: string;
  calibration_clip_id: string;
  status: string;
  ontology_version: string;
}

/**
 * The set, checked in the order the routes refuse: absent, then submitted,
 * then a version with no body points. Returns the version typed, so every
 * caller reads its point list from BODY_POINTS_BY_VERSION and nowhere else.
 */
async function loadWritableSet(
  organizationId: string,
  annotationSetId: string,
): Promise<BodySetContext & { ontology_version: BodyPointOntologyVersion }> {
  const set = await queryOne<BodySetContext>(
    `select annotation_set_id, calibration_clip_id, status, ontology_version
       from pilot.calibration_annotation_sets
      where organization_id = $1 and annotation_set_id = $2`,
    [organizationId, requireNonEmpty(annotationSetId, 'annotation_set_id')],
  );
  if (!set) {
    throw new Error('Not found: no such annotation set in this organization');
  }
  if (set.status !== 'in_progress') {
    throw new AnnotationSetSubmittedError();
  }
  if (!isInVocabulary(BODY_POINT_ONTOLOGY_VERSIONS, set.ontology_version)) {
    throw new BodyPointsNotInThisVersionError(set.ontology_version);
  }
  return { ...set, ontology_version: set.ontology_version };
}

interface EventTiming {
  event_id: string;
  event_class: string;
  start_ms: number;
  end_ms: number;
  contact_ms: number | null;
}

async function loadEventInSet(
  organizationId: string,
  annotationSetId: string,
  eventId: string,
): Promise<EventTiming> {
  const event = await queryOne<EventTiming>(
    `select event_id, event_class, start_ms, end_ms, contact_ms
       from pilot.calibration_annotation_events
      where organization_id = $1 and annotation_set_id = $2 and event_id = $3`,
    [organizationId, annotationSetId, requireNonEmpty(eventId, 'event_id')],
  );
  if (!event) {
    throw new Error('Not found: no such event in this annotation set');
  }
  return event;
}

async function loadMomentInSet(
  organizationId: string,
  annotationSetId: string,
  bodyMomentId: string,
): Promise<BodyMomentRow> {
  const moment = await queryOne<BodyMomentRow>(
    `select ${MOMENT_COLUMNS}
       from pilot.calibration_body_moments
      where organization_id = $1 and annotation_set_id = $2 and body_moment_id = $3`,
    [organizationId, annotationSetId, requireNonEmpty(bodyMomentId, 'body_moment_id')],
  );
  if (!moment) {
    throw new Error('Not found: no such body moment in this annotation set');
  }
  return moment;
}

/* ------------------------------------------------------------------ *
 * WHEN A MOMENT IS: derived from the event, never sent by the client
 * ------------------------------------------------------------------ */

export interface ResolvedMomentTiming {
  momentKind: MomentKind;
  observationMs: number;
}

/**
 * The time and kind of one slot of one event (OD-2026-10-02-011 3a; the
 * stand-in architect's furthest_point for a defence).
 *
 * start and end are the event's own edges. The middle is the contact time
 * whenever the event has one; only an event with no contact time has a free
 * middle -- full extension for a punch, furthest point for a defence -- and
 * that is the one time the coach picks, inside the event. A time sent for a
 * derived moment is refused rather than ignored: a client that thinks it
 * chooses when "start" is has misunderstood the data, and a silently dropped
 * value hides that.
 *
 * Exported for the unit test; pure.
 */
export function resolveMomentTiming(
  event: Pick<EventTiming, 'event_class' | 'start_ms' | 'end_ms' | 'contact_ms'>,
  momentSlot: MomentSlot,
  observationMs: number | null | undefined,
): ResolvedMomentTiming {
  const sent = observationMs !== null && observationMs !== undefined;

  if (momentSlot === 'start' || momentSlot === 'end') {
    if (sent) {
      throw new Error(`Missing observation_ms: the ${momentSlot} moment sits on the event's ${momentSlot}; do not send a time`);
    }
    return { momentKind: momentSlot, observationMs: momentSlot === 'start' ? event.start_ms : event.end_ms };
  }

  if (event.contact_ms !== null) {
    if (sent) {
      throw new Error('Missing observation_ms: the middle moment of an event with a contact time sits on it; do not send a time');
    }
    return { momentKind: 'contact', observationMs: event.contact_ms };
  }

  const momentKind: MomentKind = event.event_class === 'punch' ? 'full_extension' : 'furthest_point';
  if (!sent || typeof observationMs !== 'number' || !Number.isInteger(observationMs)) {
    throw new Error(
      `Missing observation_ms: this event has no contact time, so the coach picks the ${momentKind.replace('_', ' ')} moment, a whole number of milliseconds inside the event`,
    );
  }
  if (observationMs < event.start_ms || observationMs > event.end_ms) {
    throw new Error('Missing observation_ms: must fall within the event');
  }
  return { momentKind, observationMs };
}

/* ------------------------------------------------------------------ *
 * THE DATABASE'S REFUSALS, in the repo's shapes
 * ------------------------------------------------------------------ */

interface DatabaseError {
  message?: unknown;
  code?: unknown;
  constraint?: unknown;
}

/** The links a write can lose in a race with a delete: the event under a
 * moment or a stance label, the moment under a point. */
const PARENT_GONE_CONSTRAINTS = new Set([
  'pilot_calibration_body_moments_event_fk',
  'pilot_calibration_event_stance_labels_event_fk',
  'pilot_calibration_body_points_moment_fk',
]);

/**
 * Turns the triggers' and constraints' refusals into the shapes jsonError
 * maps, for the cases the pre-checks above cannot close: a race with a
 * submission, two tabs opening the same slot, an event replaced (events
 * PUT deletes the old row) while a mark was in flight, a point list that
 * changed under a long-open screen. Anything not recognised is rethrown as it
 * came, which jsonError reports as a 500 without its text.
 *
 * Each 409 carries a machine code (jsonError emits it as `code`), so a
 * tablet that lost a response can tell "slot taken, read the moment back"
 * from "event changed, reload" without matching message text.
 *
 * Exported for bodyPoints.test.ts, which drives every branch with the shape
 * pg raises (message = the trigger's text; code and constraint from the
 * server); the pg suite reaches only the branches a test can race.
 */
export function translateDatabaseRefusal(error: unknown): never {
  const dbError = (error ?? {}) as DatabaseError;
  const message = typeof dbError.message === 'string' ? dbError.message : '';
  const constraint = typeof dbError.constraint === 'string' ? dbError.constraint : '';

  if (message === 'CALIBRATION_ANNOTATION_SET_SUBMITTED') {
    throw new AnnotationSetSubmittedError();
  }
  if (message === 'CALIBRATION_BODY_POINTS_NOT_IN_THIS_VERSION') {
    throw new PilotError(403, 'Forbidden: this annotation set\'s vocabulary has no body points', 'CALIBRATION_BODY_POINTS_NOT_IN_THIS_VERSION');
  }
  if (message === 'CALIBRATION_BODY_POINT_NOT_IN_THIS_VERSION') {
    throw new Error('Missing point_code: not a point in this annotation set\'s vocabulary');
  }
  if (message === 'CALIBRATION_BODY_MOMENT_KIND_NOT_THIS_EVENT') {
    throw new PilotError(409, 'Conflict: the event changed under this moment; reload and mark it again', 'CALIBRATION_BODY_MOMENT_EVENT_CHANGED');
  }
  if (dbError.code === '23505' && constraint === 'pilot_calibration_body_moments_one_per_slot') {
    throw new PilotError(409, 'Conflict: this event already has a moment in that slot', 'CALIBRATION_BODY_MOMENT_SLOT_TAKEN');
  }
  if (dbError.code === '23503' && PARENT_GONE_CONSTRAINTS.has(constraint)) {
    throw new Error('Not found: the event or moment this mark belongs to is gone; reload');
  }
  // Two writers on one moment: Postgres aborted one of them. Nothing of its
  // batch is kept (withTransaction rolled it back); the client retries.
  if (dbError.code === '40P01' || dbError.code === '40001') {
    throw new PilotError(409, 'Conflict: another write on this moment got there first; try again', 'CALIBRATION_BODY_POINTS_WRITE_RACE');
  }
  throw error;
}

/* ------------------------------------------------------------------ *
 * MOMENTS
 * ------------------------------------------------------------------ */

export interface OpenBodyMomentInput {
  organizationId: string;
  annotationSetId: string;
  eventId: string;
  momentSlot: MomentSlot;
  /** Only for a middle moment of an event with no contact time. */
  observationMs?: number | null;
  leadSide?: LeadSide | null;
  guardType?: GuardType | null;
  sourceFrameWidthPx?: number | null;
  sourceFrameHeightPx?: number | null;
}

/**
 * Opens one of the three moments of one event.
 *
 * The event's bounds are read from the event and written onto the row, where
 * the composite foreign key ties them back (the annotations containment
 * pattern), so the on-edge CHECKs cannot be met by a lie about the event. An
 * occupied slot is a 409, never a silent overwrite: changing a moment's
 * labels is updateBodyMoment, and moving it is delete then open.
 *
 * The id is minted here. The key is (organization, body_moment_id), so a
 * caller-chosen id could collide with a moment in any set of the
 * organization -- and whether it collides would say that moment exists.
 */
export async function openBodyMoment(input: OpenBodyMomentInput): Promise<BodyMomentRow> {
  const bodyMomentId = randomUUID();
  const momentSlot = requireVocabulary(MOMENT_SLOTS, input.momentSlot, 'moment_slot');
  const leadSide = optionalVocabulary(LEAD_SIDES, input.leadSide, 'lead_side');
  const guardType = optionalVocabulary(GUARD_TYPES, input.guardType, 'guard_type');
  const width = optionalPositiveInteger(input.sourceFrameWidthPx, 'source_frame_width_px');
  const height = optionalPositiveInteger(input.sourceFrameHeightPx, 'source_frame_height_px');
  if ((width === null) !== (height === null)) {
    throw new Error('Missing source_frame_height_px: the picture size needs both sides, or neither');
  }

  const set = await loadWritableSet(input.organizationId, input.annotationSetId);
  const event = await loadEventInSet(input.organizationId, set.annotation_set_id, input.eventId);
  const timing = resolveMomentTiming(event, momentSlot, input.observationMs);

  const row = await queryOne<BodyMomentRow>(
    `insert into pilot.calibration_body_moments
       (organization_id, body_moment_id, annotation_set_id, calibration_clip_id, event_id,
        event_start_ms, event_end_ms, moment_slot, moment_kind, observation_ms,
        lead_side, guard_type, source_frame_width_px, source_frame_height_px)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning ${MOMENT_COLUMNS}`,
    [
      input.organizationId,
      bodyMomentId,
      set.annotation_set_id,
      set.calibration_clip_id,
      event.event_id,
      event.start_ms,
      event.end_ms,
      momentSlot,
      timing.momentKind,
      timing.observationMs,
      leadSide,
      guardType,
      width,
      height,
    ],
  ).catch(translateDatabaseRefusal);

  if (!row) {
    throw new Error('CALIBRATION_BODY_MOMENT_WRITE_FAILED');
  }
  return row;
}

export interface UpdateBodyMomentInput {
  organizationId: string;
  annotationSetId: string;
  bodyMomentId: string;
  /** Only for a middle moment of an event with no contact time. */
  observationMs?: number | null;
  leadSide?: LeadSide | null;
  guardType?: GuardType | null;
  sourceFrameWidthPx?: number | null;
  sourceFrameHeightPx?: number | null;
}

/**
 * Changes what the coach recorded AT a moment: the lead side, the guard, the
 * picture size, and for a free middle its time. Never where the moment is:
 * its event and slot are fixed identity (the moments guard). A field left
 * undefined is left alone; null clears it.
 */
export async function updateBodyMoment(input: UpdateBodyMomentInput): Promise<BodyMomentRow> {
  const set = await loadWritableSet(input.organizationId, input.annotationSetId);
  const current = await loadMomentInSet(input.organizationId, set.annotation_set_id, input.bodyMomentId);

  const leadSide = input.leadSide === undefined
    ? current.lead_side
    : optionalVocabulary(LEAD_SIDES, input.leadSide, 'lead_side');
  const guardType = input.guardType === undefined
    ? current.guard_type
    : optionalVocabulary(GUARD_TYPES, input.guardType, 'guard_type');
  const width = input.sourceFrameWidthPx === undefined
    ? current.source_frame_width_px
    : optionalPositiveInteger(input.sourceFrameWidthPx, 'source_frame_width_px');
  const height = input.sourceFrameHeightPx === undefined
    ? current.source_frame_height_px
    : optionalPositiveInteger(input.sourceFrameHeightPx, 'source_frame_height_px');
  if ((width === null) !== (height === null)) {
    throw new Error('Missing source_frame_height_px: the picture size needs both sides, or neither');
  }

  let observationMs = current.observation_ms;
  if (input.observationMs !== undefined) {
    const event = await loadEventInSet(input.organizationId, set.annotation_set_id, current.event_id);
    observationMs = resolveMomentTiming(
      event,
      requireVocabulary(MOMENT_SLOTS, current.moment_slot, 'moment_slot'),
      input.observationMs,
    ).observationMs;
  }

  const row = await queryOne<BodyMomentRow>(
    `update pilot.calibration_body_moments
        set observation_ms = $4, lead_side = $5, guard_type = $6,
            source_frame_width_px = $7, source_frame_height_px = $8
      where organization_id = $1 and annotation_set_id = $2 and body_moment_id = $3
      returning ${MOMENT_COLUMNS}`,
    [input.organizationId, set.annotation_set_id, current.body_moment_id, observationMs, leadSide, guardType, width, height],
  ).catch(translateDatabaseRefusal);

  if (!row) {
    throw new Error('Not found: no such body moment in this annotation set');
  }
  return row;
}

/** Removes a moment and, by cascade, its points. */
export async function deleteBodyMoment(
  organizationId: string,
  annotationSetId: string,
  bodyMomentId: string,
): Promise<boolean> {
  const set = await loadWritableSet(organizationId, annotationSetId);
  const removed = await queryOne<{ body_moment_id: string }>(
    `delete from pilot.calibration_body_moments
      where organization_id = $1 and annotation_set_id = $2 and body_moment_id = $3
      returning body_moment_id`,
    [organizationId, set.annotation_set_id, requireNonEmpty(bodyMomentId, 'body_moment_id')],
  ).catch(translateDatabaseRefusal);
  return removed !== null;
}

/* ------------------------------------------------------------------ *
 * POINTS
 * ------------------------------------------------------------------ */

export interface BodyPointMark {
  pointCode: BodyPoint;
  state: BodyPointState;
  xNorm?: number | null;
  yNorm?: number | null;
}

export interface MarkBodyPointsInput {
  organizationId: string;
  annotationSetId: string;
  bodyMomentId: string;
  points: BodyPointMark[];
}

interface ResolvedMark {
  pointCode: BodyPoint;
  state: BodyPointState;
  xNorm: number | null;
  yNorm: number | null;
}

/**
 * One mark, checked against the SET'S OWN point list: solar_plexus on a 0.2
 * set and an ankle on a 0.4 set are refused by name here and by the points
 * guard underneath. A placed point carries both fractions; a not-visible one
 * carries neither, and a coordinate sent with not_visible is refused rather
 * than dropped, for the same reason as a time sent for a derived moment.
 */
function resolveMark(mark: BodyPointMark, pointList: readonly BodyPoint[], ontologyVersion: string): ResolvedMark {
  if (mark === null || typeof mark !== 'object') {
    throw new Error('Missing points: each point is an object with point_code and state');
  }
  if (!isInVocabulary(pointList, mark.pointCode)) {
    throw new Error(`Missing point_code: not a point in ${ontologyVersion}`);
  }
  const state = requireVocabulary(BODY_POINT_STATES, mark.state, 'state');
  if (state === 'placed') {
    return {
      pointCode: mark.pointCode,
      state,
      xNorm: requireFraction(mark.xNorm, 'x_norm'),
      yNorm: requireFraction(mark.yNorm, 'y_norm'),
    };
  }
  if ((mark.xNorm !== null && mark.xNorm !== undefined) || (mark.yNorm !== null && mark.yNorm !== undefined)) {
    throw new Error('Missing x_norm: a point marked not visible has no position; send none');
  }
  return { pointCode: mark.pointCode, state, xNorm: null, yNorm: null };
}

/**
 * Records where the coach put each point at one moment: one or many, each
 * written over any earlier mark of the same point, all in one transaction so
 * a refused point leaves the moment as it was. Returns every point now on
 * the moment, in the version's marking order.
 */
export async function markBodyPoints(input: MarkBodyPointsInput): Promise<BodyPointRow[]> {
  if (!Array.isArray(input.points) || input.points.length === 0) {
    throw new Error('Missing points: expected at least one point');
  }
  const set = await loadWritableSet(input.organizationId, input.annotationSetId);
  const pointList = BODY_POINTS_BY_VERSION[set.ontology_version];
  const marks = input.points.map((mark) => resolveMark(mark, pointList, set.ontology_version));
  const seen = new Set<string>();
  for (const mark of marks) {
    if (seen.has(mark.pointCode)) {
      throw new Error(`Missing point_code: ${mark.pointCode} is sent twice`);
    }
    seen.add(mark.pointCode);
  }
  // Written in the version's marking order whatever order they arrived in, so
  // two tabs marking the same moment take their row locks in the same order
  // and one waits for the other instead of both deadlocking.
  const order = new Map<string, number>(pointList.map((code, index) => [code, index]));
  marks.sort((a, b) => (order.get(a.pointCode) ?? 0) - (order.get(b.pointCode) ?? 0));
  const moment = await loadMomentInSet(input.organizationId, set.annotation_set_id, input.bodyMomentId);

  return withTransaction(async (client) => {
    for (const mark of marks) {
      await client.query(
        `insert into pilot.calibration_body_points
           (organization_id, body_point_id, annotation_set_id, body_moment_id, point_code, state, x_norm, y_norm)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (organization_id, body_moment_id, point_code) do update
           set state = excluded.state, x_norm = excluded.x_norm, y_norm = excluded.y_norm, updated_at = now()`,
        [input.organizationId, randomUUID(), set.annotation_set_id, moment.body_moment_id, mark.pointCode, mark.state, mark.xNorm, mark.yNorm],
      );
    }
    const result = await client.query<BodyPointRow>(
      `select ${POINT_COLUMNS}
         from pilot.calibration_body_points
        where organization_id = $1 and annotation_set_id = $2 and body_moment_id = $3`,
      [input.organizationId, set.annotation_set_id, moment.body_moment_id],
    );
    return sortByMarkingOrder(result.rows, pointList);
  }).catch(translateDatabaseRefusal);
}

/** Removes one point's mark, so the coach can mark it afresh. */
export async function deleteBodyPoint(
  organizationId: string,
  annotationSetId: string,
  bodyMomentId: string,
  pointCode: string,
): Promise<boolean> {
  const set = await loadWritableSet(organizationId, annotationSetId);
  const removed = await queryOne<{ body_point_id: string }>(
    `delete from pilot.calibration_body_points
      where organization_id = $1 and annotation_set_id = $2 and body_moment_id = $3 and point_code = $4
      returning body_point_id`,
    [organizationId, set.annotation_set_id, requireNonEmpty(bodyMomentId, 'body_moment_id'), requireNonEmpty(pointCode, 'point_code')],
  ).catch(translateDatabaseRefusal);
  return removed !== null;
}

function sortByMarkingOrder(points: BodyPointRow[], pointList: readonly BodyPoint[]): BodyPointRow[] {
  const order = new Map<string, number>(pointList.map((code, index) => [code, index]));
  return [...points].sort(
    (a, b) => (order.get(a.point_code) ?? pointList.length) - (order.get(b.point_code) ?? pointList.length),
  );
}

/* ------------------------------------------------------------------ *
 * STANCE TYPE, once per event
 * ------------------------------------------------------------------ */

export interface SetEventStanceTypeInput {
  organizationId: string;
  annotationSetId: string;
  eventId: string;
  stanceType: StanceType;
}

/** Records, or changes, the named stance of one event (OD-2026-10-02-014). */
export async function setEventStanceType(input: SetEventStanceTypeInput): Promise<EventStanceLabelRow> {
  const stanceType = requireVocabulary(STANCE_TYPES, input.stanceType, 'stance_type');
  const set = await loadWritableSet(input.organizationId, input.annotationSetId);
  const event = await loadEventInSet(input.organizationId, set.annotation_set_id, input.eventId);

  const row = await queryOne<EventStanceLabelRow>(
    `insert into pilot.calibration_event_stance_labels
       (organization_id, annotation_set_id, event_id, stance_type)
     values ($1, $2, $3, $4)
     on conflict (organization_id, event_id) do update
       set stance_type = excluded.stance_type, updated_at = now()
     returning ${STANCE_COLUMNS}`,
    [input.organizationId, set.annotation_set_id, event.event_id, stanceType],
  ).catch(translateDatabaseRefusal);

  if (!row) {
    throw new Error('CALIBRATION_EVENT_STANCE_LABEL_WRITE_FAILED');
  }
  return row;
}

export async function clearEventStanceType(
  organizationId: string,
  annotationSetId: string,
  eventId: string,
): Promise<boolean> {
  const set = await loadWritableSet(organizationId, annotationSetId);
  const removed = await queryOne<{ event_id: string }>(
    `delete from pilot.calibration_event_stance_labels
      where organization_id = $1 and annotation_set_id = $2 and event_id = $3
      returning event_id`,
    [organizationId, set.annotation_set_id, requireNonEmpty(eventId, 'event_id')],
  ).catch(translateDatabaseRefusal);
  return removed !== null;
}

/* ------------------------------------------------------------------ *
 * DOES AN EVENT HOLD MARKS
 * ------------------------------------------------------------------ */

/**
 * Whether an event holds a moment or a stance type: a yes or a no, never the
 * marks themselves.
 *
 * The one thing the events route asks of this module (bodyPoints.test.ts
 * holds it to this function alone). Replacing an event deletes the old row,
 * and its marks go with it by cascade, so the replace path asks first and
 * refuses.
 *
 * Scoped to the organization and the set. Given the caller's transaction
 * client it reads on that connection, so the answer is taken under whatever
 * lock the caller already holds on the event.
 */
export async function eventHoldsBodyMarks(
  organizationId: string,
  annotationSetId: string,
  eventId: string,
  client?: PoolClient,
): Promise<boolean> {
  const text = `select (
      exists (select 1 from pilot.calibration_body_moments
               where organization_id = $1 and annotation_set_id = $2 and event_id = $3)
      or exists (select 1 from pilot.calibration_event_stance_labels
                  where organization_id = $1 and annotation_set_id = $2 and event_id = $3)
    ) as holds`;
  const params = [organizationId, annotationSetId, eventId];
  const row = client
    ? (await client.query<{ holds: boolean }>(text, params)).rows[0]
    : await queryOne<{ holds: boolean }>(text, params);
  return row?.holds === true;
}

/* ------------------------------------------------------------------ *
 * READING ONE SET
 * ------------------------------------------------------------------ */

export interface BodyMomentWithPoints extends BodyMomentRow {
  points: BodyPointRow[];
}

export interface BodyDataForSet {
  /** The set's own point list, in marking order; null for a set with none. */
  expected_points: readonly BodyPoint[] | null;
  moments: BodyMomentWithPoints[];
  stance_labels: EventStanceLabelRow[];
}

/**
 * Everything marked on one set. Scoped to that set and nothing else; a
 * submitted set reads the same way, which is how the page shows it read-only.
 *
 * NOT BLINDED, as listAnnotationSetsForClip in annotations.ts warns of
 * itself: this returns whatever set it is given. A route must resolve the set
 * through annotatorGate.loadOwnAnnotationSet first, so an annotator never
 * reads another's unsubmitted marks (OD-2026-08-29-002/-003). The same holds
 * for listMissingBodyData, which is a set's progress.
 *
 * One transaction, so a mark landing between the three reads cannot show a
 * moment with half its points.
 */
export async function listBodyDataForSet(
  organizationId: string,
  annotationSetId: string,
): Promise<BodyDataForSet> {
  const setId = requireNonEmpty(annotationSetId, 'annotation_set_id');
  const { set, moments, points, stanceLabels } = await withTransaction(async (client) => {
    const setResult = await client.query<{ ontology_version: string }>(
      `select ontology_version from pilot.calibration_annotation_sets
        where organization_id = $1 and annotation_set_id = $2`,
      [organizationId, setId],
    );
    const found = setResult.rows[0];
    if (!found) {
      return { set: null, moments: [], points: [], stanceLabels: [] };
    }
    const [momentResult, pointResult, stanceResult] = await Promise.all([
      client.query<BodyMomentRow>(
        `select ${MOMENT_COLUMNS} from pilot.calibration_body_moments
          where organization_id = $1 and annotation_set_id = $2
          order by event_id asc, observation_ms asc,
            case moment_slot when 'start' then 0 when 'middle' then 1 else 2 end asc`,
        [organizationId, setId],
      ),
      client.query<BodyPointRow>(
        `select ${POINT_COLUMNS} from pilot.calibration_body_points
          where organization_id = $1 and annotation_set_id = $2`,
        [organizationId, setId],
      ),
      client.query<EventStanceLabelRow>(
        `select ${STANCE_COLUMNS} from pilot.calibration_event_stance_labels
          where organization_id = $1 and annotation_set_id = $2
          order by event_id asc`,
        [organizationId, setId],
      ),
    ]);
    return { set: found, moments: momentResult.rows, points: pointResult.rows, stanceLabels: stanceResult.rows };
  });
  if (!set) {
    throw new Error('Not found: no such annotation set in this organization');
  }
  const pointList = isInVocabulary(BODY_POINT_ONTOLOGY_VERSIONS, set.ontology_version)
    ? BODY_POINTS_BY_VERSION[set.ontology_version]
    : null;

  const byMoment = new Map<string, BodyPointRow[]>();
  for (const point of points) {
    const list = byMoment.get(point.body_moment_id) ?? [];
    list.push(point);
    byMoment.set(point.body_moment_id, list);
  }
  return {
    expected_points: pointList,
    moments: moments.map((moment) => ({
      ...moment,
      points: sortByMarkingOrder(byMoment.get(moment.body_moment_id) ?? [], pointList ?? []),
    })),
    stance_labels: stanceLabels,
  };
}

/**
 * What the submission trigger would name as missing, read ahead of time so
 * the page can show it before the coach presses submit. The same query as
 * pilot.calibration_annotation_sets_body_point_rules, item for item; the
 * trigger is the authority and the pg test asserts the two agree. An empty
 * list means the set would pass the completeness check -- and nothing more.
 */
export async function listMissingBodyData(
  organizationId: string,
  annotationSetId: string,
): Promise<string[]> {
  const setId = requireNonEmpty(annotationSetId, 'annotation_set_id');
  const set = await queryOne<{ ontology_version: string }>(
    `select ontology_version from pilot.calibration_annotation_sets
      where organization_id = $1 and annotation_set_id = $2`,
    [organizationId, setId],
  );
  if (!set) {
    throw new Error('Not found: no such annotation set in this organization');
  }
  if (!isInVocabulary(BODY_POINT_ONTOLOGY_VERSIONS, set.ontology_version)) {
    return [];
  }
  const expected = BODY_POINTS_BY_VERSION[set.ontology_version].length;

  const rows = await query<{ item: string }>(
    `select item from (
       select e.event_id || ': stance type' as item
         from pilot.calibration_annotation_events e
        where e.organization_id = $1 and e.annotation_set_id = $2
          and not exists (
            select 1 from pilot.calibration_event_stance_labels s
             where s.organization_id = e.organization_id and s.event_id = e.event_id)
       union all
       select e.event_id || ': ' || slot.moment_slot || ' moment'
         from pilot.calibration_annotation_events e
        cross join (values ('start'), ('middle'), ('end')) as slot(moment_slot)
        where e.organization_id = $1 and e.annotation_set_id = $2
          and not exists (
            select 1 from pilot.calibration_body_moments m
             where m.organization_id = e.organization_id and m.event_id = e.event_id
               and m.moment_slot = slot.moment_slot)
       union all
       select m.event_id || ': ' || m.moment_slot || ' lead side'
         from pilot.calibration_body_moments m
        where m.organization_id = $1 and m.annotation_set_id = $2 and m.lead_side is null
       union all
       select m.event_id || ': ' || m.moment_slot || ' guard'
         from pilot.calibration_body_moments m
        where m.organization_id = $1 and m.annotation_set_id = $2 and m.guard_type is null
       union all
       select m.event_id || ': ' || m.moment_slot || ' points, ' || count(p.point_code) || ' of ' || $3::integer
         from pilot.calibration_body_moments m
         left join pilot.calibration_body_points p
           on p.organization_id = m.organization_id
          and p.annotation_set_id = m.annotation_set_id
          and p.body_moment_id = m.body_moment_id
        where m.organization_id = $1 and m.annotation_set_id = $2
        group by m.event_id, m.moment_slot, m.body_moment_id
       having count(p.point_code) <> $3::integer
     ) as missing_items
     order by item`,
    [organizationId, setId, expected],
  );
  return rows.map((row) => row.item);
}
