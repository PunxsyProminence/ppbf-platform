import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { excludePlatformLibraryOrganizationSql } from '@/src/server/pilot/platformLibraryScope';
import { buildResearchBridgeExport } from '@/src/server/pilot/researchBridgeExport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OrganizationRow {
  organization_id: string;
}

// "Multi orgs" scope for an account holding has_master_shadow_access: every
// organization on record except the reserved platform-library shelf,
// regardless of status. This is deliberately the SAME scope
// platform/overview, platform/organizations, and the Omega SHADOW rollup
// (omegaPlatformContext.ts) already use for their own most cross-org-reaching
// views -- there is nothing in the schema or role model that defines a
// narrower per-account organization scope for this flag, and inventing one
// here would be a new, undocumented boundary rather than a reuse of an
// existing one.
async function listExportableOrganizationIds(): Promise<string[]> {
  const rows = await query<OrganizationRow>(
    `select organization_id
     from pilot.organizations
     where ${excludePlatformLibraryOrganizationSql()}
     order by organization_name asc`,
  );
  return rows.map((row) => row.organization_id);
}

const NO_STORE_HEADERS = {
  'cache-control': 'private, no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

/**
 * Session-authenticated counterpart to the Azure-AD service-account export at
 * /api/pilot/shadow/research-bridge/export. That route is unchanged and stays
 * the only path for an external staging caller; this is an ADDITIONAL path
 * for a logged-in app session, reusing requirePrincipal for authentication
 * (no new auth) and buildResearchBridgeExport for the payload itself (no new
 * export logic -- the de-identification guarantee is unchanged).
 *
 * Two, and only two, ways in:
 *   1. An account holding has_master_shadow_access reaches every organization
 *      on record (see listExportableOrganizationIds above).
 *   2. Absent that flag, an organization_admin (or legacy 'admin') reaches
 *      only their own session organization -- the same boundary every other
 *      org-admin route in this codebase holds.
 * Checked in that order so an account that happens to hold both never gets
 * silently narrowed to its own organization. Every other role, and any
 * account without the flag that is not an org admin, is refused outright:
 * there is no way for a request to ask for a broader scope than the caller's
 * own principal carries -- scope is derived entirely server-side from the
 * session, never from a request parameter.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    if (principal.hasMasterShadowAccess === true) {
      const organizationIds = await listExportableOrganizationIds();
      const exports = await Promise.all(
        organizationIds.map(async (organizationId) => ({
          organization_id: organizationId,
          ...(await buildResearchBridgeExport(organizationId)),
        })),
      );

      return NextResponse.json(
        { ok: true, scope: 'cross_organization', exports },
        { headers: NO_STORE_HEADERS },
      );
    }

    if (isOrganizationAdminRole(principal.role)) {
      const payload = await buildResearchBridgeExport(principal.organizationId);
      return NextResponse.json(
        {
          ok: true,
          scope: 'organization',
          exports: [{ organization_id: principal.organizationId, ...payload }],
        },
        { headers: NO_STORE_HEADERS },
      );
    }

    throw new Error('Forbidden: organization_admin role or cross-organization access required');
  } catch (error) {
    return jsonError(error);
  }
}
