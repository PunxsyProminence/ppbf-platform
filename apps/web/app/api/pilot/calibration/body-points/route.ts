import { NextResponse, type NextRequest } from 'next/server';

import {
  listBodyDataForSet,
  listMissingBodyData,
} from '@/src/server/pilot/calibration/bodyPoints';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import { loadOwnAnnotationSet, loadPlayableClip, requireAnnotator } from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * EVERYTHING ONE ANNOTATOR HAS MARKED ON ONE OF THEIR OWN SETS, and what the
 * submission check would still ask for.
 *
 * Refuses in the order every route in this directory does: the caller is an
 * annotator; the set is THEIRS (another annotator's set is reported as absent,
 * never as forbidden); the footage behind the set may still be watched
 * (loadPlayableClip, re-checked on EVERY read as annotatorGate.ts requires:
 * the marks are where a person's body was on footage the platform may since
 * have withdrawn, and the workspace GET refuses on the same condition). A
 * submitted set is readable, which is how the page shows it read-only.
 *
 * The writes live under body-points/moments, body-points/points and
 * body-points/stance; this file only reads.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const { searchParams } = new URL(request.url);
    const annotationSetId = searchParams.get('annotation_set_id')?.trim() ?? '';
    if (!annotationSetId) {
      throw new Error('Missing annotation_set_id');
    }

    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    await loadPlayableClip(principal.organizationId, set.calibration_clip_id);
    const data = await listBodyDataForSet(principal.organizationId, set.annotation_set_id);
    const missing = await listMissingBodyData(principal.organizationId, set.annotation_set_id);

    return NextResponse.json(
      {
        ok: true,
        set,
        expected_points: data.expected_points,
        moments: data.moments,
        stance_labels: data.stance_labels,
        missing,
      },
      // One annotator's unsubmitted marks: never in a shared cache.
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
