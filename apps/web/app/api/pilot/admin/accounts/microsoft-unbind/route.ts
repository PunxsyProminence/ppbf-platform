import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import { unbindMicrosoftIdentity } from '@/src/server/pilot/microsoftIdentityUnbind';

export const runtime = 'nodejs';

/**
 * CL-A19 recovery, organization admin side: clears one member's Microsoft
 * binding so their next sign-in binds whichever directory user now holds the
 * address (a deleted and re-created Entra user gets a new oid, and every
 * sign-in is refused until this runs). The organization is the session's,
 * never the request's; unbindMicrosoftIdentity limits the target to an active
 * member of it, refuses the platform owner and the caller's own account, and
 * writes the audit row in the same transaction as the clear.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    requireRole(principal, ['organization_admin']);

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
