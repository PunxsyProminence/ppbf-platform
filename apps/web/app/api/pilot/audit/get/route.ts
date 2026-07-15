import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const body = (await request.json()) as {
      entity_type?: string;
      entity_id?: string;
      limit?: number;
    };

    const limit = Math.max(1, Math.min(100, Number(body.limit ?? 20)));

    const rows = await query(
      `select *
       from pilot.audit_events
       where organization_id = $1
         and ($2::text is null or entity_type = $2)
         and ($3::text is null or entity_id = $3)
       order by created_at desc
       limit $4`,
      [
        principal.organizationId,
        body.entity_type?.trim() || null,
        body.entity_id?.trim() || null,
        limit,
      ],
    );

    return NextResponse.json({ ok: true, events: rows });
  } catch (error) {
    return jsonError(error);
  }
}
