import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, isOrganizationAdminRole } from '@/src/server/pilot/access';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { queryOne } from '@/src/server/pilot/db';
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
