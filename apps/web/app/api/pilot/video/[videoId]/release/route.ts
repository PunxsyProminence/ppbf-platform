import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { queryOne } from '@/src/server/pilot/db';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

interface VideoSessionRow {
  video_session_id: string;
  status: string;
  scan_state: string;
  athlete_id: string | null;
  uploaded_by_account_id: string;
}

// The two verdicts that hand the decision to a person. 'needs_human_review' is
// the scanner saying it could not be sure; 'unconfigured' is an environment
// with no gate to ask. Everything else the scanner reaches, it owns.
const HUMAN_RELEASABLE_SCAN_STATES = new Set(['needs_human_review', 'unconfigured']);

/**
 * Releases an uploaded video for playback.
 *
 * Uploads are born 'quarantined'. The scan sweep promotes what it can clear on
 * its own; this route is the human attestation for the footage it cannot --
 * the coach who filmed the session saying it is what it claims to be.
 *
 * The only transition available here is quarantined -> ready, and only from a
 * scan_state that defers to a person. A definite machine refusal is never
 * reversible from this route: 'blocked' is the content screen declining
 * footage of a minor, 'infected' is malware, and 'error' is a verdict about
 * the file itself. A video already 'ready' has nothing left to release.
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
      `select video_session_id, status, scan_state, athlete_id, uploaded_by_account_id
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

    // A person resolves what the scan could not; a person never overturns what
    // it refused. 'blocked' is the content screen declining footage of a minor,
    // and a coach who filmed it is the last person who should be able to
    // reverse that. 'pending' and 'scanning' are not refusals -- they are a
    // verdict that has not arrived, and releasing ahead of it would make the
    // gate optional for anyone willing to click first.
    if (!HUMAN_RELEASABLE_SCAN_STATES.has(row.scan_state)) {
      return NextResponse.json(
        {
          error: row.scan_state === 'blocked'
            ? 'The content screen refused this video. It cannot be released here; ask an administrator to review it.'
            : 'This video is still waiting on its content scan. It can be released by hand only if the scan cannot reach a verdict.',
          scan_state: row.scan_state,
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
         and scan_state = any($3::text[])
       returning status`,
      [videoId, principal.organizationId, [...HUMAN_RELEASABLE_SCAN_STATES]],
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
