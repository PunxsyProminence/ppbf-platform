import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Entity types this general-purpose audit reader must never hand a coach,
// because a dedicated route already made a narrower, deliberate decision
// about what coaches may see of that entity: training-holds/route.ts scopes
// coach reads to their own assigned athletes ("no org-wide hold roster"),
// but this route's `select *` has no per-athlete scoping at all. Without
// this list, any coach could recover the excluded roster -- including a
// hold's reason_category ('medical'/'behavioral', a health/conduct signal)
// -- simply by posting {entity_type: 'training_hold'} here instead. Extend
// this list, don't weaken the dedicated route's gate, if another safety
// entity type ever writes audit events a coach should not enumerate freely.
const COACH_EXCLUDED_ENTITY_TYPES = new Set(['training_hold']);

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const body = (await request.json()) as {
      entity_type?: string;
      entity_id?: string;
      limit?: number;
    };

    const entityType = body.entity_type?.trim() || null;
    if (principal.role === 'coach' && entityType && COACH_EXCLUDED_ENTITY_TYPES.has(entityType)) {
      throw new Error('Forbidden: role not allowed to read this entity type');
    }

    const limit = Math.max(1, Math.min(100, Number(body.limit ?? 20)));

    const rows = await query(
      `select *
       from pilot.audit_events
       where organization_id = $1
         and ($2::text is null or entity_type = $2)
         and ($3::text is null or entity_id = $3)
         and ($5::boolean is not true or entity_type <> all($4::text[]))
       order by created_at desc
       limit $6`,
      [
        principal.organizationId,
        entityType,
        body.entity_id?.trim() || null,
        [...COACH_EXCLUDED_ENTITY_TYPES],
        principal.role === 'coach',
        limit,
      ],
    );

    return NextResponse.json({ ok: true, events: rows });
  } catch (error) {
    return jsonError(error);
  }
}
