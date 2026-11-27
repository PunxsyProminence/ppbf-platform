import { NextResponse, type NextRequest } from 'next/server';

import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { readRoomNames, setRoomName } from '@/src/server/pilot/roomNames';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The gym's own names for its rooms and card headings (lane W4-9, RN-1b;
 * OW27-11, OW27-40 A; Overwatch approved these permission lines on #2212).
 *
 * GET: any signed-in member, for their own gym only (the organization comes
 * from the session, never from the request). Every member sees the names, so
 * every member's screens read them. The answer is names only: each renamable
 * name, the name it shows, and whether that is the default. Query fields are
 * refused.
 *
 * PUT { name_key, display_name }: the gym admin only (organization_admin, and
 * 'admin', its alias). Platform owner, coach, athlete, parent, board,
 * volunteer and staff are refused. display_name null or blank puts the
 * default back. Any other field or query field is refused. The write and its
 * audit row commit together; the answer is every name after the change.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: this read takes no fields');
    }
    const names = await readRoomNames(principal.organizationId);
    return NextResponse.json({ ok: true, names }, { headers: NO_STORE });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // organization_admin; 'admin' satisfies it too (http.ts requireRole alias).
    requireRole(principal, ['organization_admin']);
    if (request.nextUrl.searchParams.size > 0) {
      throw new ValidationError('Unsupported query: send name_key and display_name in the body only');
    }
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object with name_key and display_name');
    }
    const fields = Object.keys(body).sort();
    if (fields.length !== 2 || fields[0] !== 'display_name' || fields[1] !== 'name_key') {
      throw new ValidationError('Unsupported fields: send name_key and display_name only');
    }
    const { name_key: nameKey, display_name: displayName } = body as { name_key: unknown; display_name: unknown };
    const names = await setRoomName({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      nameKey,
      displayName,
    });
    return NextResponse.json({ ok: true, names }, { headers: NO_STORE });
  } catch (error) {
    return jsonError(error);
  }
}
