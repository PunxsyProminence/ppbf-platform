import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { listBehaviourNotes } from '@/src/server/pilot/behaviourNotes';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The behaviour notes a coach saved from the Decision Loop (F-070).
// Staff only: coaches and the organization admin of this gym
// (OD-2026-10-10-003 items 3 and 4). No athlete, parent, board, volunteer or
// platform-owner read -- the role gate refuses them before any query runs.
// platform_owner is left out on purpose: assertActorCanAccessAthlete refuses
// it organization-private athlete records by default.
const READERS = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...READERS]);

    const athleteId = (request.nextUrl.searchParams.get('athlete_id') ?? '').trim();
    if (athleteId) {
      if (athleteId.length > 300) {
        throw new Error('Missing athlete_id');
      }
      await assertActorCanAccessAthlete(principal, athleteId);
    }

    const { items, truncated } = await listBehaviourNotes(principal.organizationId, {
      athleteId: athleteId || undefined,
    });
    return NextResponse.json({ ok: true, items, truncated });
  } catch (error) {
    return jsonError(error);
  }
}
