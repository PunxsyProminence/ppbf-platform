import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { hiddenNotFound, jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import {
  assertCanManageRabbitHole,
  getRabbitHole,
  setRabbitHoleStatus,
  updateRabbitHole,
} from '@/src/server/pilot/rabbitHoles';

export const runtime = 'nodejs';

/**
 * Edits a lesson, retires it, or puts a retired one back.
 *
 * The lesson is loaded first so authorship can be checked against the stored
 * row rather than the request: a coach may change what they wrote, an
 * administrator may change anything in their own organization, and a lesson in
 * another gym is not reachable at all -- getRabbitHole is organization-scoped,
 * and the 404 is the same one a lesson that does not exist returns, so the two
 * are indistinguishable to the caller.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    const body = (await request.json()) as {
      rabbit_hole_id?: string;
      status?: string;
      anchor_type?: string;
      anchor_key?: string;
      audience?: string;
      title?: string;
      concept?: string;
      homework?: string | null;
      library_document_id?: string | null;
    };

    const rabbitHoleId = body.rabbit_hole_id?.trim() || '';
    if (!rabbitHoleId) {
      throw new Error('Missing rabbit_hole_id');
    }

    const existing = await getRabbitHole(principal.organizationId, rabbitHoleId);
    if (!existing) {
      return hiddenNotFound();
    }

    assertCanManageRabbitHole(principal, existing);

    const editedFields = ['anchor_type', 'anchor_key', 'audience', 'title', 'concept', 'homework', 'library_document_id'] as const;
    const hasEdit = editedFields.some((field) => body[field] !== undefined);

    let lesson = existing;

    if (hasEdit) {
      const updated = await updateRabbitHole({
        organizationId: principal.organizationId,
        rabbitHoleId,
        anchorType: body.anchor_type,
        anchorKey: body.anchor_key,
        audience: body.audience,
        title: body.title,
        concept: body.concept,
        homework: body.homework,
        libraryDocumentId: body.library_document_id,
      });

      if (!updated) {
        return hiddenNotFound();
      }

      lesson = updated;
    }

    if (body.status !== undefined) {
      const restatused = await setRabbitHoleStatus({
        organizationId: principal.organizationId,
        rabbitHoleId,
        status: body.status,
      });

      if (!restatused) {
        return hiddenNotFound();
      }

      lesson = restatused;
    }

    if (!hasEdit && body.status === undefined) {
      throw new Error('Missing changes: an edit must change at least one field');
    }

    await writePilotAuditEvent({
      event_type: 'update',
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
        fields: editedFields.filter((field) => body[field] !== undefined),
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
