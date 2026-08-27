import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import {
  getDrillLineage,
  type PilotDrillVersionRow,
} from '@/src/server/pilot/drillVersioning';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The version history of one drill: what it used to say, what it says now, and
// in what order. A reviewer deciding a change proposal needs this to see what
// the previous versions already tried, so it carries the same role set as the
// proposal queue in ../proposals/route.ts.
const DRILL_PROPOSER_ROLES = ['coach', 'organization_admin', 'admin'] as const;

/** Pinned for the reason ../proposals/route.ts records. */
export interface DrillLineageResponse {
  ok: true;
  organization_id: string;
  lineage_id: string;
  versions: PilotDrillVersionRow[];
}

/**
 * Every version of one lineage, oldest first.
 *
 * A lineage with no rows returns an empty list and a 200, not a 404: a lineage
 * id is not a record, it is the key several records share, and this route
 * cannot distinguish "no such lineage" from "a lineage in another gym" without
 * disclosing which. Both read as nothing here, which is the same answer
 * getDrillLineage's own organization-scoped query gives.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DRILL_PROPOSER_ROLES]);

    const lineageId = request.nextUrl.searchParams.get('lineage_id')?.trim();
    if (!lineageId) {
      throw new Error('Missing lineage_id');
    }

    const versions = await getDrillLineage(principal.organizationId, lineageId);

    const body: DrillLineageResponse = {
      ok: true,
      organization_id: principal.organizationId,
      lineage_id: lineageId,
      versions,
    };
    return NextResponse.json(body);
  } catch (error) {
    return jsonError(error);
  }
}
