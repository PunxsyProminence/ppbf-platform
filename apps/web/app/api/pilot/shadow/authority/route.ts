import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { listShadowAuthorityChecks } from '@/src/server/pilot/shadowReadModels';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // Read-only listing of authority checks (governance audit records).
    // platform_owner is added because reading governance signal is the core of
    // the Omega tier; the existing coach/admin audience is intentionally NOT
    // widened to athlete/parent here.
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'platform_owner']);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_authority_checks'] });

    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      offset?: number;
      action?: string;
      allowed?: boolean;
      correlation_id?: string;
      created_after?: string;
    };

    const authority_checks = await listShadowAuthorityChecks(
      {
        organizationId: principal.organizationId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        athleteId: principal.athleteId,
      },
      {
        limit: body.limit,
        offset: body.offset,
        action: body.action,
        allowed: typeof body.allowed === 'boolean' ? body.allowed : undefined,
        correlationId: body.correlation_id,
        createdAfter: body.created_after,
      },
    );

    return NextResponse.json({
      ok: true,
      organization_id: principal.organizationId,
      authority_checks,
    });
  } catch (error) {
    return jsonError(error);
  }
}
