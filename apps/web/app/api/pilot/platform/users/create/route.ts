import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import {
  createCoachAccount,
  createOrRotateAdminAccount,
  createOrUpdateAthleteAccount,
  createParentAccount,
} from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

const SUPPORTED_CREATE_ROLES: PilotRole[] = ['organization_admin', 'coach', 'athlete', 'parent'];

function assertSupportedCreateRole(role: string): role is 'organization_admin' | 'coach' | 'athlete' | 'parent' {
  return SUPPORTED_CREATE_ROLES.includes(role as PilotRole);
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as {
      organization_id?: string;
      account_id?: string;
      role?: string;
      pin?: string;
      athlete_id?: string;
    };

    const organizationId = body.organization_id?.trim() || '';
    const accountId = body.account_id?.trim() || '';
    const role = body.role?.trim() || '';
    const pin = body.pin?.trim() || '';
    const athleteId = body.athlete_id?.trim() || '';

    if (!organizationId || !accountId || !role || !pin) {
      throw new Error('Missing organization_id, account_id, role, or pin');
    }

    if (!assertSupportedCreateRole(role)) {
      throw new Error('Unsupported role');
    }

    if (role === 'organization_admin') {
      await createOrRotateAdminAccount(accountId, pin, organizationId, 'organization_admin');
    } else if (role === 'coach') {
      await createCoachAccount(accountId, pin, organizationId);
    } else if (role === 'athlete') {
      if (!athleteId) {
        throw new Error('Missing athlete_id for athlete role');
      }
      await createOrUpdateAthleteAccount(accountId, athleteId, pin, organizationId);
    } else {
      await createParentAccount(accountId, pin, organizationId);
    }

    // Each of the create/rotate functions above already assigns the
    // matching organization membership atomically alongside the account
    // upsert.

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: organizationId,
      entity_type: 'account',
      entity_id: accountId,
      details: {
        action: 'platform_owner_create_user',
        role,
        athlete_id: athleteId || null,
      },
    });

    return NextResponse.json({
      ok: true,
      account_id: accountId,
      organization_id: organizationId,
      role,
      athlete_id: athleteId || null,
    });
  } catch (error) {
    return jsonError(error);
  }
}
