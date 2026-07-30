import { NextResponse, type NextRequest } from 'next/server';

import { query, queryOne } from '@/src/server/pilot/db';
import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

function toAssignments(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, string[]> = {};

  for (const [key, rawTracks] of Object.entries(source)) {
    if (!Array.isArray(rawTracks)) {
      continue;
    }

    result[key] = rawTracks.filter((item): item is string => typeof item === 'string');
  }

  return result;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner', 'organization_admin', 'admin']);

    const row = await queryOne<{ assignments: unknown }>(
      `select assignments
       from pilot.admin_track_assignments
       where organization_id = $1`,
      [principal.organizationId],
    );

    return NextResponse.json({
      ok: true,
      assignments: toAssignments(row?.assignments),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner', 'organization_admin', 'admin']);

    const body = (await request.json()) as { assignments?: unknown };
    const assignments = toAssignments(body.assignments);

    await query(
      `insert into pilot.admin_track_assignments (
         organization_id,
         assignments,
         updated_by_account_id,
         updated_at
       ) values ($1, $2, $3, now())
       on conflict (organization_id) do update
       set assignments = excluded.assignments,
           updated_by_account_id = excluded.updated_by_account_id,
           updated_at = now()`,
      [principal.organizationId, JSON.stringify(assignments), principal.accountId],
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
