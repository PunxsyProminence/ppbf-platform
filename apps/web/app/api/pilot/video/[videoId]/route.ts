import { NextResponse, type NextRequest } from 'next/server';

import {
  accessibleAthleteIds,
  assertActorCanAccessAthlete,
  assertAthleteBelongsToOrganization,
  isOrganizationAdminRole,
} from '@/src/server/pilot/access';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { queryOne } from '@/src/server/pilot/db';
import { ConflictError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { listLiveTagSubjects } from '@/src/server/pilot/videoClipTags';
import { assertConsentCoversVideo } from '@/src/server/pilot/videoPlaybackConsent';

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
  /** Null for Film Study and for anything uploaded before grouping existed.
   *  Non-null means the footage was recorded to teach Shadow. */
  capture_take_id: string | null;
}


export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    const { videoId } = await params;

    const row = await queryOne<VideoSessionRow>(
      `select video_session_id, organization_id, title, notes, file_name, file_size_bytes, mime_type, status, athlete_id, blob_path, uploaded_by_account_id, created_at, capture_take_id
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
    /*
     * ORDINARY PLAYBACK IS A FILM STUDY SURFACE. Once held teaching footage
     * can be released, it reaches 'ready' and this route would mint it a
     * playback SAS like any other video -- reopening on the single-video read
     * exactly what separating the list read closed.
     *
     * Teach Shadow's own review goes through /api/pilot/video/review-link,
     * which is the path built for quarantined footage and is unaffected.
     *
     * hiddenNotFound, not a named refusal, because this route answers every
     * "does not exist" and "exists but forbidden" case identically on purpose;
     * saying "that is teaching footage" here would be the disclosure oracle
     * the rest of the function is written to avoid.
     */
    if (row.capture_take_id !== null) {
      return hiddenNotFound();
    }

    /*
     * TAGGED CLIPS (sparring and bout film; videoClipTags.ts). Owner
     * decisions, Jason 2026-10-03: staff only; a coach may watch when ANY
     * athlete in the clip is theirs; and EVERY athlete in the clip must clear
     * the consent gate, so one guardian's refusal blocks the clip for all.
     * Checked before the single-athlete branch below, which would otherwise
     * show a sparring clip to the one child it names, partner included.
     */
    const tagged = await listLiveTagSubjects(principal.organizationId, row.video_session_id);
    if (tagged.length > 0) {
      const isAdmin = isOrganizationAdminRole(principal.role);
      if (!isAdmin && principal.role !== 'coach') {
        return hiddenNotFound();
      }
      // A deleted athlete's footage reads as not found (deletedAthletes.ts),
      // and this clip is that athlete's footage too.
      if (tagged.some((subject) => subject.athlete_deleted)) {
        return hiddenNotFound();
      }
      // The video's own athlete too: the single-athlete branch below refuses
      // a deleted one through assertActorCanAccessAthlete, and tagging a
      // second athlete must not bring that footage back.
      if (row.athlete_id) {
        try {
          await assertAthleteBelongsToOrganization(principal.organizationId, row.athlete_id);
        } catch {
          return hiddenNotFound();
        }
      }
      const subjects = [
        ...(row.athlete_id ? [row.athlete_id] : []),
        ...tagged.map((subject) => subject.athlete_id),
      ];
      if (!isAdmin) {
        const mine = await accessibleAthleteIds(principal, subjects);
        if (mine.size === 0) {
          return hiddenNotFound();
        }
      }
      try {
        for (const athleteId of new Set(subjects)) {
          await assertConsentCoversVideo(principal.organizationId, athleteId);
        }
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new ConflictError(
            `This clip shows more than one athlete, and it is blocked for everyone while any of them is. ${error.message}`,
            error.code,
          );
        }
        throw error;
      }
    } else if (row.athlete_id) {
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
