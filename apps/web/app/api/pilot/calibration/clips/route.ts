import { NextResponse, type NextRequest } from 'next/server';

import {
  assertVideoClippable,
  listCalibrationClips,
  type CalibrationClipRow,
} from '@/src/server/pilot/calibration/projects';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

import { requireAnnotator } from '../annotatorGate';

export const runtime = 'nodejs';

/**
 * The clips cut for one calibration project.
 *
 * WHAT `playable` IS, AND WHAT IT IS NOT. It is the answer
 * assertVideoClippable gives right now for that clip's source video -- the
 * same call the annotation routes make, not a second opinion about it. It is a
 * HINT for the picker so a clip whose footage has since been quarantined,
 * blocked or archived reads as unavailable instead of taking the annotator
 * into a workspace that will refuse them.
 *
 * It authorizes nothing. Playback still goes through
 * GET /api/pilot/video/[videoId], which re-checks status, runs
 * assertActorCanAccessAthlete and applies the guardian video-consent scope
 * check -- none of which is consulted here. A true `playable` therefore means
 * "the study's own gate is satisfied", never "you may watch this": a coach not
 * assigned to the athlete sees `playable: true` and is still refused the
 * stream, which is the safe direction for a hint to be wrong in.
 *
 * The clip's own status is NOT disclosed -- a boolean, never
 * VideoNotClippableError's `videoStatus`. Whether a particular video is
 * quarantined is a safeguarding fact about a scan, and this is a list an
 * annotator loads to pick their next six seconds of work.
 */
interface CalibrationClipListItem extends CalibrationClipRow {
  playable: boolean;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('calibration_project_id')?.trim() ?? '';
    if (!projectId) {
      throw new Error('Missing calibration_project_id');
    }

    const clips = await listCalibrationClips(principal.organizationId, projectId);

    const items: CalibrationClipListItem[] = await Promise.all(
      clips.map(async (clip) => {
        try {
          await assertVideoClippable(principal.organizationId, clip.video_session_id);
          return { ...clip, playable: true };
        } catch {
          // Swallowed on purpose and ONLY here. The catch turns "this clip's
          // footage is not available" into a greyed-out row; every route that
          // actually serves or writes against a clip lets the same error
          // propagate so the annotator is told why. A catch on a write path
          // would be this hint quietly becoming a bypass.
          return { ...clip, playable: false };
        }
      }),
    );

    return NextResponse.json({ ok: true, clips: items });
  } catch (error) {
    return jsonError(error);
  }
}
