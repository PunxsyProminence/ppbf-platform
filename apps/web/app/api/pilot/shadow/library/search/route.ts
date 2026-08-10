import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { searchShadowLibrary } from '@/src/server/pilot/shadowLibrary';

export const runtime = 'nodejs';

const requiredShadowLibraryTables = [
  'shadow_library_sources',
  'shadow_library_documents',
  'shadow_library_chunks',
  'shadow_library_capability_map',
];

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff']);
    await assertShadowRuntimeReadiness({ requiredTables: requiredShadowLibraryTables });

    const body = (await request.json().catch(() => ({}))) as {
      // 'master' selected no subject predicate at all and returned every
      // athlete-scoped chunk in the organization regardless of caller
      // authorization; it was removed from ShadowLibraryScope for exactly
      // that reason. searchShadowLibrary's normalizeSearchScope fails
      // closed on anything outside this union (see the comment there), so
      // this route's type just needs to stop advertising a value the
      // server function no longer accepts.
      scope?: 'scoped' | 'subject';
      subject_id?: string;
      query?: string;
      limit?: number;
    };

    if (!body.query?.trim()) {
      return NextResponse.json({ ok: false, error: 'missing query' }, { status: 400 });
    }

    const results = await searchShadowLibrary({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      athleteId: principal.athleteId,
      scope: body.scope,
      subjectId: body.subject_id,
      queryText: body.query,
      limit: body.limit,
    });

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, results });
  } catch (error) {
    return jsonError(error);
  }
}
