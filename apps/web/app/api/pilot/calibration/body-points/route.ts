import { NextResponse, type NextRequest } from 'next/server';

import {
  listBodyDataForSet,
  listMissingBodyData,
} from '@/src/server/pilot/calibration/bodyPoints';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import { loadOwnAnnotationSet, requireAnnotator } from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * EVERYTHING ONE ANNOTATOR HAS MARKED ON ONE OF THEIR OWN SETS, and what the
 * submission check would still ask for.
 *
 * Refuses in the order every route in this directory does: the caller is an
 * annotator; the set is THEIRS (another annotator's set is reported as absent,
 * never as forbidden). No clippability check on a read of marks already made:
 * the marks are not the footage, and a submitted set stays readable so the
 * page can show it read-only.
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
