import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { setOrganizationStatus } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { isPlatformLibraryOrganization } from '@/src/server/pilot/platformLibraryScope';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as {
      organization_id?: string;
      status?: 'active' | 'inactive' | 'suspended' | 'pending';
    };

    const organizationId = body.organization_id?.trim() || '';
    const status = body.status;

    if (!organizationId || !status) {
      throw new Error('Missing organization_id or status');
    }

    if (!['active', 'inactive', 'suspended', 'pending'].includes(status)) {
      throw new Error('Unsupported status');
    }

    // The platform evidence shelf is not a gym: it has no members to suspend,
    // and its audit row would be filed where no account can read it.
    if (isPlatformLibraryOrganization(organizationId)) {
      throw new Error('Unsupported organization_id');
    }

    // F-085: closing, holding or un-opening Root or the gym this session is
    // signed in to signs out everyone homed there. The platform owner can sign
    // back in and reopen it; nobody else can. Opening stays allowed.
    if (
      status !== 'active'
      && (organizationId === getPilotDefaultOrganizationId() || organizationId === principal.organizationId)
    ) {
      throw new Error(
        'Unsupported: Root and the gym you are signed in to cannot be closed, put on hold or marked not open yet from this desk',
      );
    }

    await setOrganizationStatus(organizationId, status);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      // The organization acted ON, not the actor's own: the row has to appear
      // in the log of the gym whose status just changed.
      organization_id: organizationId,
      entity_type: 'organization',
      entity_id: organizationId,
      details: { status },
    });

    return NextResponse.json({ ok: true, organization_id: organizationId, status });
  } catch (error) {
    return jsonError(error);
  }
}
