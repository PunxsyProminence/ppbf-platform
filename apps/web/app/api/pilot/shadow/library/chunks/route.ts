import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { createShadowLibraryChunk } from '@/src/server/pilot/shadowLibrary';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach']);
    await assertShadowRuntimeReadiness({ requiredTables: [] });

    const body = (await request.json().catch(() => ({}))) as {
      document_id?: string;
      ordinal?: number;
      text_content?: string;
      metadata?: Record<string, unknown>;
    };

    if (!body.document_id?.trim()) {
      return NextResponse.json({ ok: false, error: 'missing document_id' }, { status: 400 });
    }

    if (!body.text_content?.trim()) {
      return NextResponse.json({ ok: false, error: 'missing text_content' }, { status: 400 });
    }

    const chunk = await createShadowLibraryChunk({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      documentId: body.document_id,
      ordinal: body.ordinal ?? 0,
      textContent: body.text_content,
      metadata: body.metadata,
    });

    return NextResponse.json({ ok: true, chunk });
  } catch (error) {
    return jsonError(error);
  }
}
