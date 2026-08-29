import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { excludePlatformLibraryOrganizationSql } from '@/src/server/pilot/platformLibraryScope';
import {
  assertResearchBridgeExportEnvironment,
  ResearchBridgeAccessError,
} from '@/src/server/pilot/researchBridgeAuth';
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
 *
 * AND, since this route reuses that export, it now holds the same ENVIRONMENT
 * FENCE the sibling holds. It had none. "Reusing buildResearchBridgeExport,
 * so the de-identification guarantee is unchanged" was true about the payload
 * and silently untrue about where the payload may exist: /export refuses
 * outright unless RESEARCH_BRIDGE_EXPORT_ENABLED is 'true',
 * RESEARCH_BRIDGE_EXPORT_ENVIRONMENT is 'staging' and the request arrived on
 * the declared host, while this route produced the identical
 * 'sanitized-staging-only' payload from any deployment -- production included
 * -- and, for a caller holding master SHADOW access, across EVERY organization
 * on record rather than the single configured one. The narrower route was
 * fenced and the wider one was not.
 *
 * The same helper, not a second copy, so the two cannot drift into disagreeing
 * about where this payload may exist.
 */
export async function GET(request: NextRequest) {
  try {
    // FIRST, before the session is resolved and before any query runs.
    //
    // 404, matching the sibling: a fenced deployment is indistinguishable from
    // one where this route was never deployed, and a caller holding the
    // cross-organization flag learns exactly what a stranger learns. A 403
    // would instead confirm the route exists and that only credentials are
    // missing, which is the one fact worth having when the payload behind it
    // spans every organization.
    //
    // Ordered ahead of requirePrincipal on purpose. The fence is a property of
    // the DEPLOYMENT, not of the caller, so no session can satisfy it and
    // nothing is gained by finding out who is asking first; a production
    // deployment now does no authentication work and reads no organization row
    // on this path at all. It leaks nothing either: on a production host the
    // host condition fails by construction, so 404 is the constant answer there
    // whoever asks.
    //
    // Safe to fence rather than degrade because nothing consumes this route --
    // no client, no page, no script, no workflow. Its only references in the
    // repository are its own test, the route-gate convention allowlist, and one
    // audit document; the external research-bridge service
    // (apps/research-bridge/src/ppbfClient.ts) calls /export, not this.
    assertResearchBridgeExportEnvironment(request);

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
    // The fence's own refusal is rendered exactly as /export renders it, so
    // the two routes answer a fenced-out request identically. Everything else
    // still goes through jsonError, which is what turns the Forbidden above
    // into a 403.
    if (error instanceof ResearchBridgeAccessError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    return jsonError(error);
  }
}
