import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { createBehaviourKey, listBehaviourKeys } from '@/src/server/pilot/behaviourObservations';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The gym's shared list of behaviour names (lane L49; Jason 2026-10-18 Q1, "A:
// Shared growing list"). Staff read it and any staff member adds to it; each
// name sits under one skill code. A name names a behaviour, not an athlete, so
// the list is gym-wide and carries no athlete data. A name is never re-worded
// or deleted once made (the table's own guard): a coach retires it and adds a
// new one.

const BEHAVIOUR_KEY_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...BEHAVIOUR_KEY_ROLES]);
    const keys = await listBehaviourKeys(principal.organizationId);
    return NextResponse.json({ ok: true, keys });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...BEHAVIOUR_KEY_ROLES]);
    // A body of null, a number or a list is not a request: read as empty, refused below.
    const parsed: unknown = await request.json().catch(() => null);
    const body = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    if (typeof body.behaviourKey !== 'string' || typeof body.label !== 'string' || typeof body.skillId !== 'string') {
      return NextResponse.json({ ok: false, error: 'behaviourKey, label and skillId are required.' }, { status: 400 });
    }
    const key = await createBehaviourKey({
      organizationId: principal.organizationId,
      behaviourKey: body.behaviourKey,
      label: body.label,
      skillId: body.skillId,
      createdByAccountId: principal.accountId,
    });
    return NextResponse.json({ ok: true, key }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
