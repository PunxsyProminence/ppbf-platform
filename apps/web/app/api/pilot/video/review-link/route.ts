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
import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
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
    const url = await mintUnderPlaybackConsent(
      principal.organizationId,
      video.athlete_id ? [video.athlete_id] : [],
      () => getPilotVideoSasUrl(video.blob_path, LINK_EXPIRY_MINUTES),
    );

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
