import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { query, queryOne } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

function toCapabilityAccess(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, boolean> = {};

  for (const [key, rawValue] of Object.entries(source)) {
    if (typeof rawValue === 'boolean') {
      result[key] = rawValue;
    }
  }

  return result;
}

// A platform_owner may act on any organization by supplying organization_id
// explicitly (e.g. the new-org wizard setting capabilities for the gym it just
// created, not the platform owner's own org). Every other role keeps resolving
// strictly from their own session, exactly as before -- this only adds an
// override, it never changes what an organization_admin/admin sees or saves.
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

    const row = await queryOne<{ capability_access: unknown }>(
      `select capability_access
       from pilot.admin_gym_capability_access
       where organization_id = $1`,
      [organizationId],
    );

    return NextResponse.json({
      ok: true,
      capabilityAccess: toCapabilityAccess(row?.capability_access),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner', 'organization_admin', 'admin']);

    const body = (await request.json()) as { capabilityAccess?: unknown; organization_id?: string };
    const capabilityAccess = toCapabilityAccess(body.capabilityAccess);
    const organizationId = resolveOrganizationId(principal, body.organization_id);

    await query(
      `insert into pilot.admin_gym_capability_access (
         organization_id,
         capability_access,
         updated_by_account_id,
         updated_at
       ) values ($1, $2, $3, now())
       on conflict (organization_id) do update
       set capability_access = excluded.capability_access,
           updated_by_account_id = excluded.updated_by_account_id,
           updated_at = now()`,
      [organizationId, JSON.stringify(capabilityAccess), principal.accountId],
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
