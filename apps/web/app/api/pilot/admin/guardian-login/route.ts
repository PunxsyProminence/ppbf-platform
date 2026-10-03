import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { ForbiddenError } from '@/src/server/pilot/errors';
import { moveGuardianToLogin } from '@/src/server/pilot/guardianLoginMove';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * Moves one guardian record to a different parent login, on purpose
 * (OD-2026-09-29-004 R4) -- for a parent who changed their email. Intake
 * refuses this move; this is the deliberate path.
 *
 * An organization admin with a Microsoft sign-in, in their own organization:
 * the organization comes from the session, never the request. The platform
 * owner is not an organization admin and is refused, as it is from every
 * organization-private family record. from_account_id is the login the
 * admin's screen showed; if the record is on another login by now, the move
 * is refused rather than taking it from whoever holds it.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new ForbiddenError('Forbidden: only an organization admin can move a guardian to another login');
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');

    const moved = await moveGuardianToLogin({
      organizationId: principal.organizationId,
      parentId: text(body.parent_id),
      fromAccountId: text(body.from_account_id),
      toAccountId: text(body.to_account_id),
      actor: { accountId: principal.accountId, role: principal.role },
    });

    return NextResponse.json({
      ok: true,
      parent_id: moved.parentId,
      from_account_id: moved.fromAccountId,
      to_account_id: moved.toAccountId,
      athlete_ids: moved.athleteIds,
    });
  } catch (error) {
    return jsonError(error);
  }
}
