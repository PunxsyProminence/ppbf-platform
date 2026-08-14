import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import {
  assertGuardianMediaConsent,
  assertGuardianMediaConsentWithClient,
  GuardianConsentMissingError,
} from '@/src/server/pilot/guardianConsent';
import { getPublicationForPublish, publishToResearchLibrary } from '@/src/server/pilot/publication';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

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

    let libraryId: string | null;
    try {
      // Approval already checked guardian consent, but a guardian may
      // withdraw between approval and this publish -- and publishing is the
      // act that puts a minor's footage on a shelf other people can reach.
      // Same two-layer shape as the console's approval: a cheap pre-check
      // that fails fast, then the SAME check re-run inside the claim's own
      // transaction (verifyBeforeCommit), so a withdrawal cannot commit in
      // the gap between the pre-check returning and the claim landing.
      await assertGuardianMediaConsent(principal.organizationId, publication.athlete_id);

      libraryId = await publishToResearchLibrary({
        organizationId: principal.organizationId,
        publicationId: publication.publication_id,
        videoSessionId: publication.video_session_id,
        title: publication.title,
        description: publication.description,
        tags: publication.tags,
        verifyBeforeCommit: (client) =>
          assertGuardianMediaConsentWithClient(client, principal.organizationId, publication.athlete_id),
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
