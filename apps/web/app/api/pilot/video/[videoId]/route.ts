import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, isOrganizationAdminRole } from '@/src/server/pilot/access';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { queryOne } from '@/src/server/pilot/db';
import { ConflictError } from '@/src/server/pilot/errors';
import { checkGuardianMediaConsent } from '@/src/server/pilot/guardianConsent';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

interface VideoSessionRow {
  video_session_id: string;
  organization_id: string;
  title: string;
  notes: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  status: string;
  athlete_id: string | null;
  blob_path: string;
  uploaded_by_account_id: string;
  created_at: string;
}

/**
 * GUARDIAN CONSENT ON THE WAY *IN*, NOT ONLY ON THE WAY OUT.
 *
 * assertGuardianMediaConsent already guards every path that sends a minor's
 * media OUT -- publications/publish, admin/video-compliance,
 * shadow/video-analysis, videoScanSweep. Nothing consulted consent on the way
 * in, and this route is the read surface where that gap has teeth: it mints a
 * 60-minute SAS, which the note further down correctly calls a bearer
 * credential -- a string that fetches a minor's footage after it has left the
 * platform's authorization boundary entirely.
 *
 * WHAT THIS REFUSES, AND WHY IT IS ONLY THIS
 *
 * Exactly one condition: a guardian whose CURRENT photo_media waiver is
 * status='signed' AND covers_video=false. That is a guardian who used the
 * parent console and deliberately unticked video -- parent/consent's grant
 * path reads `body.covers_video !== false`, so photo-only is an affirmative
 * act, never a default. The column itself defaults to true and every
 * intake-written row takes that default, so this can only ever fire on a
 * choice somebody actually made.
 *
 * WHAT THIS DELIBERATELY DOES NOT REFUSE: A MISSING CONSENT ROW.
 *
 * That is the whole reason this is shaped as a scope check rather than as a
 * call to assertGuardianMediaConsent. Missing consent is not a rare edge on
 * this platform, it is THE DEFAULT STATE OF THE ROSTER. The only writer of a
 * row this gate can see is POST /api/pilot/parent/consent (requireRole
 * ['parent']): it is the sole caller that passes parentId to upsertWaiver, and
 * currentConsentByGuardian filters `parent_id is not null`. scripts/seed-data.ts,
 * which bulk-imports athletes and guardian_links, writes no waiver row at all;
 * both intake writers (intake/domain-upsert, intake/review-action) call
 * upsertWaiver without parentId, so even an admin recording "photo and media --
 * signed" through app/admin/consent lands a row with parent_id NULL that this
 * gate cannot see. A roster-imported athlete therefore reads as "consent
 * missing" until every one of their guardians has personally signed in and
 * granted, and no admin-side path exists to record it for them.
 *
 * Refusing on absence would have taken every coach's footage away on the day
 * it shipped -- and taken it from the athlete's own view and their guardian's
 * too, which inverts what consent is for. It protects the subject from
 * third-party use; it is not a lock the subject applies to themself.
 *
 * public_use_allowed is not consulted here for the opposite reason -- not
 * because it is unenforceable, but because this surface is precisely the use
 * it permits. The migration defines it as "true: may be used publicly (site,
 * social, print). false: internal/gym-only", so `false` ALLOWS an assigned
 * coach opening footage inside the platform. That flag's unenforced half lives
 * on the publication path, not on this one.
 *
 * FAILURE DIRECTION ON A FAULT: this deliberately does not catch. A database
 * error propagates to jsonError and becomes a 500, exactly as
 * waiverCompliance.ts argues for its own consent lookup -- degrading it would
 * mean "we could not find out whether a guardian consented, so proceed", which
 * is the one direction a consent read must never fail in. It is for that same
 * reason NOT one of the 42P01 degrade-to-safe cases in access.ts and
 * trainingHolds.ts: those degrade toward LESS access (no coverage, no hold);
 * degrading this one would grant more.
 *
 * The refusal is a specific 409 rather than this route's usual
 * hiddenNotFound(), and that does not break the 403-vs-404 discipline above:
 * it runs only AFTER assertActorCanAccessAthlete, so it reaches only someone
 * already entitled to know the video exists -- the ordering rule
 * videoScanReview.ts states for its own state refusals. 409 matches
 * GuardianConsentMissingError's existing mapping in http.ts: a precondition on
 * a different resource than the one addressed.
 */
async function assertConsentCoversVideo(organizationId: string, athleteId: string): Promise<void> {
  const consent = await checkGuardianMediaConsent(organizationId, athleteId);
  const videoExcluded = consent.perGuardian.filter(
    (guardian) => guardian.status === 'signed' && guardian.coversVideo === false,
  );

  if (videoExcluded.length > 0) {
    throw new ConflictError(
      `Blocked: ${videoExcluded.length} of this athlete's guardians signed a photo-only media consent `
      + 'that does not cover video. Video of this athlete cannot be played back until that guardian '
      + 'consents to video.',
      'GUARDIAN_CONSENT_EXCLUDES_VIDEO',
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    const { videoId } = await params;

    const row = await queryOne<VideoSessionRow>(
      `select video_session_id, organization_id, title, notes, file_name, file_size_bytes, mime_type, status, athlete_id, blob_path, uploaded_by_account_id, created_at
       from pilot.video_sessions
       where video_session_id = $1 and organization_id = $2`,
      [videoId, principal.organizationId],
    );

    // Every "doesn't exist" and "exists but forbidden" case below returns the
    // exact same hiddenNotFound() response so a caller can't distinguish the
    // two (see issue #8's 403-vs-404 disclosure requirement).
    if (!row) {
      return hiddenNotFound();
    }
    if (row.status !== 'ready') {
      return hiddenNotFound();
    }

    if (row.athlete_id) {
      try {
        await assertActorCanAccessAthlete(principal, row.athlete_id);
      } catch {
        return hiddenNotFound();
      }
      // Consent scope is checked only for attributed footage: an unattributed
      // team-wide clip has no athlete_id, so there is no guardian to ask.
      await assertConsentCoversVideo(principal.organizationId, row.athlete_id);
    } else if (!isOrganizationAdminRole(principal.role) && principal.role !== 'coach') {
      // Unattributed (team-wide) video: only coaches and org admins may view
      // it individually. Athletes, parents, volunteers, and staff cannot.
      return hiddenNotFound();
    }

    const sasUrl = getPilotVideoSasUrl(row.blob_path, 60);

    // A SAS URL is a bearer credential, not a reference: whoever holds the
    // string can fetch a minor's footage for the whole validity window, with no
    // session and no idea who is holding it. So the response that carries one
    // must not be storable by the browser or by any intermediary -- the same
    // reasoning the portrait routes apply (docs/capabilities/GATES.md §5), and
    // the same header value they use.
    return NextResponse.json({
      ...row,
      blob_path: undefined,
      stream_url: sasUrl,
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
  } catch (error) {
    return jsonError(error);
  }
}
