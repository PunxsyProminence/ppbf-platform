// GET /api/pilot/teach-shadow/footage/[videoId]/stream — watch released
// teaching footage, so it can be cut into clips and the clips can be labelled.
//
// THE GAP THIS CLOSES, STATED PLAINLY BECAUSE IT SHIPPED TO PRODUCTION.
//
// Two rules landed a day apart and contradicted each other:
//
//   2026-09-24  assertVideoClippable began REQUIRING a capture take: only
//               footage recorded to teach Shadow may become a study clip.
//   2026-09-25  GET /api/pilot/video/[videoId] began REFUSING a capture take:
//               teaching footage is not Film Study media and must not be
//               played through the Film Study route.
//
// Each is right. Together they meant every clip that could legally exist had
// a source video the only playback route 404'd -- and the annotation page
// fetches exactly that route. The labelling screen could not play anything it
// was allowed to show, and the calibration lab could not be used at all.
//
// The refusal's comment said Teach Shadow review "goes through
// /api/pilot/video/review-link and is unaffected". That was wrong:
// authorizeVideoScanReview refuses anything not 'quarantined', so released
// teaching footage had no playback path anywhere in the platform.
//
// A SEPARATE ROUTE RATHER THAN AN EXCEPTION IN THE FILM STUDY ONE. Teaching
// the Film Study route to sometimes serve teaching footage is how the
// separation gets lost -- it is the same mistake the held queue avoided by
// taking its own route instead of becoming a mode of /api/pilot/video/list.
// Film Study's route stays Film-Study-only and keeps its flat refusal. This is
// teaching's own door, with teaching's own gate.
//
// THE GATE IS assertVideoClippable, AND THAT IS THE POINT. It is the exact
// question this route needs answered -- may this footage be used for teaching
// work right now -- and it is already the gate on every clip read and write.
// Using the same call means a video that stops being clippable (archived,
// re-quarantined, blocked) stops being watchable here in the same instant,
// with no second opinion to drift out of step.
//
// WHAT IT DOES NOT CARRY OVER FROM THE FILM STUDY ROUTE, and why:
//
//   assertActorCanAccessAthlete -- teaching media names nobody. TS-ANON-01
//   made athlete_id NULL on every take-backed row, so there is no athlete to
//   check against and calling it would be theatre.
//
//   The guardian video-consent scope check -- same reason. That check reads a
//   consent row for a named athlete; there is no name here.
//
// This is not a loosening: it is the consequence of the owner's ruling that
// teaching footage names nobody. Consent for teaching use is recorded as its
// own waiver_type and is a question about the CORPUS, not about a playback
// click. See the capture-participants migration for the long version.
import { NextResponse, type NextRequest } from 'next/server';

import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { assertVideoClippable } from '@/src/server/pilot/calibration/projects';
import { queryOne } from '@/src/server/pilot/db';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

import { requireAnnotator } from '../../../../calibration/annotatorGate';

export const runtime = 'nodejs';

// Matches the Film Study route's window. A shorter one would expire mid-clip
// for an annotator working through a long take; the annotation page already
// warns at five minutes to go and can ask for a fresh link.
const SAS_EXPIRY_MINUTES = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    requireAnnotator(principal);
    const { videoId } = await params;

    /*
     * THE GATE FIRST, THE BLOB PATH SECOND. assertVideoClippable throws
     * VideoNotClippableError for a video that is missing, not this
     * organization's, not 'ready', or not teaching footage -- every refusal
     * this route needs, decided by the module that owns the question.
     *
     * Its refusals name the status ("video is not available for calibration
     * (status archived)"), which is more than this route should disclose to a
     * caller who may not be entitled to know the video exists at all. So the
     * error is caught and answered as hiddenNotFound, the same flat 404 the
     * Film Study route gives for every one of its refusals.
     */
    try {
      await assertVideoClippable(principal.organizationId, videoId);
    } catch {
      return hiddenNotFound();
    }

    /*
     * Read separately rather than widening assertVideoClippable's return. It
     * is called from six places that want a decision, not a blob path, and
     * handing a storage location to callers that never asked for one is how a
     * credential ends up somewhere nobody meant it to be.
     */
    const row = await queryOne<{ blob_path: string; file_name: string }>(
      `select blob_path, file_name from pilot.video_sessions
        where organization_id = $1 and video_session_id = $2`,
      [principal.organizationId, videoId],
    );

    if (!row) {
      // assertVideoClippable already proved the row exists, so reaching here
      // means it was deleted between the two reads. Refused rather than
      // treated as impossible.
      return hiddenNotFound();
    }

    const streamUrl = getPilotVideoSasUrl(row.blob_path, SAS_EXPIRY_MINUTES);

    /*
     * A SAS URL IS A BEARER CREDENTIAL, not a reference: whoever holds the
     * string can fetch the footage for the whole window, with no session and
     * no record of who held it. So the response carrying one must not be
     * stored by the browser or by anything on the way back. Same header, and
     * the same reason, as the Film Study route and the portrait routes.
     */
    return NextResponse.json({
      ok: true,
      video_session_id: videoId,
      file_name: row.file_name,
      stream_url: streamUrl,
      expires_in_minutes: SAS_EXPIRY_MINUTES,
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
  } catch (error) {
    return jsonError(error);
  }
}
