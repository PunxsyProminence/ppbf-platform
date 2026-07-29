import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { getBoardSummary, type BoardSummary } from '@/src/server/pilot/boardSummary';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getGrowthMetrics, type GrowthMetrics } from '@/src/server/pilot/shadowMetrics';

export const runtime = 'nodejs';

interface OrganizationRow {
  organization_id: string;
  organization_name: string;
  status: string;
}

interface CapabilityRow {
  organization_id: string;
  capability_access: unknown;
}

interface TrackRow {
  organization_id: string;
  assignments: unknown;
}

interface GymOverviewRow {
  organizationId: string;
  organizationName: string;
  status: string;
  board: BoardSummary | null;
  growth: GrowthMetrics | null;
  capabilityCount: number;
  trackAssignmentCount: number;
  error?: string;
}

function countEnabled(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 0;
  }
  return Object.values(value as Record<string, unknown>).filter((entry) => entry === true).length;
}

function countAssignedTracks(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 0;
  }
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (total, tracks) => total + (Array.isArray(tracks) ? tracks.length : 0),
    0,
  );
}

// All-gyms rollup for the platform owner. Loops the same single-org functions
// every other admin/board screen already calls -- getBoardSummary and
// getGrowthMetrics -- once per organization via Promise.all, rather than new
// cross-org SQL. Safe at pilot scale (no pagination exists anywhere in this
// codebase's org listing, and the schema is literally named "pilot slice").
// Every metric surfaced here is already k-anonymity gated in boardSummary.ts;
// nothing here reaches PHI.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner']);

    const organizations = await query<OrganizationRow>(
      `select organization_id, organization_name, status
       from pilot.organizations
       order by organization_name asc`,
    );

    const [capabilityRows, trackRows] = await Promise.all([
      query<CapabilityRow>(`select organization_id, capability_access from pilot.admin_gym_capability_access`),
      query<TrackRow>(`select organization_id, assignments from pilot.admin_track_assignments`),
    ]);

    const capabilityCountByOrg = new Map(
      capabilityRows.map((row) => [row.organization_id, countEnabled(row.capability_access)]),
    );
    const trackAssignmentCountByOrg = new Map(
      trackRows.map((row) => [row.organization_id, countAssignedTracks(row.assignments)]),
    );

    const gyms: GymOverviewRow[] = await Promise.all(
      organizations.map(async (org) => {
        const capabilityCount = capabilityCountByOrg.get(org.organization_id) ?? 0;
        const trackAssignmentCount = trackAssignmentCountByOrg.get(org.organization_id) ?? 0;
        try {
          const [board, growth] = await Promise.all([
            getBoardSummary(org.organization_id),
            getGrowthMetrics(org.organization_id),
          ]);
          return {
            organizationId: org.organization_id,
            organizationName: org.organization_name,
            status: org.status,
            board,
            growth,
            capabilityCount,
            trackAssignmentCount,
          };
        } catch (error) {
          return {
            organizationId: org.organization_id,
            organizationName: org.organization_name,
            status: org.status,
            board: null,
            growth: null,
            capabilityCount,
            trackAssignmentCount,
            error: error instanceof Error ? error.message : 'Failed to load summary',
          };
        }
      }),
    );

    return NextResponse.json({ ok: true, gyms });
  } catch (error) {
    return jsonError(error);
  }
}
