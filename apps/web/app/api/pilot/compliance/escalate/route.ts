import { NextResponse, type NextRequest } from 'next/server';

import { escalateViolation } from '@/src/server/pilot/compliance';
import { requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin']);

    const body = (await request.json()) as {
      violation_id?: string;
      escalated_to_role?: string;
      escalation_reason?: string;
      action_required?: string;
    };

    if (!body.violation_id || !body.escalated_to_role) {
      throw new Error('Missing violation_id or escalated_to_role');
    }

    await escalateViolation({
      organizationId: principal.organizationId,
      violationId: body.violation_id,
      escalatedByAccountId: principal.accountId,
      escalatedToRole: body.escalated_to_role,
      escalationReason: body.escalation_reason || 'Policy violation requires escalation',
      actionRequired: body.action_required,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
