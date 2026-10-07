import { NextResponse, type NextRequest } from 'next/server';

import {
  deleteBodyPoint,
  markBodyPoints,
  type MarkBodyPointsInput,
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
 * WHERE THE COACH PUT EACH POINT at one moment -- marked, or unmarked.
 *
 * Same refusal order as the moments route. The point list, the states and the
 * [0, 1] range are the module's and the database's; a wire number is passed
 * as it arrived (a string is refused by name there, never parsed into a
 * position nobody tapped).
 */

interface PointsBody {
  annotation_set_id?: string;
  body_moment_id?: string;
  point_code?: unknown;
  points?: unknown;
}

interface WirePoint {
  point_code?: unknown;
  state?: unknown;
  x_norm?: unknown;
  y_norm?: unknown;
}

async function readBody(request: NextRequest): Promise<{ body: PointsBody; annotationSetId: string; bodyMomentId: string }> {
  const body = (await request.json().catch(() => ({}))) as PointsBody;
  const annotationSetId = body.annotation_set_id?.trim() ?? '';
  if (!annotationSetId) {
    throw new Error('Missing annotation_set_id');
  }
  const bodyMomentId = body.body_moment_id?.trim() ?? '';
  if (!bodyMomentId) {
    throw new Error('Missing body_moment_id');
  }
  return { body, annotationSetId, bodyMomentId };
}

/** Marks one or more points at a moment; each writes over its earlier mark. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);
    const { body, annotationSetId, bodyMomentId } = await readBody(request);
    if (!Array.isArray(body.points)) {
      throw new Error('Missing points: expected a list of points');
    }

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);
    await loadPlayableClip(principal.organizationId, set.calibration_clip_id);

    const points = await markBodyPoints({
      organizationId: principal.organizationId,
      annotationSetId,
      bodyMomentId,
      points: (body.points as WirePoint[]).map((point) => ({
        pointCode: point?.point_code,
        state: point?.state,
        xNorm: point?.x_norm,
        yNorm: point?.y_norm,
      })),
    } as unknown as MarkBodyPointsInput);

    await writeCalibrationAuditEvent({
      eventType: 'update',
      principal,
      entityType: 'calibration_body_point',
      entityId: bodyMomentId,
      // Counts only. Never a coordinate or a state: the audit table is not an
      // unfrozen copy of a mark.
      details: {
        action: 'mark',
        annotation_set_id: annotationSetId,
        marked: body.points.length,
        on_moment: points.length,
      },
    });

    return NextResponse.json({ ok: true, points });
  } catch (error) {
    return jsonError(error);
  }
}

/** Removes one point's mark so it can be marked afresh. */
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);
    const { body, annotationSetId, bodyMomentId } = await readBody(request);
    const pointCode = typeof body.point_code === 'string' ? body.point_code.trim() : '';
    if (!pointCode) {
      throw new Error('Missing point_code');
    }

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);

    const removed = await deleteBodyPoint(principal.organizationId, annotationSetId, bodyMomentId, pointCode);
    if (!removed) {
      throw new Error('Not found: no such point on this body moment');
    }

    await writeCalibrationAuditEvent({
      eventType: 'update',
      principal,
      entityType: 'calibration_body_point',
      entityId: bodyMomentId,
      details: { action: 'unmark', annotation_set_id: annotationSetId, point_code: pointCode },
    });

    return NextResponse.json({ ok: true, body_moment_id: bodyMomentId, point_code: pointCode });
  } catch (error) {
    return jsonError(error);
  }
}
