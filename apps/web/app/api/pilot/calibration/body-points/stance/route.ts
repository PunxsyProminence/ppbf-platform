import { NextResponse, type NextRequest } from 'next/server';

import {
  clearEventStanceType,
  setEventStanceType,
  type SetEventStanceTypeInput,
} from '@/src/server/pilot/calibration/bodyPoints';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import {
  assertSetInProgress,
  loadOwnAnnotationSet,
  loadPlayableClip,
  requireAnnotator,
  writeCalibrationAuditEvent,
} from '../../annotatorGate';

export const runtime = 'nodejs';

/**
 * THE NAMED STANCE OF ONE EVENT, once per punch or defence
 * (OD-2026-10-02-014) -- set or changed, or cleared.
 *
 * Same refusal order as the moments route. The stance list is the module's
 * and the database's.
 */

interface StanceBody {
  annotation_set_id?: string;
  event_id?: string;
  stance_type?: unknown;
}

async function readBody(request: NextRequest): Promise<{ body: StanceBody; annotationSetId: string; eventId: string }> {
  const body = (await request.json().catch(() => ({}))) as StanceBody;
  const annotationSetId = body.annotation_set_id?.trim() ?? '';
  if (!annotationSetId) {
    throw new Error('Missing annotation_set_id');
  }
  const eventId = body.event_id?.trim() ?? '';
  if (!eventId) {
    throw new Error('Missing event_id');
  }
  return { body, annotationSetId, eventId };
}

export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);
    const { body, annotationSetId, eventId } = await readBody(request);

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);
    await loadPlayableClip(principal.organizationId, set.calibration_clip_id);

    const label = await setEventStanceType({
      organizationId: principal.organizationId,
      annotationSetId,
      eventId,
      stanceType: body.stance_type,
    } as unknown as SetEventStanceTypeInput);

    await writeCalibrationAuditEvent({
      eventType: 'update',
      principal,
      entityType: 'calibration_event_stance_label',
      entityId: eventId,
      // Which event, not which stance.
      details: { action: 'set', annotation_set_id: annotationSetId },
    });

    return NextResponse.json({ ok: true, stance_label: label });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);
    const { annotationSetId, eventId } = await readBody(request);

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);

    const removed = await clearEventStanceType(principal.organizationId, annotationSetId, eventId);
    if (!removed) {
      throw new Error('Not found: no stance type on this event');
    }

    await writeCalibrationAuditEvent({
      eventType: 'update',
      principal,
      entityType: 'calibration_event_stance_label',
      entityId: eventId,
      details: { action: 'clear', annotation_set_id: annotationSetId },
    });

    return NextResponse.json({ ok: true, event_id: eventId });
  } catch (error) {
    return jsonError(error);
  }
}
