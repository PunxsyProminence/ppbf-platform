import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { queryOne } from '@/src/server/pilot/db';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  getVideoReleasePolicy,
  releasableScanStates,
} from '@/src/server/pilot/videoReleasePolicy';

export const runtime = 'nodejs';

interface VideoSessionRow {
  video_session_id: string;
  status: string;
  scan_state: string;
  athlete_id: string | null;
  uploaded_by_account_id: string;
}

// Which scan states a coach may release from is now the organization's
// decision rather than a constant here -- see videoReleasePolicy.ts. The
// strict default is unchanged and applies to any organization that has not
// recorded one, so this widens nothing on its own.
//
// What no policy setting reaches: 'infected', 'blocked' and 'error'. A malware
// verdict and a content-screen refusal are machine findings about footage of a
// minor, and neither is a dial.

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

    // A person never overturns what the scan REFUSED, at any policy setting:
    // 'blocked' is the content screen declining footage of a minor, and the
    // coach who filmed it is the last person who should reverse that.
    //
    // What a person may resolve depends on the organization. Under the strict
    // default only a deferred verdict is releasable, because releasing ahead
    // of a scan that is genuinely coming would make the gate optional for
    // whoever clicks first. Under 'coach_attested' the uploading coach may
    // also release while the verdict is still in flight -- an organization
    // whose coaches are all screened, reviewing its own footage the evening it
    // was filmed, and accepting that trade knowingly.
    const policy = await getVideoReleasePolicy(principal.organizationId);
    const releasable = releasableScanStates(policy);

    if (!releasable.includes(row.scan_state)) {
      return NextResponse.json(
        {
          error: row.scan_state === 'blocked'
            ? 'The content screen refused this video. It cannot be released here; ask an administrator to review it.'
            : 'This video is still waiting on its content scan. It can be released by hand only if the scan cannot reach a verdict.',
          scan_state: row.scan_state,
          release_policy: policy,
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
      [videoId, principal.organizationId, releasable],
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
        // Both recorded so a release under the loosened policy is
        // distinguishable afterwards from one the scanner had deferred.
        release_policy: policy,
        from_scan_state: row.scan_state,
        uploaded_by_account_id: row.uploaded_by_account_id,
        athlete_id: row.athlete_id,
      },
    });

    return NextResponse.json({ ok: true, video_session_id: videoId, status: released.status });
  } catch (error) {
    return jsonError(error);
  }
}
