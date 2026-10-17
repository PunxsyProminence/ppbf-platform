import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  SUPPORT_ROLES,
  listSupportForStaff,
  recordSupport,
  retireSupport,
} from '@/src/server/pilot/familySupportRecords';

export const runtime = 'nodejs';

// Support the gym gave a family (PH-12b). Org admins and admins only (Q-E);
// the organization is the session's. Nothing is edited or deleted, only retired.

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A JSON object body, or a 400: malformed JSON, an array or a bare value is the caller's mistake. */
async function objectBody(request: NextRequest): Promise<Record<string, unknown>> {
  const parsed: unknown = await request.json().catch(() => undefined);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SUPPORT_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');

    const items = await listSupportForStaff(principal.organizationId, athleteId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SUPPORT_ROLES]);

    const body = await objectBody(request);
    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    if (!athleteId) throw new ValidationError('Missing athlete_id.');

    const item = await recordSupport(principal, athleteId, body.support_kind, body.provided_on);
    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SUPPORT_ROLES]);

    const body = await objectBody(request);
    const recordId = typeof body.record_id === 'string' ? body.record_id.trim() : '';
    if (!UUID_SHAPE.test(recordId)) throw new ValidationError('Missing or malformed record_id.');
    if (body.action !== 'retire') throw new ValidationError("The only change is action: 'retire'.");

    const item = await retireSupport(principal, recordId);
    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
