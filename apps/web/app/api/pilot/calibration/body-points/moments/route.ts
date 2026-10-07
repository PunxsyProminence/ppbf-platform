import { NextResponse, type NextRequest } from 'next/server';

import {
  deleteBodyMoment,
  openBodyMoment,
  updateBodyMoment,
  type OpenBodyMomentInput,
  type UpdateBodyMomentInput,
} from '@/src/server/pilot/calibration/bodyPoints';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import {
  assertSetInProgress,
  blankToNull,
  loadOwnAnnotationSet,
  loadPlayableClip,
  optionalMs,
  requireAnnotator,
  writeCalibrationAuditEvent,
} from '../../annotatorGate';

export const runtime = 'nodejs';

/**
 * ONE OF THE THREE MOMENTS OF ONE EVENT -- opened, relabelled, removed.
 *
 * Same refusal order as events/route.ts: annotator role; the set is THEIRS
 * (another's is reported absent); the set is in_progress; on the writes that
 * mean the coach was watching, the footage is still clippable. The version
 * gate (a 0.1 set has no body points) is the module's and the database's; this
 * file passes its refusal through as the 403 it already is.
 *
 * NO TIMING IS DECIDED HERE. The client never says when "start" is: the
 * module derives every moment's time from the event, and the only time a
 * client may send is the coach's pick for a middle with no contact. Nothing is
 * validated here either; a wire blank becomes null ("not recorded"), never a
 * vocabulary value, and the module names any field it refuses.
 */

interface MomentBody {
  annotation_set_id?: string;
  body_moment_id?: string;
  event_id?: unknown;
  moment_slot?: unknown;
  observation_ms?: unknown;
  lead_side?: unknown;
  guard_type?: unknown;
  source_frame_width_px?: unknown;
  source_frame_height_px?: unknown;
}

/** A whole-number pixel count over the wire, or null: the same rule as a
 * millisecond field (digits-only string -> number, blank -> null, anything
 * else left for the module to refuse by name), so optionalMs serves. */
const optionalPixels = optionalMs;

/** A wire id: a trimmed string, or '' for anything that is not one. */
function wireId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function readBody(request: NextRequest): Promise<{ body: MomentBody; annotationSetId: string }> {
  const body = ((await request.json().catch(() => null)) ?? {}) as MomentBody;
  const annotationSetId = wireId(body.annotation_set_id);
  if (!annotationSetId) {
    throw new Error('Missing annotation_set_id');
  }
  return { body, annotationSetId };
}

/** Opens a moment on one of the annotator's own events. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);
    const { body, annotationSetId } = await readBody(request);

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);
    await loadPlayableClip(principal.organizationId, set.calibration_clip_id);

    // The cast asserts nothing (see events/route.ts toRecordInput): the module
    // re-checks every field and refuses by name. The moment's id is the
    // module's to mint.
    const moment = await openBodyMoment({
      organizationId: principal.organizationId,
      annotationSetId,
      eventId: body.event_id,
      momentSlot: body.moment_slot,
      observationMs: optionalMs(body.observation_ms),
      leadSide: blankToNull(body.lead_side),
      guardType: blankToNull(body.guard_type),
      sourceFrameWidthPx: optionalPixels(body.source_frame_width_px),
      sourceFrameHeightPx: optionalPixels(body.source_frame_height_px),
    } as unknown as OpenBodyMomentInput);

    await writeCalibrationAuditEvent({
      eventType: 'create',
      principal,
      entityType: 'calibration_body_moment',
      entityId: moment.body_moment_id,
      // Which event and slot, so the stream shows work happened. Not the lead
      // side or guard: the audit table is not an unfrozen copy of a label.
      details: {
        annotation_set_id: annotationSetId,
        event_id: moment.event_id,
        moment_slot: moment.moment_slot,
      },
    });

    return NextResponse.json({ ok: true, moment });
  } catch (error) {
    return jsonError(error);
  }
}

/** Changes what was recorded at a moment. A field left out stays as it is. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);
    const { body, annotationSetId } = await readBody(request);
    const bodyMomentId = wireId(body.body_moment_id);
    if (!bodyMomentId) {
      throw new Error('Missing body_moment_id');
    }

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);
    await loadPlayableClip(principal.organizationId, set.calibration_clip_id);

    // Only the keys the client sent reach the module, so a partial PUT cannot
    // wipe the other fields. For lead_side, guard_type and the picture size
    // '' or null clears; for observation_ms a blank is "no time", which the
    // module refuses on a free middle (it needs one) and on any other moment
    // (it has one). No key at all is a 400, not a no-op write.
    if ('event_id' in body || 'moment_slot' in body) {
      throw new Error("Unsupported moment_slot: a moment's event and slot are fixed; delete it and open another");
    }
    const changes: Record<string, unknown> = {};
    if ('observation_ms' in body) changes.observationMs = optionalMs(body.observation_ms);
    if ('lead_side' in body) changes.leadSide = blankToNull(body.lead_side);
    if ('guard_type' in body) changes.guardType = blankToNull(body.guard_type);
    if ('source_frame_width_px' in body) changes.sourceFrameWidthPx = optionalPixels(body.source_frame_width_px);
    if ('source_frame_height_px' in body) changes.sourceFrameHeightPx = optionalPixels(body.source_frame_height_px);
    if (Object.keys(changes).length === 0) {
      throw new Error('Missing fields: send at least one of observation_ms, lead_side, guard_type, source_frame_width_px, source_frame_height_px');
    }

    const moment = await updateBodyMoment({
      organizationId: principal.organizationId,
      annotationSetId,
      bodyMomentId,
      ...changes,
    } as unknown as UpdateBodyMomentInput);

    await writeCalibrationAuditEvent({
      eventType: 'update',
      principal,
      entityType: 'calibration_body_moment',
      entityId: moment.body_moment_id,
      details: {
        annotation_set_id: annotationSetId,
        event_id: moment.event_id,
        moment_slot: moment.moment_slot,
        fields: Object.keys(changes),
      },
    });

    return NextResponse.json({ ok: true, moment });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Removes a moment and its points. No clippability check, as events/route.ts
 * DELETE explains: withdrawing one's own unsubmitted work never depends on
 * the footage.
 */
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);
    const { body, annotationSetId } = await readBody(request);
    const bodyMomentId = wireId(body.body_moment_id);
    if (!bodyMomentId) {
      throw new Error('Missing body_moment_id');
    }

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);

    const removed = await deleteBodyMoment(principal.organizationId, annotationSetId, bodyMomentId);
    if (!removed) {
      throw new Error('Not found: no such body moment in this annotation set');
    }

    await writeCalibrationAuditEvent({
      eventType: 'update',
      principal,
      entityType: 'calibration_body_moment',
      entityId: bodyMomentId,
      details: { action: 'delete', annotation_set_id: annotationSetId },
    });

    return NextResponse.json({ ok: true, body_moment_id: bodyMomentId });
  } catch (error) {
    return jsonError(error);
  }
}
