import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { queryOne, query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The registry is stored per organization, so a platform_owner edit has to name
// the organization it targets. Supplying organization_id selects it; every other
// role resolves strictly from their own session and cannot reach another gym's
// registry. Mirrors resolveOrganizationId in the gym-capabilities route.
function resolveOrganizationId(
  principal: { role: string; organizationId: string },
  requestedOrganizationId: string | null | undefined,
): string {
  const requested = requestedOrganizationId?.trim();
  if (principal.role === 'platform_owner' && requested) {
    return requested;
  }
  return principal.organizationId;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner', 'organization_admin', 'admin']);

    const organizationId = resolveOrganizationId(
      principal,
      request.nextUrl.searchParams.get('organization_id'),
    );

    const row = await queryOne<{ capabilities: unknown }>(
      `select capabilities
       from pilot.admin_capability_registry
       where organization_id = $1`,
      [organizationId],
    );

    return NextResponse.json({
      ok: true,
      capabilities: Array.isArray(row?.capabilities) ? row?.capabilities : [],
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner', 'organization_admin', 'admin']);

    const body = (await request.json()) as { capabilities?: unknown; organization_id?: string };
    if (!Array.isArray(body.capabilities)) {
      throw new Error('capabilities must be an array');
    }

    const organizationId = resolveOrganizationId(principal, body.organization_id);

    await query(
      `insert into pilot.admin_capability_registry (
         organization_id,
         capabilities,
         updated_by_account_id,
         updated_at
       ) values ($1,$2,$3,now())
       on conflict (organization_id) do update
       set capabilities = excluded.capabilities,
           updated_by_account_id = excluded.updated_by_account_id,
           updated_at = now()`,
      [organizationId, JSON.stringify(body.capabilities), principal.accountId],
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
