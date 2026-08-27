import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import {
  listAnnotationEvents,
  openAnnotationSet,
} from '@/src/server/pilot/calibration/annotations';
import { BOXING_ONTOLOGY_VERSION } from '@/src/server/pilot/calibration/ontology';
import { getCalibrationProject } from '@/src/server/pilot/calibration/projects';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import {
  findOwnAnnotationSetForClip,
  loadPlayableClip,
  requireAnnotator,
  writeCalibrationAuditEvent,
} from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * ONE ANNOTATOR'S WORKSPACE ON ONE CLIP.
 *
 * GET assembles everything the player needs and nothing it does not: the clip
 * (bounds, sampling reason, and the video id the caller then opens through the
 * ordinary protected video route), the caller's OWN set if they have opened
 * one, and that set's events.
 *
 * WHAT IS ABSENT, DELIBERATELY. Any trace of the other annotator. Not their
 * set, not their event count, not a flag saying they have started. This
 * response is the whole of what the annotator screen knows, so a field added
 * here is a field that can be read off the wire -- and the entire value of the
 * study rests on neither annotator being able to see the other's unsubmitted
 * work. The cross-annotator view exists (listAnnotationSetsForClip) and is for
 * adjudication, behind a gate that is not this slice's to build.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const { searchParams } = new URL(request.url);
    const clipId = searchParams.get('calibration_clip_id')?.trim() ?? '';
    if (!clipId) {
      throw new Error('Missing calibration_clip_id');
    }

    // Re-checked on every read, never cached from clip selection: a video that
    // has left 'ready' since the workspace was opened must stop being
    // annotatable immediately, including on a refresh of a tab that has been
    // sitting open.
    const clip = await loadPlayableClip(principal.organizationId, clipId);
    const project = await getCalibrationProject(
      principal.organizationId,
      clip.calibration_project_id,
    );

    const set = await findOwnAnnotationSetForClip(principal, clipId);
    const events = set
      ? await listAnnotationEvents(principal.organizationId, set.annotation_set_id)
      : [];

    return NextResponse.json({
      ok: true,
      supported_ontology_version: BOXING_ONTOLOGY_VERSION,
      project,
      clip,
      set,
      events,
    }, {
      // The response carries no media and no SAS, but it does say which video
      // id a study clip points at. Kept out of shared caches for the same
      // reason the video read route keeps its own body out of them.
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Opens the caller's pass over one clip, or hands back the one they already
 * have.
 *
 * IDEMPOTENT ON PURPOSE. pilot_calibration_sets_one_per_annotator_uq makes a
 * second set for the same annotator and clip impossible at the database level,
 * which is right -- one annotator, one clip, one set is the unit of
 * measurement. But a coach who reopens the page and presses "Start" again has
 * not asked for a second set, and letting the unique violation reach them as
 * an opaque 500 would look like the platform losing their work. So an existing
 * set is returned as-is, including a SUBMITTED one: a submitted set is not an
 * error, it is a finished pass, and the page renders it read-only.
 *
 * There is no un-submit here and there must never be one. A genuine
 * re-annotation is a new set by a different annotator; un-submitting would
 * destroy the only evidence that a pass was completed independently.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const body = (await request.json().catch(() => ({}))) as { calibration_clip_id?: string };
    const clipId = body.calibration_clip_id?.trim() ?? '';
    if (!clipId) {
      throw new Error('Missing calibration_clip_id');
    }

    const clip = await loadPlayableClip(principal.organizationId, clipId);

    const existing = await findOwnAnnotationSetForClip(principal, clipId);
    if (existing) {
      // No audit row: nothing changed. An audit stream that records "opened a
      // set" once per page load cannot be read for when a set was actually
      // created.
      return NextResponse.json({ ok: true, created: false, set: existing });
    }

    const project = await getCalibrationProject(
      principal.organizationId,
      clip.calibration_project_id,
    );
    if (!project) {
      throw new Error('Not found: no such calibration project in this organization');
    }

    /* THE VOCABULARY THIS BUILD CAN ACTUALLY VALIDATE.
     *
     * The set is stamped with the PROJECT's ontology version, because a set
     * must carry the vocabulary it was created under -- that stamp is what
     * stops a March study under 0.1 and a July study under 0.2 being pooled by
     * accident.
     *
     * And that is exactly why a project under any other version is refused
     * here rather than annotated. The forms on the annotator page are built
     * from this build's arrays, and recordAnnotationEvent validates against
     * the same ones. Opening a 0.2 project would put 0.1's dropdowns in front
     * of a coach and store their answers under a 0.2 stamp -- data labelled
     * with a vocabulary that never produced it, which is worse than refusing.
     * The refusal is a code change (a new build implements the new version),
     * never a migration.
     */
    if (project.ontology_version !== BOXING_ONTOLOGY_VERSION) {
      throw new Error(
        `Forbidden: this project is stamped ${project.ontology_version} and this build `
        + `implements ${BOXING_ONTOLOGY_VERSION}, so it cannot annotate it`,
      );
    }

    const set = await openAnnotationSet({
      organizationId: principal.organizationId,
      annotationSetId: randomUUID(),
      calibrationClipId: clip.calibration_clip_id,
      annotatorAccountId: principal.accountId,
      ontologyVersion: project.ontology_version,
    });

    await writeCalibrationAuditEvent({
      eventType: 'create',
      principal,
      entityType: 'calibration_annotation_set',
      entityId: set.annotation_set_id,
      // The clip id and the vocabulary, and nothing about the athlete or the
      // footage. An audit row is not a second copy of the record.
      details: {
        calibration_clip_id: set.calibration_clip_id,
        ontology_version: set.ontology_version,
      },
    });

    return NextResponse.json({ ok: true, created: true, set });
  } catch (error) {
    return jsonError(error);
  }
}
