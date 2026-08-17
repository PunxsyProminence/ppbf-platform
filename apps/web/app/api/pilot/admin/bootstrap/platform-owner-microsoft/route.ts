import { NextResponse, type NextRequest } from 'next/server';

import {
  createOrUpdateMicrosoftPlatformOwnerAccount,
  createOrganization,
  getPrimaryOwnerEmail,
} from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';
import { jsonError } from '@/src/server/pilot/http';
import {
  getClientIp,
  checkRateLimit,
  checkDurableRateLimit,
  recordDurableFailedAttempt,
  clearDurableRateLimit,
} from '@/src/server/pilot/rateLimit';
import { bootstrapKeyMatches } from '@/src/server/pilot/security';

export const runtime = 'nodejs';

const ROOT_ORG_NAME = 'PPBF Root Platform Organization';

export async function POST(request: NextRequest) {
  try {
    // The owner identity this route provisions is the same one sign-in
    // accepts, so a bootstrap can never mint an account that cannot log in.
    const primaryOwnerEmail = getPrimaryOwnerEmail();
    const bootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY?.trim() || '';

    if (!bootstrapKey) {
      throw new Error('Missing PPBF_PILOT_BOOTSTRAP_KEY');
    }

    // Shares one per-IP bucket with /api/pilot/admin/bootstrap: both gates
    // guard the same key, so guessing attempts must not get a fresh budget by
    // switching endpoint.
    //
    // Durable, not just volatile: this guards the credential that mints or
    // overwrites the platform_owner account, the highest-privilege identity
    // on the platform. The in-memory limiter alone is per-container --
    // Container Apps runs multiple replicas -- so a guesser splitting
    // requests across replicas, or simply resuming after a deploy, gets an
    // independent budget per replica instead of one fleet-wide budget. Either
    // limiter saying "limited" is enough, the same rule login/activate/
    // magic-link already use. A durable lookup that cannot reach the
    // database returns not-limited rather than throwing, so a blip degrades
    // to the volatile limiter instead of locking bootstrap out entirely.
    const clientIp = getClientIp(request);
    const ipKey = `pin_bootstrap:${clientIp}`;

    const ipLimitCheck = checkRateLimit(ipKey);
    const durableIpCheck = await checkDurableRateLimit(ipKey);
    if (ipLimitCheck.isLimited || durableIpCheck.isLimited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      );
    }

    if (!bootstrapKeyMatches(request.headers, bootstrapKey)) {
      await recordDurableFailedAttempt(ipKey);
      throw new Error('Forbidden: invalid bootstrap key');
    }

    await clearDurableRateLimit(ipKey);

    const body = (await request.json().catch(() => ({}))) as {
      organization_id?: string;
      organization_name?: string;
    };

    const organizationId = body.organization_id?.trim() || getPilotDefaultOrganizationId();
    const organizationName = body.organization_name?.trim() || ROOT_ORG_NAME;

    await createOrganization(organizationId, organizationName, primaryOwnerEmail);

    const result = await createOrUpdateMicrosoftPlatformOwnerAccount({
      loginEmail: primaryOwnerEmail,
      organizationId,
      accountIdHint: primaryOwnerEmail,
    });

    await writePilotAuditEvent({
      event_type: result.created ? 'create' : 'update',
      actor_account_id: result.accountId,
      actor_role: 'platform_owner',
      organization_id: organizationId,
      entity_type: 'account',
      entity_id: result.accountId,
      details: {
        action: 'bootstrap_platform_owner_microsoft',
        login_email: primaryOwnerEmail,
        auth_provider: 'microsoft',
        pin_hash: null,
      },
    });

    return NextResponse.json({
      ok: true,
      action: result.created ? 'created' : 'updated',
      account_id: result.accountId,
      login_email: primaryOwnerEmail,
      auth_provider: 'microsoft',
      role: 'platform_owner',
      organization_id: organizationId,
      active_flag: true,
      pin_hash: null,
    });
  } catch (error) {
    return jsonError(error);
  }
}
