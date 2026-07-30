import { NextResponse, type NextRequest } from 'next/server';

import type { PilotRole } from '@/src/server/pilot/contracts';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { searchShadowLibrary, type ShadowLibraryScope } from '@/src/server/pilot/shadowLibrary';
import { SHADOW_PROJECTION_READ_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

// Restored deliberately scoped to 'scoped' | 'subject' only -- the removed
// 'master' value returned every athlete-scoped chunk in the organization with
// no per-athlete authorization check (see the type comment in
// shadowLibrary.ts). searchShadowLibrary's own normalizeSearchScope already
// rejects anything else and enforces assertActorCanAccessAthlete for
// 'subject' scope; this route does not loosen either guarantee.
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_PROJECTION_READ_ROLES]);

    const body = (await request.json().catch(() => ({}))) as {
      query?: unknown;
      scope?: unknown;
      subject_id?: unknown;
      limit?: unknown;
    };

    if (typeof body.query !== 'string' || !body.query.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing SHADOW library query' }, { status: 400 });
    }

    if (body.scope !== undefined && body.scope !== 'scoped' && body.scope !== 'subject') {
      return NextResponse.json({ ok: false, error: 'scope must be "scoped" or "subject"' }, { status: 400 });
    }

    if (body.subject_id !== undefined && typeof body.subject_id !== 'string') {
      return NextResponse.json({ ok: false, error: 'subject_id must be a string' }, { status: 400 });
    }

    if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isFinite(body.limit))) {
      return NextResponse.json({ ok: false, error: 'limit must be a number' }, { status: 400 });
    }

    const results = await searchShadowLibrary({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role as PilotRole,
      athleteId: principal.athleteId,
      scope: body.scope as ShadowLibraryScope | undefined,
      subjectId: (body.subject_id as string | undefined) ?? null,
      queryText: body.query,
      limit: body.limit as number | undefined,
    });

    return NextResponse.json({ ok: true, results });
  } catch (error) {
    return jsonError(error);
  }
}
