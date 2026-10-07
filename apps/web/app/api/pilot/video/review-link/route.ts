// POST /api/pilot/video/review-link — short-lived read link for one
// quarantined video, so the reviewer can watch what they are attesting about.
//
// The seeing half of scan-review, and the reason that route can mean anything.
// /api/pilot/video/[videoId] returns hiddenNotFound() for anything that is not
// 'ready', and the coach page disables Play for the same reason -- correct for
// the normal read path, but it left a reviewer unable to see the one thing
// they were being asked to judge. A review that cannot see the video is a
// rubber stamp, exactly as intake/document-link says about documents.
//
// Same 15-minute expiry and same audit posture as document-link: these are
// unscanned or screen-refused videos of youth athletes, so who was ISSUED a
// link to what has to be answerable afterwards. That is the limit of what the
// audit row proves. The browser fetches the footage straight from storage, so
// this platform never sees the read and must not claim it knows who watched.
//
// Both reviewing roles get this. #149 gave the coach a Release button with no
// way to look at what they were releasing; this is that missing half, and it
// is why the view role set is wider than the decide one.
//
// THE GUARDIAN-CONSENT GATE APPLIES HERE TOO (CL-A21).
//
// This route used to skip it on purpose: every clip it serves is quarantined,
// and the argument was that a safeguarding reviewer LOOKING at flagged footage
// is not media USE. Jason ruled otherwise on 2026-10-06 ("No one watches it"):
// a guardian's photo-only, withdrawn or unreadable media consent refuses the
// review link as well, the same assertConsentCoversVideo gate that playback,
// publication and the automated scan already use (OD-2026-10-05-016/-021/
// -022: photo-only means no video use at all).
//
// What that leaves: the footage stays quarantined and unplayable, which is
// where consent says it belongs. Release and approve are closed too, because
// both require a current review link. An organization admin can still Block
// it without viewing; Block marks scan_state 'blocked' and the footage stays
// quarantined -- it is not deleted.
//
// CHECK AND MINT IN ONE TRANSACTION, through mintUnderPlaybackConsent -- the
// same call the playback route makes -- so a withdrawal in flight is waited
// for and read as withdrawn, never missed by a check that ran a moment before
// the link was minted.
//
// The check runs AFTER authorizeVideoScanReview, so its specific 409 reaches
// only someone already entitled to know the video exists. Teaching footage
// (athlete_id null) names nobody and has no guardian to ask.
//
// EVERY CHILD THE CLIP SHOWS, NOT ONLY THE ONE IT IS FILED UNDER. A sparring
// clip is tagged to the athletes in it (videoClipTags.ts; owner, Jason
// 2026-10-03: any tagged athlete's consent block blocks the whole clip, for
// everyone). Playback and the scan sweep ask the clip's own athlete AND every
// live tag subject; this route asked only the first, so a reviewer could
// watch a clip showing a tagged child whose guardian had withdrawn. Same
// subject set as GET /api/pilot/video/[videoId] now, and a tag naming a
// deleted athlete reads as not found, as it does there.
//
// AND A COACH MUST REACH AT LEAST ONE OF THEM. authorizeVideoScanReview
// entitles a non-admin on being the uploader and reaching the clip's OWN
// athlete; it cannot see the tags. A coach who uploaded untagged team footage
// that another coach then tagged with a child the uploader does not coach was
// entitled on the upload alone, and the consent 409 below would have told
// them that child's guardian's decision. Playback's rule for a tagged clip
// (video/[videoId]/route.ts, accessibleAthleteIds: the coach reaches at least
// one athlete in it) is applied here too, before any consent is asked, with
// the same refusal every other not-entitled caller gets.
import { NextResponse, type NextRequest } from 'next/server';

import { accessibleAthleteIds, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { ConflictError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listLiveTagSubjects } from '@/src/server/pilot/videoClipTags';
import { mintUnderPlaybackConsent } from '@/src/server/pilot/videoPlaybackConsent';
import {
  authorizeVideoScanReview,
  VideoScanReviewRefused,
  VIDEO_REVIEW_VIEW_ROLES,
} from '@/src/server/pilot/videoScanReview';

export const runtime = 'nodejs';

const LINK_EXPIRY_MINUTES = 15;

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...VIDEO_REVIEW_VIEW_ROLES]);

    const body = await request.json().catch(() => ({}));
    const videoSessionId = typeof body.video_session_id === 'string' ? body.video_session_id.trim() : '';
    if (!videoSessionId) {
      throw new Error('Missing video_session_id');
    }

    const video = await authorizeVideoScanReview(principal, videoSessionId);

    // Read after the entitlement check, so a tag's not-found never confirms
    // a video exists to someone the check already refused.
    const tagged = await listLiveTagSubjects(principal.organizationId, videoSessionId);
    if (tagged.some((subject) => subject.athlete_deleted)) {
      throw new VideoScanReviewRefused('VIDEO_SESSION_NOT_FOUND', 'Not found', 404);
    }
    const consentSubjects = [...new Set([
      ...(video.athlete_id ? [video.athlete_id] : []),
      ...tagged.map((subject) => subject.athlete_id),
    ])];

    // A coach acts on a tagged clip only if they reach at least one athlete
    // in it -- playback's rule, decided here before the consent gate so an
    // out-of-reach caller gets the entitlement refusal and never the 409 that
    // would tell them about a child they cannot see. Same 404 as
    // authorizeVideoScanReview. An organization admin reaches every athlete
    // in the organization and is not asked, as on playback. An untagged clip
    // was fully decided by authorizeVideoScanReview and is not asked either.
    if (tagged.length > 0 && !isOrganizationAdminRole(principal.role)) {
      const reach = await accessibleAthleteIds(principal, consentSubjects);
      if (reach.size === 0) {
        throw new VideoScanReviewRefused('VIDEO_SESSION_NOT_FOUND', 'Not found', 404);
      }
    }

    let url: string;
    try {
      url = await mintUnderPlaybackConsent(
        principal.organizationId,
        consentSubjects,
        () => getPilotVideoSasUrl(video.blob_path, LINK_EXPIRY_MINUTES),
      );
    } catch (error) {
      // The gate's message says "this athlete's guardians" and names nobody.
      // On a tagged clip it may be a partner's guardian who refused -- a
      // child this coach may not reach -- so the refusal is reworded to say
      // the whole clip is blocked while ANY athlete in it is, without saying
      // which. Same wording as playback.
      if (tagged.length > 0 && error instanceof ConflictError) {
        throw new ConflictError(
          `This clip shows more than one athlete, and it is blocked for everyone while any of them is. ${error.message}`,
          error.code,
        );
      }
      throw error;
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'video_session',
      entity_id: videoSessionId,
      details: {
        action: 'video_review_link_issued',
        athlete_id: video.athlete_id,
        file_name: video.file_name,
        scan_state: video.scan_state,
        expires_in_minutes: LINK_EXPIRY_MINUTES,
      },
      shadow_mirror: false,
    });

    // The SAS URL below is a bearer credential: for the next 15 minutes anyone
    // holding the string can watch a minor's quarantined footage, without a
    // session and without appearing in this route's audit trail. A cached copy
    // -- in the browser or in any shared cache on the way back -- hands that
    // credential to a second holder nobody recorded, so the response carrying
    // it must not be stored. Same header the portrait routes use for the same
    // reason (docs/capabilities/GATES.md §5).
    return NextResponse.json({
      ok: true,
      video_session_id: videoSessionId,
      title: video.title,
      file_name: video.file_name,
      scan_state: video.scan_state,
      // What the machine concluded, so the reviewer knows what they are being
      // asked to override rather than judging blind.
      scan_detail: video.scan_detail,
      url,
      expires_in_minutes: LINK_EXPIRY_MINUTES,
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
  } catch (error) {
    if (error instanceof VideoScanReviewRefused) {
      return NextResponse.json({ error: error.message, reason: error.reason }, { status: error.status });
    }
    return jsonError(error);
  }
}
