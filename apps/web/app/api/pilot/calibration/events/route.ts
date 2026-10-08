import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';
import type { PoolClient } from 'pg';

import {
  EventHoldsBodyMarksError,
  deleteAnnotationEvent,
  listAnnotationEvents,
  recordAnnotationEvent,
  updateAnnotationEvent,
  type RecordAnnotationEventInput,
  type UpdateAnnotationEventInput,
} from '@/src/server/pilot/calibration/annotations';
import { eventHoldsBodyMarks } from '@/src/server/pilot/calibration/bodyPoints';
import { BODY_POINT_ONTOLOGY_VERSIONS, isInVocabulary } from '@/src/server/pilot/calibration/ontology';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import {
  assertSetInProgress,
  blankToNull,
  loadOwnAnnotationSet,
  loadPlayableClip,
  optionalMs,
  requireAnnotator,
  writeCalibrationAuditEvent,
} from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * WHAT ONE ANNOTATOR SAYS THEY SAW -- created, replaced, edited in place,
 * removed.
 *
 * Every method below refuses in the same order and for the same reasons:
 *
 *   1. the caller is a coach or an organization admin;
 *   2. the set is THEIRS (a set belonging to someone else is reported as
 *      absent, never as forbidden -- see loadOwnAnnotationSet);
 *   3. the set is still in_progress;
 *   4. (writes that require watching) the footage is still clippable.
 *
 * NO VOCABULARY IS VALIDATED HERE. Not one label, not one bound, not the
 * class-conditional shape of a punch versus a defense. All of it belongs to
 * recordAnnotationEvent and, under that, to the CHECK constraints -- and a
 * copy of those rules in a route is a copy that drifts, which for a controlled
 * vocabulary means two surfaces silently accepting different sets of labels.
 * This file's whole job on the way in is to turn wire shapes into the module's
 * input shape without inventing a value: an empty optional control becomes
 * null ("not recorded"), never 'unknown' ("looked and could not tell").
 */

/**
 * An optional whole-number field that is not a millisecond offset.
 *
 * Same reasoning as optionalMs: `Number('')` is 0 and `sequence_order: 0`
 * would be rejected by the database as a position, so a blank must become
 * null rather than a number nobody typed.
 */
function optionalInteger(value: unknown): unknown {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value);
  return value;
}

interface AnnotationEventBody {
  annotation_set_id?: string;
  event_id?: string;
  event_class?: unknown;
  actor_track?: unknown;
  opponent_track?: unknown;
  start_ms?: unknown;
  end_ms?: unknown;
  contact_ms?: unknown;
  peak_ms?: unknown;
  physical_hand?: unknown;
  hand_role?: unknown;
  stance?: unknown;
  punch_type?: unknown;
  target_zone?: unknown;
  contact_result?: unknown;
  contact_zone?: unknown;
  defense_type?: unknown;
  visibility?: unknown;
  certainty?: unknown;
  combination_group?: unknown;
  sequence_order?: unknown;
  counter_against_event_id?: unknown;
  defends_against_event_id?: unknown;
}

const asSent = (value: unknown): unknown => value;

/**
 * Every event field on the wire: the module field it becomes, and what a
 * blank means for it. One table for recording and for editing in place, so
 * the two cannot come to read a blank differently. A key not listed here (the
 * event's id, set, clip or organization) is never read from the body as a
 * field.
 */
const EVENT_FIELDS: Record<string, [keyof UpdateAnnotationEventInput, (value: unknown) => unknown]> = {
  event_class: ['eventClass', asSent],
  actor_track: ['actorTrack', asSent],
  opponent_track: ['opponentTrack', blankToNull],
  start_ms: ['startMs', optionalMs],
  end_ms: ['endMs', optionalMs],
  contact_ms: ['contactMs', optionalMs],
  peak_ms: ['peakMs', optionalMs],
  physical_hand: ['physicalHand', blankToNull],
  hand_role: ['handRole', blankToNull],
  stance: ['stance', blankToNull],
  punch_type: ['punchType', blankToNull],
  target_zone: ['targetZone', blankToNull],
  contact_result: ['contactResult', blankToNull],
  contact_zone: ['contactZone', blankToNull],
  defense_type: ['defenseType', blankToNull],
  visibility: ['visibility', asSent],
  certainty: ['certainty', asSent],
  combination_group: ['combinationGroup', blankToNull],
  sequence_order: ['sequenceOrder', optionalInteger],
  counter_against_event_id: ['counterAgainstEventId', blankToNull],
  defends_against_event_id: ['defendsAgainstEventId', blankToNull],
};

/**
 * The wire body, in the shape recordAnnotationEvent takes.
 *
 * THE CAST AT THE END ASSERTS NOTHING. Every field arrives as `unknown` and
 * leaves as `unknown`; the cast exists only because the module's input
 * interface is typed against the ontology's unions, and TypeScript cannot know
 * a runtime string is one of them. recordAnnotationEvent re-checks every
 * single field against the vocabulary arrays and throws `Missing <field>` for
 * anything that is not a member -- so a wrong label is a 400 naming the field,
 * not a stored row. If that ever stops being true, this cast becomes a hole,
 * which is why it is written once, here, and not at five call sites.
 */
function toRecordInput(
  organizationId: string,
  annotationSetId: string,
  eventId: string,
  body: AnnotationEventBody,
): RecordAnnotationEventInput {
  const input: Record<string, unknown> = { organizationId, eventId, annotationSetId };
  for (const [key, [field, normalise]] of Object.entries(EVENT_FIELDS)) {
    input[field] = normalise((body as Record<string, unknown>)[key]);
  }
  return input as unknown as RecordAnnotationEventInput;
}

/** Records one observed punch or defensive action. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const body = (await request.json().catch(() => ({}))) as AnnotationEventBody;
    const annotationSetId = body.annotation_set_id?.trim() ?? '';
    if (!annotationSetId) {
      throw new Error('Missing annotation_set_id');
    }

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);
    // Writing an event means the annotator has just watched the footage. If
    // the video has left 'ready' since they opened the workspace, the write
    // stops with them -- the same re-check the read path makes, in the same
    // place, for the same reason.
    await loadPlayableClip(principal.organizationId, set.calibration_clip_id);

    const event = await recordAnnotationEvent(
      toRecordInput(principal.organizationId, annotationSetId, randomUUID(), body),
    );

    await writeCalibrationAuditEvent({
      eventType: 'create',
      principal,
      entityType: 'calibration_annotation_event',
      entityId: event.event_id,
      // The class and the span, so the audit stream can show that work
      // happened and when. Not the labels: the audit table is not a second,
      // unfrozen copy of an annotation that the freeze trigger does not cover.
      details: {
        annotation_set_id: annotationSetId,
        event_class: event.event_class,
        start_ms: event.start_ms,
        end_ms: event.end_ms,
      },
    });

    return NextResponse.json({ ok: true, event });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Corrects an event the annotator has not yet submitted.
 *
 * REPLACE, NOT UPDATE, AND THE ORDER IS THE POINT. This method is built from
 * the module's record and delete (the in-place edit is PATCH, below), so an
 * edit here is the new row written FIRST and the old one removed second. That
 * order is chosen for its failure direction:
 *
 *   * new-then-old: a rejected correction (bad label, span outside the clip)
 *     leaves the original untouched, and the annotator retries.
 *   * old-then-new: the same rejection has already destroyed the original,
 *     and the annotator's observation is gone.
 *
 * A failure between the two leaves a duplicate, which the annotator can see in
 * their own event list and delete. A duplicate is recoverable; a deletion is
 * not.
 *
 * WHAT AN EDIT COSTS, and the page says so too: the replacement is a new
 * event_id, and pilot_calibration_events_counter_fk / _defends_fk are ON
 * DELETE SET NULL, so any relationship another event pointed AT the edited one
 * is cleared. Re-pointing it would mean writing a relationship the annotator
 * did not re-assert, which is a fabricated observation.
 *
 * AN EVENT THAT HOLDS BODY MARKS IS NOT REPLACED. Its moments, their points
 * and its stance type hang off the old event_id and would go with the old
 * row by cascade. That is refused (409 CALIBRATION_EVENT_HAS_BODY_MARKS)
 * before anything is written, and again if the delete, asking under the row
 * lock, finds marks that landed in between (the replacement is withdrawn).
 * PATCH below corrects such an event in place. Only a body-point set is
 * asked: a set on any other version can hold no marks.
 */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const body = (await request.json().catch(() => ({}))) as AnnotationEventBody;
    const annotationSetId = body.annotation_set_id?.trim() ?? '';
    const replacingEventId = body.event_id?.trim() ?? '';
    if (!annotationSetId) {
      throw new Error('Missing annotation_set_id');
    }
    if (!replacingEventId) {
      throw new Error('Missing event_id');
    }

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);
    await loadPlayableClip(principal.organizationId, set.calibration_clip_id);

    // Checked BEFORE the insert. Without it, an edit naming an event id that
    // is not in this set would write the replacement, fail to delete anything,
    // and leave a duplicate behind for a row the annotator never had.
    const existing = await listAnnotationEvents(principal.organizationId, annotationSetId);
    if (!existing.some((event) => event.event_id === replacingEventId)) {
      throw new Error('Not found: no such event in this annotation set');
    }

    const mayHoldMarks = isInVocabulary(BODY_POINT_ONTOLOGY_VERSIONS, set.ontology_version);
    const holdsMarks = (client?: PoolClient) =>
      eventHoldsBodyMarks(principal.organizationId, annotationSetId, replacingEventId, client);
    const refusal = () => new EventHoldsBodyMarksError(
      'Conflict: this event has body marks, and replacing it would remove them. '
      + 'Edit it in place, or remove its marked moments and stance type first.',
    );
    if (mayHoldMarks && (await holdsMarks())) {
      throw refusal();
    }

    const event = await recordAnnotationEvent(
      toRecordInput(principal.organizationId, annotationSetId, randomUUID(), body),
    );

    // The delete asks again under its row lock, so a mark that landed since
    // the check above keeps the old event. The replacement just written (its
    // id has gone to nobody) is then withdrawn, and the answer is the same
    // refusal: no duplicate is left for the coach to find.
    const removed = await deleteAnnotationEvent(
      principal.organizationId,
      annotationSetId,
      replacingEventId,
      ...(mayHoldMarks ? [{ keepIf: holdsMarks }] : []),
    );
    if (!removed && mayHoldMarks && (await holdsMarks())) {
      await deleteAnnotationEvent(principal.organizationId, annotationSetId, event.event_id);
      throw refusal();
    }

    await writeCalibrationAuditEvent({
      eventType: 'update',
      principal,
      entityType: 'calibration_annotation_event',
      entityId: event.event_id,
      details: {
        action: 'replace',
        annotation_set_id: annotationSetId,
        replaced_event_id: replacingEventId,
        // False means the replacement is stored and the original is still
        // there. Recorded rather than smoothed over, because a duplicate in
        // the data needs to be explicable afterwards.
        replaced_event_removed: removed,
        event_class: event.event_class,
      },
    });

    return NextResponse.json({
      ok: true,
      event,
      replaced_event_id: replacingEventId,
      replaced_event_removed: removed,
    });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Corrects an event IN PLACE: the same event_id, so its body marks (moments,
 * their points, its stance type) and any relationship pointing at it stay.
 *
 * Only the keys sent change; '' or null clears an optional field. The module
 * holds the merged row to every rule a new event is held to, and refuses a
 * change to start, end, contact time, class or actor while the event holds
 * marks (409 CALIBRATION_EVENT_HAS_BODY_MARKS, naming the field). It never
 * falls back to replacing the event.
 *
 * Same gate order as the replace above, footage check included: correcting a
 * label means the annotator was watching.
 */
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    // An id that is not a string, or a body that is not an object, is a 400
    // naming the id, not a crash.
    const body = ((await request.json().catch(() => null)) ?? {}) as AnnotationEventBody;
    const annotationSetId = typeof body.annotation_set_id === 'string' ? body.annotation_set_id.trim() : '';
    const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : '';
    if (!annotationSetId) {
      throw new Error('Missing annotation_set_id');
    }
    if (!eventId) {
      throw new Error('Missing event_id');
    }

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);
    await loadPlayableClip(principal.organizationId, set.calibration_clip_id);

    const sent = Object.keys(EVENT_FIELDS).filter((key) => key in body);
    if (sent.length === 0) {
      throw new Error('Missing fields: send at least one event field to change');
    }
    const changes: Record<string, unknown> = {};
    for (const key of sent) {
      const [field, normalise] = EVENT_FIELDS[key];
      changes[field] = normalise((body as Record<string, unknown>)[key]);
    }

    // The cast asserts nothing, as in toRecordInput: the module re-checks the
    // merged row field by field.
    const event = await updateAnnotationEvent({
      ...changes,
      organizationId: principal.organizationId,
      annotationSetId,
      eventId,
    } as unknown as UpdateAnnotationEventInput);

    await writeCalibrationAuditEvent({
      eventType: 'update',
      principal,
      entityType: 'calibration_annotation_event',
      entityId: event.event_id,
      // Which fields, never their values: see the note on POST's audit row.
      details: { action: 'edit_in_place', annotation_set_id: annotationSetId, fields: sent },
    });

    return NextResponse.json({ ok: true, event });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Removes an event from a set that is still in progress.
 *
 * NO CLIPPABILITY CHECK HERE, and that asymmetry is deliberate. Recording and
 * replacing require the annotator to have been watching, so both re-assert
 * that the footage is still available. Deleting requires nothing of the
 * footage -- it takes an observation OUT of the corpus -- and gating it on the
 * video would mean that a clip quarantined mid-study traps whatever an
 * annotator had already entered, with no way to withdraw it. Refusals should
 * never point in the direction of "you may not remove your own unsubmitted
 * work".
 */
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const body = (await request.json().catch(() => ({}))) as AnnotationEventBody;
    const annotationSetId = body.annotation_set_id?.trim() ?? '';
    const eventId = body.event_id?.trim() ?? '';
    if (!annotationSetId) {
      throw new Error('Missing annotation_set_id');
    }
    if (!eventId) {
      throw new Error('Missing event_id');
    }

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);

    const removed = await deleteAnnotationEvent(
      principal.organizationId,
      annotationSetId,
      eventId,
    );
    if (!removed) {
      throw new Error('Not found: no such event in this annotation set');
    }

    await writeCalibrationAuditEvent({
      // 'update' on the EVENT, not a 'delete' event type: the audit vocabulary
      // is closed by a TS array and a database CHECK, and widening it needs a
      // migration this change is not making.
      eventType: 'update',
      principal,
      entityType: 'calibration_annotation_event',
      entityId: eventId,
      details: { action: 'delete', annotation_set_id: annotationSetId },
    });

    return NextResponse.json({ ok: true, event_id: eventId });
  } catch (error) {
    return jsonError(error);
  }
}
