import { NextResponse, type NextRequest } from 'next/server';

import { getAthleteById } from '@/src/server/pilot/entities';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotVideoSasUrl } from '@/src/server/pilot/blob';
import { assertGuardianMediaConsent, assertGuardianMediaConsentWithClient, GuardianConsentMissingError } from '@/src/server/pilot/guardianConsent';
import { hiddenNotFound, jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  decidePublicationCompliance,
  getLatestPublicationCheck,
  getOrganizationPublications,
  getPublicationForPublish,
  reopenRetractedPublication,
  retractPublication,
} from '@/src/server/pilot/publication';
import { getSubjectIdentity } from '@/src/server/pilot/profileDb';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

// A lost audit row is a gap an operator can close by re-dispatching, not a
// reason to tell the admin their (already-committed, atomically-correct)
// compliance decision failed -- same doctrine as training-holds' auditHoldEvent.
async function auditComplianceEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'video-compliance-audit-write-failed',
      action: event.details && typeof event.details === 'object' ? (event.details as { action?: unknown }).action : undefined,
      ...(code ? { code } : {}),
    });
  }
}

export const runtime = 'nodejs';

/**
 * T-006: THE ADMIN CONSOLE FOR AN ALREADY-BUILT COMPLIANCE WORKFLOW.
 *
 * pilot.video_publications already has the full draft -> pending_review ->
 * approved/rejected -> published machine (publication.ts). This route is the
 * queue view and the decision path, with an org-admin-only gate and the
 * audit trail this ticket requires. (An earlier sibling,
 * POST /api/pilot/publications/check, performed the same transition as a
 * bare JSON API with no page driving it, no consent gate, and no audit --
 * it was deleted once this console superseded it, so decisions cannot
 * arrive through a path that skips the gates below.)
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
 *
 * T-008: approving is additionally gated on guardian media consent
 * (assertGuardianMediaConsent) -- see guardianConsent.ts for what "consent"
 * means and what is deliberately not yet enforced (scope matching, retroactive
 * un-publishing on revocation).
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin']);

    const [publications, draftRows, publishedRows, retractedRows] = await Promise.all([
      getOrganizationPublications(principal.organizationId, { status: 'pending_review' }),
      // Drafts are normally the submitting coach's business, but the submit
      // route deliberately lets an org admin move one into this queue -- the
      // case that needs it is a coach who left the gym with drafts nobody
      // else could reach from any screen (owner decision, 2026-08-14). This
      // console is the approved surface for that lever; do not build another.
      getOrganizationPublications(principal.organizationId, { status: 'draft' }),
      // Published and retracted are the retraction workflow's two sides
      // (owner decision, 2026-08-14): an org admin may suppress a live
      // publication from distribution, and may reopen a retracted one back
      // into this review queue -- never directly back to published.
      getOrganizationPublications(principal.organizationId, { status: 'published' }),
      getOrganizationPublications(principal.organizationId, { status: 'retracted' }),
    ]);

    const items = await Promise.all(
      publications.map(async (publication) => {
        const [uploader, athlete, videoSession, latestCheck] = await Promise.all([
          getSubjectIdentity(principal.organizationId, publication.submitted_by_account_id),
          getAthleteById(principal.organizationId, publication.athlete_id),
          getVideoSessionById(principal.organizationId, publication.video_session_id),
          // A publication only re-enters this queue via 'request_changes',
          // which always leaves a check row behind -- so a non-'pending'
          // compliance_check_status here means a reviewer has already looked
          // at this once, and what they said must not be invisible to
          // whoever opens it next.
          publication.compliance_check_status !== 'pending'
            ? getLatestPublicationCheck(principal.organizationId, publication.publication_id)
            : null,
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
          previous_review_note: latestCheck?.details || null,
          // Only a 'ready' video session has bytes worth streaming -- see
          // GET /api/pilot/video/[videoId], whose SAS-url pattern this
          // reuses directly rather than round-tripping through that route.
          stream_url: videoSession && videoSession.status === 'ready'
            ? getPilotVideoSasUrl(videoSession.blob_path, 60)
            : null,
        };
      }),
    );

    // Lighter than the queue items on purpose: routing or suppressing a
    // publication is not deciding it, so there is no stream URL and no
    // prior-review note to surface on these lists.
    const summarize = async (rows: typeof draftRows) =>
      Promise.all(
        rows.map(async (row) => {
          const [uploader, athlete] = await Promise.all([
            getSubjectIdentity(principal.organizationId, row.submitted_by_account_id),
            getAthleteById(principal.organizationId, row.athlete_id),
          ]);

          return {
            publication_id: row.publication_id,
            title: row.title,
            description: row.description,
            athlete_id: row.athlete_id,
            athlete_name: athlete?.full_name ?? null,
            uploader_account_id: row.submitted_by_account_id,
            uploader_name: uploader?.fullName ?? null,
            created_at: row.created_at,
          };
        }),
      );

    const [drafts, published, retracted] = await Promise.all([
      summarize(draftRows),
      summarize(publishedRows),
      summarize(retractedRows),
    ]);

    return NextResponse.json({ ok: true, items, drafts, published, retracted });
  } catch (error) {
    return jsonError(error);
  }
}

type ComplianceDecision = 'approve' | 'reject' | 'request_changes';

const DECISIONS = new Set<ComplianceDecision>(['approve', 'reject', 'request_changes']);

// Maps the console's vocabulary onto pilot.publication_checks' own
// check_status CHECK constraint values.
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

    // The retraction workflow's two levers (owner decision, 2026-08-14).
    // They are lifecycle transitions, not compliance decisions: no check row
    // is filed, and no consent gate runs here -- retracting needs no consent
    // (it removes distribution), and reopening only re-enters the queue,
    // where approval and publish each re-run the consent gate themselves.
    // An org admin can suppress; nothing here can grant or restore a
    // guardian's consent.
    if (rawDecision === 'retract' || rawDecision === 'reopen_review') {
      // A retraction of a minor's published footage without a stated reason
      // is unauditable; the reason lands on the suppressed shelf row and in
      // the audit event. Checked before any read.
      if (rawDecision === 'retract' && !note) {
        throw new Error('Missing note: a retraction needs a stated reason');
      }

      const publication = await getPublicationForPublish(principal.organizationId, publicationId);
      if (!publication) return hiddenNotFound();

      if (rawDecision === 'retract') {
        const applied = await retractPublication({
          organizationId: principal.organizationId,
          publicationId,
          suppressedByAccountId: principal.accountId,
          reason: note,
        });
        if (!applied) {
          return NextResponse.json(
            { error: 'Only a published publication can be retracted.', status: publication.status },
            { status: 409 },
          );
        }
        await auditComplianceEvent({
          event_type: 'update',
          actor_account_id: principal.accountId,
          actor_role: principal.role,
          organization_id: principal.organizationId,
          entity_type: 'video_publication',
          entity_id: publicationId,
          details: { action: 'publication_retracted', note, prior_status: publication.status },
          shadow_mirror: false,
        });
        return NextResponse.json({ ok: true, publication_id: publicationId, status: 'retracted' });
      }

      const applied = await reopenRetractedPublication(principal.organizationId, publicationId);
      if (!applied) {
        return NextResponse.json(
          { error: 'Only a retracted publication can be reopened for review.', status: publication.status },
          { status: 409 },
        );
      }
      await auditComplianceEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'video_publication',
        entity_id: publicationId,
        details: { action: 'publication_reopened_for_review', note: note || undefined, prior_status: publication.status },
        shadow_mirror: false,
      });
      return NextResponse.json({ ok: true, publication_id: publicationId, status: 'pending_review' });
    }

    if (!DECISIONS.has(rawDecision as ComplianceDecision)) {
      throw new Error('Unsupported decision: expected "approve", "reject", "request_changes", "retract", or "reopen_review"');
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

    try {
      // T-008: only 'approve' is gated -- rejecting or requesting changes
      // isn't publishing anything, so there is nothing for guardian consent
      // to block. A cheap pre-check runs first (fails fast, no transaction
      // opened for an obviously-blocked case); the SAME check runs again
      // inside decidePublicationCompliance's own transaction
      // (verifyBeforeCommit), against the same client, immediately before
      // the CAS UPDATE -- closing the race where a guardian's withdrawal
      // could otherwise commit in the gap between the pre-check returning
      // and this transaction's UPDATE landing.
      if (decision === 'approve') {
        await assertGuardianMediaConsent(principal.organizationId, publication.athlete_id);
      }

      // CAS-guarded status transition AND its compliance-check record, as one
      // transaction: two admins can have this queue open at once, and a losing
      // request's UPDATE fails atomically instead of silently overwriting
      // whichever decision committed first. Doing the check-record insert in
      // the SAME transaction (rather than as a second, separate write) means
      // there is no window where the status has moved but no row exists
      // recording who decided it or why.
      const applied = await decidePublicationCompliance({
        organizationId: principal.organizationId,
        publicationId,
        newStatus,
        checkStatus,
        checkType: 'compliance',
        details: note,
        decidedByAccountId: principal.accountId,
        approvedByAccountId: decision === 'approve' ? principal.accountId : undefined,
        expectedCurrentStatus: 'pending_review',
        verifyBeforeCommit: decision === 'approve'
          ? (client) => assertGuardianMediaConsentWithClient(client, principal.organizationId, publication.athlete_id)
          : undefined,
      });
      if (!applied) {
        throw new Error('Unsupported: publication was already decided by another reviewer');
      }
    } catch (error) {
      // T-008: a blocked approval attempt is itself a safeguarding-relevant
      // fact ("who tried to approve unconsented footage of this child, and
      // when") -- the ticket's own acceptance criteria calls for logging it,
      // not just the successful decisions.
      if (error instanceof GuardianConsentMissingError) {
        await auditComplianceEvent({
          event_type: 'update',
          actor_account_id: principal.accountId,
          actor_role: principal.role,
          organization_id: principal.organizationId,
          entity_type: 'video_publication',
          entity_id: publicationId,
          details: {
            action: 'publication_compliance_approve_blocked_by_consent',
            missing_parent_ids: error.missingParentIds,
          },
          shadow_mirror: false,
        });
      }
      throw error;
    }

    await auditComplianceEvent({
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
