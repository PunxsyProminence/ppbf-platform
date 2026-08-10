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
      return jsonError('Forbidden: role not allowed', 403);
    }

    const body = (await request.json()) as {
      entityType: 'athlete' | 'guardian';
      entityId: string;
      reason?: string;
    };

    if (!body.entityType || !body.entityId) {
      return jsonError('Missing entityType or entityId', 400);
    }

    if (body.entityType !== 'athlete' && body.entityType !== 'guardian') {
      return jsonError('entityType must be "athlete" or "guardian"', 400);
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

    if (message.includes('Forbidden')) {
      return jsonError(message, 403);
    }

    if (message.includes('Not found')) {
      return jsonError(message, 404);
    }

    console.error('Data deletion error:', error);
    return jsonError('Failed to delete data', 500);
  }
}
