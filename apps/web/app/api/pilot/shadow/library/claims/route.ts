import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { createShadowLibraryClaim } from '@/src/server/pilot/shadowLibrary';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff']);
    await assertShadowRuntimeReadiness({ requiredTables: [] });

    const body = (await request.json().catch(() => ({}))) as {
      scope?: 'master' | 'scoped' | 'subject';
      subject_id?: string;
      question?: string;
      limit?: number;
    };

    if (!body.question?.trim()) {
      return NextResponse.json({ ok: false, error: 'missing question' }, { status: 400 });
    }

    const claim = await createShadowLibraryClaim({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      athleteId: principal.athleteId,
      scope: body.scope,
      subjectId: body.subject_id,
      question: body.question,
      limit: body.limit,
    });

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, claim });
  } catch (error) {
    return jsonError(error);
  }
}
