import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { roleEquals } from '@/src/server/pilot/roleAlias';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { markDrillFloorTested } from '@/src/server/pilot/drillFloorValidations';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// A coach marks a draft reference drill floor-tested for THEIR gym
// (OD-2026-10-06-026 ruling 3: "They stay drafts until a coach marks them
// floor-tested"). The mark is what lets this gym adopt the draft; it changes
// nothing on the reference drill itself and adopts nothing.
//
// WHO. The two roles the owner named, and only of the session's organization:
// a coach, or the gym's own admin. platform_owner reads coaching content under
// the reader policy and is refused here, as it is for promoting -- a floor test
// is something a gym's own people did on that gym's floor. The gate constant
// is registered in coachingContentAccess.test.ts's PERMITTED_GATE_CONSTANTS so
// the role sweeps police this file too.
//
// POST-only and its own file, for the same reason drills/promote is: the gate
// sweep counts the author gates on drills/route.ts.

// Declared here, as the gate sweep requires of a route-local role list, and
// asserted identical to drillFloorValidations.FLOOR_VALIDATOR_ROLES (and so to
// the table's CHECK) by route.test.ts, so the two cannot drift apart.
const FLOOR_VALIDATOR_ROLES = ['coach', 'organization_admin'] as const;

function requireText(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Missing ${field}`);
  }
  return raw.trim();
}

function optionalNote(raw: unknown): string {
  if (raw === undefined || raw === null) {
    return '';
  }
  if (typeof raw !== 'string') {
    throw new Error('Unsupported note');
  }
  return raw.trim();
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...FLOOR_VALIDATOR_ROLES]);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const referenceDrillId = requireText(body.reference_drill_id, 'reference_drill_id');
    const note = optionalNote(body.note);

    // The organization is the session's, never the body's. The role is stored
    // in its canonical spelling: a legacy 'admin' account IS the gym's admin
    // (roleAlias.ts) and the table CHECK names organization_admin.
    const validation = await markDrillFloorTested({
      organizationId: principal.organizationId,
      drillId: referenceDrillId,
      validatedByAccountId: principal.accountId,
      validatedByRole: roleEquals(principal.role, 'organization_admin') ? 'organization_admin' : 'coach',
      note,
    });

    // Another gym's reference drill reads as absent, answered as a plain
    // not-found so this route cannot be used to discover which ids exist.
    if (!validation) {
      return hiddenNotFound();
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'reference_drill',
      entity_id: validation.drill_id,
      details: { action: 'floor_tested', validation_id: validation.validation_id },
    });

    return NextResponse.json(
      { ok: true, organization_id: principal.organizationId, floor_tested: validation },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
