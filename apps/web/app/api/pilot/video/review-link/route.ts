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
// unscanned or screen-refused videos of youth athletes, and who watched what
// has to be answerable afterwards.
//
// Both reviewing roles get this. #149 gave the coach a Release button with no
// way to look at what they were releasing; this is that missing half, and it
// is why the view role set is wider than the decide one.
import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
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
    const url = getPilotVideoSasUrl(video.blob_path, LINK_EXPIRY_MINUTES);

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
    // reason (profile/README.md Gate 4).
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
