import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { ConflictError } from '@/src/server/pilot/errors';
import {
  assertGuardianMediaConsent,
  assertGuardianMediaConsentWithClient,
  assertNotAdultForNewPublication,
  GuardianConsentMissingError,
  type QueryExecutor,
} from '@/src/server/pilot/guardianConsent';
import { getPublicationForPublish, publishToResearchLibrary } from '@/src/server/pilot/publication';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';
import { assertVideoHasNoLiveClipTags } from '@/src/server/pilot/videoClipTags';
import { assertConsentCoversVideo } from '@/src/server/pilot/videoPlaybackConsent';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

export const runtime = 'nodejs';

// assertConsentCoversVideo's refusals: withdrawn, photo-only, unreadable.
const COVERAGE_REFUSAL_CODES = new Set([
  'GUARDIAN_CONSENT_WITHDRAWN',
  'GUARDIAN_CONSENT_EXCLUDES_VIDEO',
  'GUARDIAN_CONSENT_UNREADABLE',
]);

// The publish claim's own read of the video row, on the claim's client. Same
// predicate the executor and the playback gate hold: only a 'ready' Film
// Study video is ever handed out. FOR SHARE, so an archive or re-quarantine
// (a bare UPDATE on the row) waits for the claim rather than landing between
// this read and the claim's commit. Lock order: guardian links are already
// held, and every other path takes links before the video row.
async function assertVideoStillPublishable(
  client: QueryExecutor,
  organizationId: string,
  videoSessionId: string,
): Promise<void> {
  const result = await client.query<{ status: string; capture_take_id: string | null }>(
    `select status, capture_take_id from pilot.video_sessions
      where organization_id = $1 and video_session_id = $2
      for share`,
    [organizationId, videoSessionId],
  );
  const video = result.rows[0];
  if (!video || video.status !== 'ready' || video.capture_take_id !== null) {
    throw new ConflictError(
      "This video is no longer released for viewing, so it can't be published. Check its status in Video Analysis.",
      'VIDEO_NOT_PUBLISHABLE',
    );
  }
}

// A lost audit row is a gap an operator can close by re-dispatching, not a
// reason to tell the coach their (already-committed) publish failed -- same
// doctrine as the compliance console's auditComplianceEvent and the submit
// route's auditSubmitEvent.
async function auditPublishEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'publication-publish-audit-write-failed',
      action: event.details && typeof event.details === 'object' ? (event.details as { action?: unknown }).action : undefined,
      ...(code ? { code } : {}),
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'coach']);

    // Only the two identifiers are read from the request. Title, description
    // and tags come from the publication row, so what lands on the library
    // shelf is what the compliance check was recorded against.
    const body = (await request.json().catch(() => null)) as
      | { publication_id?: unknown; video_session_id?: unknown }
      | null;
    const publicationId = typeof body?.publication_id === 'string' ? body.publication_id.trim() : '';
    const videoSessionId = typeof body?.video_session_id === 'string' ? body.video_session_id.trim() : '';

    if (!publicationId || !videoSessionId) {
      throw new Error('Missing required fields');
    }

    const publication = await getPublicationForPublish(principal.organizationId, publicationId);

    // No publication of that id in the caller's organization. Indistinguishable
    // from "does not exist" on purpose: the response must not confirm that
    // another gym holds this publication_id.
    if (!publication) {
      return hiddenNotFound();
    }

    // Every refusal below names its reason. A coach who cannot publish has to
    // be able to see whether the block is ownership, clearance, or a mismatched
    // video -- the three are fixed in completely different ways.
    if (!isOrganizationAdminRole(principal.role) && publication.submitted_by_account_id !== principal.accountId) {
      return NextResponse.json(
        { error: 'Only the coach who submitted this publication, or an organization admin, can publish it.' },
        { status: 403 },
      );
    }

    if (publication.video_session_id !== videoSessionId) {
      return NextResponse.json(
        { error: 'That video session does not belong to this publication.' },
        { status: 409 },
      );
    }

    if (publication.status !== 'approved' || publication.compliance_check_status !== 'passed') {
      return NextResponse.json(
        {
          error: 'This publication is not cleared for the research library yet. An organization admin has to record a passing compliance check first.',
          status: publication.status,
          compliance_check_status: publication.compliance_check_status,
        },
        { status: 409 },
      );
    }

    // The consent checks below read the one athlete this publication names, so
    // footage attributed to nobody -- team footage -- or whose attribution
    // cannot be read cannot reach the shelf (audit CL-B4). Create refuses it
    // now; this stops a row drafted or cleared before it did.
    const videoSession = await getVideoSessionById(principal.organizationId, publication.video_session_id);
    if (!videoSession?.athlete_id) {
      throw new ConflictError("This video isn't linked to an athlete, so it can't be published. Link it to an athlete in Video Analysis first.", 'VIDEO_NOT_ATTRIBUTED');
    }
    // Create has refused a video attributed to another athlete since f8729bf4
    // (2026-07-31); a row drafted before then can name one child on another
    // child's video, and every consent check reads the child it names.
    if (videoSession.athlete_id !== publication.athlete_id) {
      throw new ConflictError("This video is linked to a different athlete than the one this publication names, so it can't be published. Create a new publication for the athlete on the video instead.", 'VIDEO_ATHLETE_MISMATCH');
    }

    let libraryId: string | null;
    try {
      // Approval already checked guardian consent, but a guardian may
      // withdraw between approval and this publish -- and publishing is the
      // act that puts a minor's footage on a shelf other people can reach.
      // Same two-layer shape as the console's approval: a cheap pre-check
      // that fails fast, then the SAME check re-run inside the claim's own
      // transaction (verifyBeforeCommit), so a withdrawal cannot commit in
      // the gap between the pre-check returning and the claim landing.
      //
      // A publication is always video, so "signed" is not enough: the
      // consent must also cover video (assertConsentCoversVideo, the same
      // gate playback uses). It runs first so a withdrawn or photo-only
      // guardian is refused with that reason rather than as missing
      // paperwork; assertGuardianMediaConsent still refuses absence.
      // An adult's footage is not published on a guardian's consent
      // (OD-2026-10-08-015). Checked first: no guardian paperwork can cure
      // it, so it is the reason to give. Again inside the claim below.
      await assertNotAdultForNewPublication(principal.organizationId, publication.athlete_id);
      await assertConsentCoversVideo(principal.organizationId, publication.athlete_id);
      await assertGuardianMediaConsent(principal.organizationId, publication.athlete_id);

      libraryId = await publishToResearchLibrary({
        organizationId: principal.organizationId,
        publicationId: publication.publication_id,
        videoSessionId: publication.video_session_id,
        title: publication.title,
        description: publication.description,
        tags: publication.tags,
        verifyBeforeCommit: async (client) => {
          // Both reads lock this athlete's guardian links FOR SHARE through
          // guardianConsent.ts's helper, in its order. They are two reads, so
          // the coverage check goes SECOND: a guardian linked between them
          // is then read by the check that refuses photo-only and withdrawn,
          // rather than only by the signed-or-not check that cannot tell
          // photo-only from video (review finding on this change).
          await assertGuardianMediaConsentWithClient(client, principal.organizationId, publication.athlete_id);
          await assertConsentCoversVideo(principal.organizationId, publication.athlete_id, client);
          await assertNotAdultForNewPublication(principal.organizationId, publication.athlete_id, client);
          // Inside the claim: a clip tag added after the draft was made still
          // stops the publish (tagged clips are staff only, owner 2026-10-03).
          await assertVideoHasNoLiveClipTags(principal.organizationId, publication.video_session_id, client);
          // And the video itself is still what was approved (audit CL-B10):
          // released ('ready'), and Film Study media rather than teaching
          // footage. A video archived or sent back to quarantine after
          // approval used to reach the shelf as metadata anyway.
          await assertVideoStillPublishable(client, principal.organizationId, publication.video_session_id);
        },
      });
    } catch (error) {
      // A blocked publish attempt is itself a safeguarding-relevant fact --
      // who tried to put unconsented footage of this child on the shelf, and
      // when -- the same way the console logs blocked approvals.
      if (error instanceof GuardianConsentMissingError) {
        await auditPublishEvent({
          event_type: 'update',
          actor_account_id: principal.accountId,
          actor_role: principal.role,
          organization_id: principal.organizationId,
          entity_type: 'video_publication',
          entity_id: publication.publication_id,
          details: {
            action: 'publication_publish_blocked_by_consent',
            missing_parent_ids: error.missingParentIds,
            athlete_is_adult: error.athleteIsAdult,
          },
          shadow_mirror: false,
        });
      } else if (error instanceof ConflictError && error.code && COVERAGE_REFUSAL_CODES.has(error.code)) {
        await auditPublishEvent({
          event_type: 'update',
          actor_account_id: principal.accountId,
          actor_role: principal.role,
          organization_id: principal.organizationId,
          entity_type: 'video_publication',
          entity_id: publication.publication_id,
          details: {
            action: 'publication_publish_blocked_by_consent',
            reason: error.code,
          },
          shadow_mirror: false,
        });
      }
      throw error;
    }

    // The claim re-checks clearance inside its transaction, so this is a
    // publication whose state moved between the read above and the write.
    if (!libraryId) {
      return NextResponse.json(
        { error: 'This publication changed while it was being published. Reload and try again.' },
        { status: 409 },
      );
    }

    // Publishing puts a minor's training footage on a shelf other people can
    // reach, which makes it the most consequential act in this workflow and the
    // one most likely to be asked about later. It carries the same attribution
    // the release step does.
    await auditPublishEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'video_publication',
      entity_id: publication.publication_id,
      details: {
        action: 'publication_publish',
        library_id: libraryId,
        video_session_id: publication.video_session_id,
        submitted_by_account_id: publication.submitted_by_account_id,
        compliance_check_status: publication.compliance_check_status,
      },
    });

    return NextResponse.json({ ok: true, library_id: libraryId });
  } catch (error) {
    return jsonError(error);
  }
}
