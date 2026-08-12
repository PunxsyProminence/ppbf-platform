import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { createOrganization } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { excludePlatformLibraryOrganizationSql } from '@/src/server/pilot/platformLibraryScope';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const rows = await query<{
      organization_id: string;
      organization_name: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>(
      // The reserved organization owning the platform SHADOW evidence baseline
      // is excluded: this list is the platform owner's roster of gyms, and every
      // action offered against a row here -- activation, capability grants,
      // staff provisioning -- is meaningless for a shelf with no members.
      `select organization_id, organization_name, status, created_at, updated_at
       from pilot.organizations
       where ${excludePlatformLibraryOrganizationSql()}
       order by organization_name asc`,
    );

    return NextResponse.json({ ok: true, organizations: rows });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as {
      organization_id?: string;
      organization_name?: string;
    };

    const organizationId = body.organization_id?.trim() || '';
    const organizationName = body.organization_name?.trim() || '';

    if (!organizationId || !organizationName) {
      throw new Error('Missing organization_id or organization_name');
    }

    await createOrganization(organizationId, organizationName, principal.accountId);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'organization',
      entity_id: organizationId,
      details: { organization_name: organizationName },
    });

    return NextResponse.json({ ok: true, organization_id: organizationId, organization_name: organizationName });
  } catch (error) {
    return jsonError(error);
  }
}
