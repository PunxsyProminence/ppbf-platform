import { NextResponse, type NextRequest } from 'next/server';

import {
  listAnnotationEvents,
  submitAnnotationSet,
} from '@/src/server/pilot/calibration/annotations';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import {
  assertSetInProgress,
  loadOwnAnnotationSet,
  requireAnnotator,
  writeCalibrationAuditEvent,
} from '../../annotatorGate';

export const runtime = 'nodejs';

/**
 * THE ONE-WAY DOOR.
 *
 * Submission is the only irreversible act on this surface. After it the set
 * and its events are frozen by a database trigger: no insert, no update, no
 * delete, and no un-submit anywhere in the platform. That freeze is what makes
 * "two annotators labelled this independently" a property of the system rather
 * than a claim about intent -- if a pass could be revised after seeing the
 * other one, every agreement figure computed downstream would be worthless.
 *
 * It gets its own route rather than a PATCH on the set for exactly that
 * reason: the act that cannot be undone should not be reachable by varying a
 * field on a request that does something else.
 *
 * WHAT IS NOT CHECKED HERE, deliberately: how many events the set contains. An
 * empty submitted set is a real observation -- "I watched these six seconds
 * and saw no punch and no defensive action" -- and refusing to submit it would
 * teach annotators to invent an event to get past the gate, which is the
 * single worst thing that could happen to this dataset. Absence of annotation
 * is not absence of event, and this route is not allowed to imply otherwise;
 * the count is returned so the page can ASK the annotator to confirm an empty
 * pass, which is a prompt, not a refusal.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const body = (await request.json().catch(() => ({}))) as { annotation_set_id?: string };
    const annotationSetId = body.annotation_set_id?.trim() ?? '';
    if (!annotationSetId) {
      throw new Error('Missing annotation_set_id');
    }

    // Ownership first: submitting is an assertion about whose reading this is,
    // and one annotator must never be able to close another's pass -- which
    // would freeze work its author never called finished.
    const set = await loadOwnAnnotationSet(principal, annotationSetId);
    assertSetInProgress(set);

    const submitted = await submitAnnotationSet(principal.organizationId, annotationSetId);
    if (!submitted) {
      // submitAnnotationSet is scoped to status='in_progress' in its WHERE, so
      // null here means the set was submitted between the check above and this
      // update -- a double-click, or two tabs. It is not an error the
      // annotator can act on and it must not re-stamp submitted_at, so it
      // reports the same refusal a submitted set gets.
      throw new Error(
        'Forbidden: this annotation set has been submitted and can no longer be changed',
      );
    }

    const events = await listAnnotationEvents(principal.organizationId, annotationSetId);

    await writeCalibrationAuditEvent({
      // 'update', not a new 'submit' event type. The audit vocabulary is
      // closed by both a TS array and a database CHECK; the entity_type and
      // the action below carry the meaning without a migration.
      eventType: 'update',
      principal,
      entityType: 'calibration_annotation_set',
      entityId: annotationSetId,
      details: {
        action: 'submit',
        calibration_clip_id: submitted.calibration_clip_id,
        event_count: events.length,
      },
    });

    return NextResponse.json({ ok: true, set: submitted, event_count: events.length });
  } catch (error) {
    return jsonError(error);
  }
}
