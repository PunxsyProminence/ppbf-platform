import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { sendRunToGymTv, takeRunOffGymTv } from '@/src/server/pilot/gymTvs';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ tvId: string }>;
}

// Which paired TV shows the coach's live session (gym TV lane, S2b).
//
// POST {run_id} sends the caller's own live, "Show on TV" session to this TV. DELETE takes it off.
// Staff only, same two roles as the Paired TVs list. Any coach may choose any of the gym's TVs
// (Jason "A", 2026-10-06: shared gym TVs, one session per TV), but the module refuses a TV that is
// showing ANOTHER coach's live session (TV_IN_USE) rather than taking it over, and it only ever
// sends a run the caller delivers: another coach's run id gets the same 404 as a missing one.
const STAFF_ROLES = ['coach', 'organization_admin'] as const;

function tvIdOf(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_ROLES]);
    const tvId = tvIdOf((await context.params).tvId);
    if (!tvId) {
      return NextResponse.json({ error: 'TV_ID_REQUIRED' }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'BODY_OBJECT_EXPECTED' }, { status: 400 });
    }
    const record = body as Record<string, unknown>;
    const extras = Object.keys(record).filter((k) => k !== 'run_id');
    if (extras.length > 0) {
      return NextResponse.json({ error: `UNEXPECTED_FIELD:${extras.sort().join(',')}` }, { status: 400 });
    }
    if (typeof record.run_id !== 'string' || record.run_id.trim() === '') {
      return NextResponse.json({ error: 'RUN_ID_REQUIRED' }, { status: 400 });
    }

    const tv = await sendRunToGymTv(principal.organizationId, principal.accountId, tvId, record.run_id.trim());
    return NextResponse.json({ tv });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_ROLES]);
    const tvId = tvIdOf((await context.params).tvId);
    if (!tvId) {
      return NextResponse.json({ error: 'TV_ID_REQUIRED' }, { status: 400 });
    }
    const tv = await takeRunOffGymTv(principal.organizationId, principal.accountId, tvId);
    return NextResponse.json({ tv });
  } catch (error) {
    return jsonError(error);
  }
}
