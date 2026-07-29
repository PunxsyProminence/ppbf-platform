import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { getBoardSummary } from '@/src/server/pilot/boardSummary';
import { queryOne } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getGrowthMetrics } from '@/src/server/pilot/shadowMetrics';

export const runtime = 'nodejs';

function toBooleanMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, boolean> = {};

  for (const [key, rawValue] of Object.entries(source)) {
    if (typeof rawValue === 'boolean') {
      result[key] = rawValue;
    }
  }

  return result;
}

function toStringArrayMap(value: unknown): Record<string, string[]> {
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

// Read-only, cross-organization by design: a platform_owner views any single
// gym's operational summary here by explicit organization_id, never their own
// principal.organizationId. Reuses the exact same aggregate functions the
// board/summary and shadow/metrics routes already call for a single org --
// no new business logic, and every metric here is already k-anonymity gated
// (see boardSummary.ts) with no PHI involved.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const organizationId = request.nextUrl.searchParams.get('organization_id')?.trim() || '';
    if (!organizationId) {
      throw new Error('Missing organization_id');
    }

    const [board, growth, capabilityRow, trackRow] = await Promise.all([
      getBoardSummary(organizationId),
      getGrowthMetrics(organizationId),
      queryOne<{ capability_access: unknown }>(
        `select capability_access from pilot.admin_gym_capability_access where organization_id = $1`,
        [organizationId],
      ),
      queryOne<{ assignments: unknown }>(
        `select assignments from pilot.admin_track_assignments where organization_id = $1`,
        [organizationId],
      ),
    ]);

    return NextResponse.json({
      ok: true,
      organization_id: organizationId,
      board,
      growth,
      capabilityAccess: toBooleanMap(capabilityRow?.capability_access),
      trackAssignments: toStringArrayMap(trackRow?.assignments),
    });
  } catch (error) {
    return jsonError(error);
  }
}
