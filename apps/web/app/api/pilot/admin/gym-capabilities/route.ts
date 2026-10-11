import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { queryOne, withTransaction } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { isPlatformLibraryOrganization } from '@/src/server/pilot/platformLibraryScope';

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

// A gym's capability flags are that gym's own, read and saved from /admin by
// its admin for the gym of the session. That is gym work, and platform_owner
// is refused there (OD-2026-10-10-004 ruling 3).
//
// One use is platform work and stays: the new-gym wizard, where the platform
// owner sets the first flags of the gym it just created. So platform_owner is
// refused on GET (it reads a gym's flags through platform/gym-summary), and
// admitted on POST only when the body names the gym with organization_id.
// Without that id the write would land on the gym of its own session, which is
// exactly the gym work the ruling removes, so it is refused. Every other role
// keeps resolving strictly from its own session; an organization_id it sends
// is ignored.
const GYM_ADMIN_ROLES = ['organization_admin', 'admin'] as const;

function resolveWriteOrganizationId(
  principal: { role: string; organizationId: string },
  requestedOrganizationId: unknown,
): string {
  if (principal.role !== 'platform_owner') {
    return principal.organizationId;
  }
  const named = typeof requestedOrganizationId === 'string' ? requestedOrganizationId.trim() : '';
  if (!named) {
    throw new Error('Forbidden: the platform owner sets capabilities only for a gym it names');
  }
  // The platform evidence shelf is not a gym and has no features to switch on.
  if (isPlatformLibraryOrganization(named)) {
    throw new Error('Unsupported organization_id');
  }
  return named;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...GYM_ADMIN_ROLES]);

    const row = await queryOne<{ capability_access: unknown }>(
      `select capability_access
       from pilot.admin_gym_capability_access
       where organization_id = $1`,
      [principal.organizationId],
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
    requireRole(principal, ['platform_owner', ...GYM_ADMIN_ROLES]);

    const body = (await request.json()) as { capabilityAccess?: unknown; organization_id?: unknown };
    const organizationId = resolveWriteOrganizationId(principal, body.organization_id);
    const capabilityAccess = toCapabilityAccess(body.capabilityAccess);

    // One transaction, so the platform owner's write to a gym always has its
    // record and a failed record leaves the gym's flags unchanged.
    await withTransaction(async (client) => {
      await client.query(
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

      if (principal.role === 'platform_owner') {
        await writePilotAuditEvent(
          {
            event_type: 'update',
            actor_account_id: principal.accountId,
            actor_role: principal.role,
            // The organization acted ON, not the actor's own: the row has to
            // appear in the log of the gym whose flags were set.
            organization_id: organizationId,
            entity_type: 'gym_capability_access',
            entity_id: organizationId,
            details: { capability_access: capabilityAccess },
          },
          client,
        );
      }
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
