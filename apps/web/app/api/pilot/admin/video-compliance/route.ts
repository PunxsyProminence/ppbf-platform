import { NextResponse, type NextRequest } from 'next/server';

import { getAthleteById } from '@/src/server/pilot/entities';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { hiddenNotFound, jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  getOrganizationPublications,
  getPublicationForPublish,
  recordComplianceCheck,
  updatePublicationStatus,
} from '@/src/server/pilot/publication';
import { getSubjectIdentity } from '@/src/server/pilot/profileDb';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

export const runtime = 'nodejs';

/**
 * T-006: THE ADMIN CONSOLE FOR AN ALREADY-BUILT COMPLIANCE WORKFLOW.
 *
 * pilot.video_publications already has the full draft -> pending_review ->
 * approved/rejected -> published machine (publication.ts), and
 * POST /api/pilot/publications/check already performs the state transition --
 * but it's a bare JSON API no page drives. This route adds the missing
 * queue view and wraps the same underlying functions with an org-admin-only
 * gate and the audit trail this ticket requires (the sibling check route
 * writes none today).
 *
 * The ticket describes "reject -> draft" and a general "athlete list" per
 * video; neither matches the real system, and both are corrected here
 * deliberately rather than silently reinterpreted:
 *   - A failed check moves a publication to the real terminal `rejected`
 *     status, not back to `draft`. The coach-facing publication flow's own
 *     existing copy already tells an uploader whose check failed to create a
 *     NEW publication once the issue is fixed, not resubmit this one -- a
 *     literal "back to draft" transition doesn't exist anywhere in
 *     publication.ts and would contradict that shipped UX.
 *   - `pilot.video_publications.athlete_id` is a single scalar column, not a
 *     list -- one publication covers one named athlete. There is no join
 *     table for "which athletes appear in this video," and building one is
 *     out of this ticket's allowed files (no migration listed) and out of
 *     its own stated scope ("detailed athlete-level consent verification"
 *     is explicitly excluded).
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin']);

    const publications = await getOrganizationPublications(principal.organizationId, { status: 'pending_review' });

    const items = await Promise.all(
      publications.map(async (publication) => {
        const [uploader, athlete, videoSession] = await Promise.all([
          getSubjectIdentity(principal.organizationId, publication.submitted_by_account_id),
          getAthleteById(principal.organizationId, publication.athlete_id),
          getVideoSessionById(principal.organizationId, publication.video_session_id),
        ]);

        return {
          publication_id: publication.publication_id,
          title: publication.title,
          description: publication.description,
          athlete_id: publication.athlete_id,
          athlete_name: athlete?.full_name ?? null,
          uploader_account_id: publication.submitted_by_account_id,
          // No "display name" field exists on pilot.accounts -- getSubjectIdentity
          // falls back to a formatted login_email, or the raw account id if
          // even that is null. Not a name, the best available proxy for one.
          uploader_name: uploader?.fullName ?? null,
          created_at: publication.created_at,
          compliance_check_status: publication.compliance_check_status,
          // Only a 'ready' video session has bytes worth streaming -- see
          // GET /api/pilot/video/[videoId], whose SAS-url pattern this
          // reuses directly rather than round-tripping through that route.
          stream_url: videoSession && videoSession.status === 'ready'
            ? getPilotVideoSasUrl(videoSession.blob_path, 60)
            : null,
        };
      }),
    );

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

type ComplianceDecision = 'approve' | 'reject' | 'request_changes';

const DECISIONS = new Set<ComplianceDecision>(['approve', 'reject', 'request_changes']);

// Maps the console's vocabulary onto pilot.publication_checks' own
// check_status CHECK constraint values (recordComplianceCheck/check/route.ts).
const DECISION_TO_CHECK_STATUS: Record<ComplianceDecision, string> = {
  approve: 'passed',
  reject: 'failed',
  request_changes: 'manual_review',
};

const DECISION_TO_NEW_STATUS: Record<ComplianceDecision, string> = {
  approve: 'approved',
  reject: 'rejected',
  // Stays in pending_review -- the whole point of "request changes" is that
  // the uploader fixes the SAME publication and it comes back through this
  // same queue, unlike reject's terminal state.
  request_changes: 'pending_review',
};

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin']);

    const body = (await request.json().catch(() => null)) as
      | { publication_id?: unknown; decision?: unknown; note?: unknown }
      | null;
    const publicationId = typeof body?.publication_id === 'string' ? body.publication_id.trim() : '';
    const rawDecision: unknown = body?.decision;
    const note = typeof body?.note === 'string' ? body.note.trim() : '';

    if (!publicationId) {
      throw new Error('Missing publication_id');
    }
    if (!DECISIONS.has(rawDecision as ComplianceDecision)) {
      throw new Error('Unsupported decision: expected "approve", "reject", or "request_changes"');
    }
    const decision = rawDecision as ComplianceDecision;
    // A rejection or a request for changes without a stated reason leaves the
    // uploader -- a coach whose footage of a minor was just refused -- with
    // nothing to act on. Approval carries no such requirement.
    if (decision !== 'approve' && !note) {
      throw new Error(
        `Missing note: a ${decision === 'reject' ? 'rejection' : 'request for changes'} needs a stated reason`,
      );
    }

    const publication = await getPublicationForPublish(principal.organizationId, publicationId);
    if (!publication) return hiddenNotFound();

    const newStatus = DECISION_TO_NEW_STATUS[decision];
    const checkStatus = DECISION_TO_CHECK_STATUS[decision];

    // CAS-guarded: two admins can have this queue open at once. The UPDATE's
    // WHERE clause re-checks status at the moment it acquires the row lock,
    // so a losing request fails atomically instead of silently overwriting
    // whichever decision committed first.
    const applied = await updatePublicationStatus(
      principal.organizationId,
      publicationId,
      newStatus,
      checkStatus,
      decision === 'approve' ? principal.accountId : undefined,
      'pending_review',
    );
    if (!applied) {
      throw new Error('Unsupported: publication was already decided by another reviewer');
    }

    await recordComplianceCheck({
      organizationId: principal.organizationId,
      publicationId,
      checkType: 'compliance',
      checkStatus,
      details: note,
      checkedByAccountId: principal.accountId,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'video_publication',
      entity_id: publicationId,
      details: {
        action: `publication_compliance_${decision}`,
        note: note || undefined,
        prior_status: publication.status,
        new_status: newStatus,
      },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true, publication_id: publicationId, status: newStatus, compliance_check_status: checkStatus });
  } catch (error) {
    return jsonError(error);
  }
}
