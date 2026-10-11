import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { queryOne, query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The registry is one gym's own list, read and saved from /admin, so this is
// gym work: platform_owner is refused on both verbs (OD-2026-10-10-004 ruling
// 3). It used to pass, and could name another gym with organization_id; no
// screen ever sent one. Every caller now reads and writes the gym of its own
// session, and an organization_id in the request is ignored.
const CAPABILITY_ROLES = ['organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...CAPABILITY_ROLES]);

    const row = await queryOne<{ capabilities: unknown }>(
      `select capabilities
       from pilot.admin_capability_registry
       where organization_id = $1`,
      [principal.organizationId],
    );

    return NextResponse.json({
      ok: true,
      capabilities: Array.isArray(row?.capabilities) ? row?.capabilities : [],
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...CAPABILITY_ROLES]);

    const body = (await request.json()) as { capabilities?: unknown };
    if (!Array.isArray(body.capabilities)) {
      throw new Error('capabilities must be an array');
    }

    await query(
      `insert into pilot.admin_capability_registry (
         organization_id,
         capabilities,
         updated_by_account_id,
         updated_at
       ) values ($1,$2,$3,now())
       on conflict (organization_id) do update
       set capabilities = excluded.capabilities,
           updated_by_account_id = excluded.updated_by_account_id,
           updated_at = now()`,
      [principal.organizationId, JSON.stringify(body.capabilities), principal.accountId],
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
