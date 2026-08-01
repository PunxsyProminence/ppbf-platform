import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { queryOne } from '@/src/server/pilot/db';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

interface VideoSessionRow {
  video_session_id: string;
  status: string;
  athlete_id: string | null;
  uploaded_by_account_id: string;
}

/**
 * Releases an uploaded video for playback.
 *
 * Uploads are born 'quarantined' and no automated scanner exists, so the
 * release is the human attestation that closes that state: the coach who
 * filmed the session says the footage is what it claims to be. The only
 * transition available here is quarantined -> ready. 'infected' and 'error'
 * are verdicts about the file itself and are never overridden by a person,
 * and a video that is already 'ready' has nothing left to release.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    const { videoId } = await params;

    const row = await queryOne<VideoSessionRow>(
      `select video_session_id, status, athlete_id, uploaded_by_account_id
       from pilot.video_sessions
       where video_session_id = $1 and organization_id = $2`,
      [videoId, principal.organizationId],
    );

    // A video in another organization and a video this coach did not upload
    // both return the same response as one that does not exist. The sibling
    // read route holds the same line: a coach whose video list does not
    // include a session must not learn it exists by trying to release it.
    if (!row) {
      return hiddenNotFound();
    }
    if (!isOrganizationAdminRole(principal.role) && row.uploaded_by_account_id !== principal.accountId) {
      return hiddenNotFound();
    }

    if (row.status !== 'quarantined') {
      return NextResponse.json(
        {
          error: row.status === 'ready'
            ? 'This video has already been released.'
            : `A video held in "${row.status}" cannot be released.`,
          status: row.status,
        },
        { status: 409 },
      );
    }

    // The state predicate is repeated on the write so a video that left
    // quarantine between the read and the write is never dragged back to
    // 'ready', and so two simultaneous releases produce one audit record.
    const released = await queryOne<{ status: string }>(
      `update pilot.video_sessions
       set status = 'ready', updated_at = now()
       where video_session_id = $1 and organization_id = $2 and status = 'quarantined'
       returning status`,
      [videoId, principal.organizationId],
    );

    if (!released) {
      return NextResponse.json(
        { error: 'This video changed state before it could be released. Reload and try again.' },
        { status: 409 },
      );
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'video_session',
      entity_id: videoId,
      details: {
        action: 'video_release',
        from_status: 'quarantined',
        to_status: 'ready',
        uploaded_by_account_id: row.uploaded_by_account_id,
        athlete_id: row.athlete_id,
      },
    });

    return NextResponse.json({ ok: true, video_session_id: videoId, status: released.status });
  } catch (error) {
    return jsonError(error);
  }
}
