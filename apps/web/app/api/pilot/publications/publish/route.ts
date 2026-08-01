import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPublicationForPublish, publishToResearchLibrary } from '@/src/server/pilot/publication';
import { hiddenNotFound, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin', 'coach']);

    // Only the two identifiers are read from the request. Title, description
    // and tags come from the publication row, so what lands on the library
    // shelf is what the compliance check was recorded against.
    const body = (await request.json()) as {
      publication_id?: string;
      video_session_id?: string;
    };

    if (!body.publication_id || !body.video_session_id) {
      throw new Error('Missing required fields');
    }

    const publication = await getPublicationForPublish(principal.organizationId, body.publication_id);

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

    if (publication.video_session_id !== body.video_session_id) {
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

    const libraryId = await publishToResearchLibrary({
      organizationId: principal.organizationId,
      publicationId: publication.publication_id,
      videoSessionId: publication.video_session_id,
      title: publication.title,
      description: publication.description,
      tags: publication.tags,
    });

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
    await writePilotAuditEvent({
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
