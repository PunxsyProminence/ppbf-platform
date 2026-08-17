import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { getPipelineConfig } from '@/src/server/document-intake/config';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getShadowLibrarySourceForMirror } from '@/src/server/pilot/shadowLibrary';
import { mirrorShadowLibrarySourceToSharePoint } from '@/src/server/pilot/shadowLibraryMirror';
import { SHADOW_LIBRARY_CURATOR_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

function isMockModeEnabled(): boolean {
  return process.env.PPBF_INGEST_MOCK_MODE === 'true';
}

// Curator-triggered, one source at a time, and read-gated the same way the
// rest of the Library is: only a source that is already approved+verified
// (citable) can be mirrored, so the backup can never carry unreviewed
// material out of the app before a human has signed off on it here.
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);

    const body = (await request.json().catch(() => ({}))) as { source_id?: unknown };
    if (typeof body.source_id !== 'string' || !body.source_id.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing source_id' }, { status: 400 });
    }

    const record = await getShadowLibrarySourceForMirror(principal.organizationId, body.source_id.trim());
    if (!record) {
      return NextResponse.json(
        { ok: false, error: 'Source not found, or not yet approved and verified' },
        { status: 404 },
      );
    }

    const mirroredAt = new Date().toISOString();

    if (isMockModeEnabled()) {
      return NextResponse.json({
        ok: true,
        mirror: { itemId: `mock-mirror-${record.source.source_id}`, webUrl: undefined, mirroredAt },
      });
    }

    const result = await mirrorShadowLibrarySourceToSharePoint(
      getPipelineConfig().sharepoint,
      record.source,
      record.documents,
      mirroredAt,
    );

    return NextResponse.json({ ok: true, mirror: { ...result, mirroredAt } });
  } catch (error) {
    return jsonError(error);
  }
}
