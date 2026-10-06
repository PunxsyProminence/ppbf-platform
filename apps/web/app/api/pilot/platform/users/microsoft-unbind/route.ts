import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import { unbindMicrosoftIdentity } from '@/src/server/pilot/microsoftIdentityUnbind';

export const runtime = 'nodejs';

/**
 * CL-A19 recovery, platform owner side: clears one account's Microsoft
 * binding so their next sign-in binds whichever directory user now holds the
 * address (a deleted and re-created Entra user gets a new oid, and every
 * sign-in is refused until this runs). Any account, in any organization,
 * including an organization admin's: this is a platform-level identity act and
 * reads no athlete record. unbindMicrosoftIdentity refuses the caller's own
 * account (the platform owner's own binding is cleared through the bootstrap
 * key) and writes the audit row in the same transaction as the clear.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['platform_owner']);

    const body = (await request.json()) as { account_id?: string };
    const accountId = body.account_id?.trim() || '';
    if (!accountId) {
      throw new Error('Missing account_id');
    }

    const result = await unbindMicrosoftIdentity(principal, accountId);
    return NextResponse.json({ ok: true, account_id: result.accountId, cleared: result.cleared });
  } catch (error) {
    return jsonError(error);
  }
}
