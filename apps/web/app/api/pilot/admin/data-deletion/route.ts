import { deleteAthleteRecord, deleteGuardianAccount } from '@/src/server/pilot/dataDeletion';
import { requireMicrosoftAuthenticatedPrincipal, jsonError } from '@/src/server/pilot/http';
import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';

/**
 * DELETE /api/pilot/admin/data-deletion
 *
 * Deletes an athlete or guardian account and marks all linked data for deletion.
 * Organization admin only.
 *
 * Request body:
 * {
 *   "entityType": "athlete" | "guardian",
 *   "entityId": "ath-123" | "acct-456",
 *   "reason": "Athlete withdrew" (optional)
 * }
 */
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);

    if (!isOrganizationAdminRole(principal.role)) {
      // jsonError's first parameter is dispatched on TYPE (Error vs. anything
      // else), not read as free text -- a plain string always fails its
      // `instanceof Error` check and the real message here gets replaced by
      // the hardcoded 'Unknown server error' before the caller ever sees it.
      // Wrapping in Error is what lets the actual reason survive.
      return jsonError(new Error('Forbidden: role not allowed'), 403);
    }

    const body = (await request.json()) as {
      entityType: 'athlete' | 'guardian';
      entityId: string;
      reason?: string;
    };

    if (!body.entityType || !body.entityId) {
      return jsonError(new Error('Missing entityType or entityId'), 400);
    }

    if (body.entityType !== 'athlete' && body.entityType !== 'guardian') {
      return jsonError(new Error('entityType must be "athlete" or "guardian"'), 400);
    }

    const result =
      body.entityType === 'guardian'
        ? await deleteGuardianAccount(
            {
              accountId: principal.accountId,
              role: principal.role,
              organizationId: principal.organizationId,
            },
            body.entityId,
            body.reason,
          )
        : await deleteAthleteRecord(
            {
              accountId: principal.accountId,
              role: principal.role,
              organizationId: principal.organizationId,
            },
            body.entityId,
            body.reason,
          );

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    // Same Error-wrapping fix as above: these two branches already computed
    // the right status themselves, they just need the real message to
    // survive the trip through jsonError.
    if (message.includes('Forbidden')) {
      return jsonError(new Error(message), 403);
    }

    if (message.includes('Not found')) {
      return jsonError(new Error(message), 404);
    }

    // Passed through directly rather than logged here and re-wrapped: this
    // is a right-to-be-forgotten route deleting PII for a minor/guardian, and
    // jsonError's own fallbackStatus===500 branch already logs a
    // sanitized {errorClass, code} pair rather than the raw error object --
    // the same safe pattern every other route's generic-failure branch
    // relies on. A local `console.error('Data deletion error:', error)` here
    // would have logged whatever properties the underlying failure carried
    // (a unique-constraint violation can carry the colliding value itself),
    // with no sanitization layer to catch it.
    return jsonError(error, 500);
  }
}
