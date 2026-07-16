import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { createShadowLibraryDocument, type ShadowLibraryIngestState } from '@/src/server/pilot/shadowLibrary';

export const runtime = 'nodejs';

function parseIngestState(value: string | undefined): ShadowLibraryIngestState | undefined {
  if (!value) return undefined;

  const allowed: ShadowLibraryIngestState[] = [
    'pending',
    'extracting',
    'chunking',
    'embedding',
    'indexed',
    'failed',
    'quarantined',
  ];

  return allowed.includes(value as ShadowLibraryIngestState) ? (value as ShadowLibraryIngestState) : undefined;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach']);
    await assertShadowRuntimeReadiness({ requiredTables: [] });

    const body = (await request.json().catch(() => ({}))) as {
      source_id?: string;
      subject_id?: string;
      document_name?: string;
      blob_path?: string;
      content_sha256?: string;
      ingest_state?: string;
      metadata?: Record<string, unknown>;
    };

    if (!body.source_id?.trim()) {
      return NextResponse.json({ ok: false, error: 'missing source_id' }, { status: 400 });
    }

    if (!body.document_name?.trim()) {
      return NextResponse.json({ ok: false, error: 'missing document_name' }, { status: 400 });
    }

    const ingestState = parseIngestState(body.ingest_state);

    if (body.ingest_state && !ingestState) {
      return NextResponse.json({ ok: false, error: 'invalid ingest_state' }, { status: 400 });
    }

    const item = await createShadowLibraryDocument({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      sourceId: body.source_id,
      documentName: body.document_name,
      subjectId: body.subject_id,
      blobPath: body.blob_path,
      contentSha256: body.content_sha256,
      ingestState,
      metadata: body.metadata,
    });

    return NextResponse.json({ ok: true, document: item });
  } catch (error) {
    return jsonError(error);
  }
}
