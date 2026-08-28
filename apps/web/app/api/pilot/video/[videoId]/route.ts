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
 * Two conditions, and both are a decision a guardian actually made:
 *
 *   1. status='signed' AND covers_video=false -- a guardian who used the
 *      parent console and deliberately unticked video. parent/consent's grant
 *      path reads `body.covers_video !== false`, so photo-only is an
 *      affirmative act, never a default. The column itself defaults to true
 *      and every intake-written row takes that default, so this can only ever
 *      fire on a choice somebody actually made.
 *   2. status='withdrawn' -- a guardian who granted media consent and then
 *      took it back. Owner decision 2026-08-28: withdrawal stops internal
 *      playback, not only publication. Before that decision this route served
 *      a withdrawn athlete's footage normally, and route.test.ts carried a
 *      test saying so in as many words, with the note that it was the one to
 *      change if the decision was ever taken. It was taken; that test now
 *      asserts the refusal.
 *
 * Those two are the WHOLE gate-visible status population, not a subset of it.
 * currentConsentByGuardian filters `parent_id is not null`, and the only two
 * writers of a row with parent_id set are grantMediaConsent ('signed') and
 * withdrawMediaConsent ('withdrawn') in guardianConsent.ts -- both reached
 * only from POST /api/pilot/parent/consent. 'declined' is a status the schema
 * and waiverCompliance.ts both admit, but no writer can put it on a row this
 * gate can see, so it is not handled here rather than being handled
 * speculatively. If an admin-side writer that passes parentId is ever added,
 * this gate needs revisiting for that status -- checked 2026-08-28 across
 * every upsertWaiver caller in apps/web.
 *
 * WHO THE REFUSAL APPLIES TO: everyone, the athlete and the guardian
 * included. That is not new reach invented for withdrawal -- the photo-only
 * refusal above has always applied to all three (route.test.ts has carried
 * 'the athlete themself is subject to the same scope refusal' and 'the linked
 * guardian is subject to the same scope refusal' since it shipped), and a
 * withdrawal that stopped coaches but not the athlete's own console would
 * leave the footage one login away from the person whose guardian just said
 * no. The escape hatch is the same one the photo-only case has: a new signed
 * consent, written by the guardian's own console, supersedes it immediately.
 *
 * WHAT WITHDRAWAL STILL CANNOT REACH, stated whole rather than in the
 * comfortable half of it (review finding, PR #820):
 *
 *   1. A SAS URL ALREADY MINTED. This route hands out a 60-minute bearer
 *      credential, so an already-open tab keeps playing for up to an hour
 *      after the withdrawal commits. Closing that means short-lived SAS plus
 *      re-mint, or server-side proxying.
 *   2. A REQUEST ARRIVING IN THE SAME INSTANT. The consent read below is an
 *      ordinary SELECT and nothing serializes it against the withdrawal, so a
 *      withdrawal committing between that read and the mint still yields a
 *      fresh credential. getPilotVideoSasUrl is synchronous (blob.ts:123-125)
 *      and there is no round trip between the two, so the window is a few
 *      statements rather than request-scale -- and it is contained by (1)
 *      rather than separate from it, since even a perfectly serialized read
 *      only establishes "no withdrawal as of now" for a credential that
 *      outlives now by an hour.
 *
 * SERIALIZING IT IS A WRITE-PATH CHANGE, not one available here, and that is
 * why this route does not simply open a transaction. The withdrawal takes no
 * lock: POST /api/pilot/parent/consent calls withdrawMediaConsent, a bare
 * upsertWaiver insert that commits on its own, and the guardian_links
 * `for update` lock appears only afterwards in the separate suppression
 * sweep. So a `for share` here -- the pattern
 * assertGuardianMediaConsentWithClient uses -- would order this route against
 * the SWEEP and not against the INSERT that actually revokes consent. It
 * would look like a fix and serialize the wrong pair. The real fix is for
 * withdrawMediaConsent to take that row lock before its insert; once it does,
 * this read and the mint can hold `for share` across both and the window
 * closes.
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

  // Withdrawal is checked first, and the two refusals stay separate rather
  // than being folded into one "not signed for video" test, because they are
  // different facts about a guardian and the reader has to act on them
  // differently: a photo-only guardian consented and drew a line, a withdrawn
  // guardian revoked. Merging them would hand an admin one message covering
  // two situations, one of which ("ask them to consent to video") is the wrong
  // thing to say to a parent who has already said no -- the same distinction
  // competitionSafetyGates.ts's travelWaiverRefusal draws for the same reason.
  //
  // A withdrawn row also carries covers_video=false (withdrawMediaConsent
  // writes it that way), so the ordering is not cosmetic in the one-guardian
  // case; the status==='signed' test below keeps the two populations disjoint
  // regardless, and the ordering decides which message a MIXED set of
  // guardians produces. Withdrawal wins because it is the stronger statement.
  const withdrawn = consent.perGuardian.filter((guardian) => guardian.status === 'withdrawn');

  if (withdrawn.length > 0) {
    throw new ConflictError(
      `Blocked: ${withdrawn.length} of this athlete's guardians has withdrawn media consent. `
      + 'Video of this athlete cannot be played back while a withdrawal stands. That is a decision '
      + 'on file, not missing paperwork -- only a newly signed consent from that guardian restores '
      + 'playback.',
      'GUARDIAN_CONSENT_WITHDRAWN',
    );
  }

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
