import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import { assertCanAuthorRabbitHoles, createRabbitHole } from '@/src/server/pilot/rabbitHoles';

export const runtime = 'nodejs';

/**
 * Writing a rabbit hole publishes it. There is no review step, because there is
 * no reviewer -- the owner's decision is that a coach writes and publishes
 * directly, and retiring is how a lesson leaves the surface again.
 *
 * Microsoft-authenticated only, like every other authoring route: a PIN session
 * is athlete self-service, and a lesson speaks to the whole gym.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    assertCanAuthorRabbitHoles(principal);

    const body = (await request.json()) as {
      anchor_type?: string;
      anchor_key?: string;
      audience?: string;
      title?: string;
      concept?: string;
      homework?: string | null;
      library_document_id?: string | null;
      author_display_name?: string;
    };

    // The organization is the caller's own, never the body's: a lesson never
    // crosses gyms, and the author is whoever is signed in.
    const lesson = await createRabbitHole({
      organizationId: principal.organizationId,
      anchorType: body.anchor_type,
      anchorKey: body.anchor_key,
      audience: body.audience,
      title: body.title,
      concept: body.concept,
      homework: body.homework,
      libraryDocumentId: body.library_document_id,
      authorAccountId: principal.accountId,
      authorDisplayName: body.author_display_name,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'rabbit_hole',
      entity_id: lesson.rabbit_hole_id,
      details: {
        anchor_type: lesson.anchor_type,
        anchor_key: lesson.anchor_key,
        audience: lesson.audience,
        status: lesson.status,
      },
    });

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      rabbit_hole: lesson,
    });
  } catch (error) {
    return jsonError(error);
  }
}
