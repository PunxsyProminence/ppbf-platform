import { NextResponse, type NextRequest } from 'next/server';

import {
  accessibleAthleteIds,
  assertActorCanAccessAthlete,
  requireRole,
} from '@/src/server/pilot/access';
import { getDevelopmentBlock } from '@/src/server/pilot/athleteDevelopmentBlocks';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  athleteIdsLinkedToRun,
  linkSessionToBlock,
  listBlocksForRun,
  listSelectableRuns,
  listSessionsForBlock,
  unlinkSessionFromBlock,
} from '@/src/server/pilot/sessionBlockLinks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Which delivered session supported which athlete development block.
 *
 * THE TWO DIRECTIONS ARE NOT THE SAME QUESTION, and that is the whole
 * authorization story of this route.
 *
 *   block -> sessions   The caller already named a block, which is a record
 *                       about ONE minor. assertActorCanAccessAthlete decides
 *                       it, on the athlete the STORED block names, exactly as
 *                       every other write and read in this lane does.
 *
 *   session -> blocks   The caller named a RUN, which is a gym-level record
 *                       carrying no athlete id at all -- only a head count
 *                       and who delivered it. Answering it unfiltered would
 *                       turn "which class was this" into "which children in
 *                       that class have development plans", for anyone who
 *                       could name a run id. So the answer is filtered
 *                       through accessibleAthleteIds and a caller sees only
 *                       the blocks of athletes they already reach.
 *
 * Whole-gym roster visibility is not athlete-record authorization, and a
 * session is the surface where the two are easiest to confuse: a coach who
 * delivered the class is not thereby the coach of record for every child in
 * the room.
 *
 * THE PICKER IS DELIBERATELY NOT ATHLETE-GATED. `?runs=options` lists settled
 * sessions in the organization. A delivered session names no athlete, so
 * gating it would require an athlete id this branch has no business asking
 * for -- the same reasoning the competition-target picker records. WHICH
 * BLOCK a session may be attached to is the athlete question, and POST
 * answers it.
 *
 * NOTHING IS INFERRED AND NOTHING IS COUNTED. A link exists because a coach
 * said so; no read here derives one from overlapping dates or attendance, and
 * no response carries a session count, a coverage figure or an adherence
 * percentage. Plan-versus-actual is the build order's NEXT slice and it is
 * not started here -- what this returns is the run's own recorded account of
 * itself, verbatim.
 */

const LINK_ROLES = ['coach', 'organization_admin', 'admin'] as const;

function trimmedParam(request: NextRequest, name: string): string {
  return request.nextUrl.searchParams.get(name)?.trim() ?? '';
}

/**
 * Clears the caller against the athlete the STORED block names, and returns
 * the block.
 *
 * Never the athlete a caller sent: a body carrying a reachable athlete's id
 * would otherwise authorize against that child while writing about one the
 * caller cannot reach. Same rule #767 established for the block routes, and
 * the same reason.
 */
async function authorizeBlock(
  principal: Awaited<ReturnType<typeof requirePrincipal>>,
  blockId: string,
) {
  const block = await getDevelopmentBlock(principal.organizationId, blockId);
  if (!block) return null;
  await assertActorCanAccessAthlete(principal, block.athlete_id);
  return block;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LINK_ROLES]);

    // The picker branch, matched first: it takes no id of either kind.
    if (trimmedParam(request, 'runs') === 'options') {
      const runs = await listSelectableRuns(principal.organizationId);
      return NextResponse.json(
        { ok: true, runs },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const blockId = trimmedParam(request, 'block_id');
    if (blockId) {
      const block = await authorizeBlock(principal, blockId);
      if (!block) {
        return NextResponse.json({ ok: false, error: 'Block not found.' }, { status: 404 });
      }
      const sessions = await listSessionsForBlock(principal.organizationId, blockId);
      return NextResponse.json(
        { ok: true, sessions },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const runId = trimmedParam(request, 'run_id');
    if (runId) {
      /* The filtered direction. The candidate ids are read first, cleared
         through the central contract, and only the permitted subset reaches
         the row read -- so a caller who may reach nobody in that class gets
         an empty list rather than a roster of children with plans. */
      const candidates = await athleteIdsLinkedToRun(principal.organizationId, runId);
      const allowed = await accessibleAthleteIds(principal, candidates);
      const blocks = await listBlocksForRun(
        principal.organizationId,
        runId,
        [...allowed],
      );
      return NextResponse.json(
        { ok: true, blocks },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    throw new ValidationError(
      'One of block_id, run_id or runs=options is required.',
      'SESSION_BLOCK_LINK_INVALID',
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LINK_ROLES]);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const runId = typeof body?.run_id === 'string' ? body.run_id.trim() : '';
    const blockId = typeof body?.block_id === 'string' ? body.block_id.trim() : '';
    if (!runId || !blockId) {
      throw new ValidationError(
        'run_id and block_id are both required.',
        'SESSION_BLOCK_LINK_INVALID',
      );
    }

    const block = await authorizeBlock(principal, blockId);
    if (!block) {
      return NextResponse.json({ ok: false, error: 'Block not found.' }, { status: 404 });
    }

    const result = await linkSessionToBlock({
      // The organization and the author are the SESSION's. A client-supplied
      // organization_id or account id is not read here at all.
      organizationId: principal.organizationId,
      runId,
      blockId,
      linkedByAccountId: principal.accountId,
    });

    if (!result) {
      // The run is not in this organization, or does not exist. The two are
      // indistinguishable on purpose.
      return NextResponse.json({ ok: false, error: 'Session not found.' }, { status: 404 });
    }

    // 200 rather than 201 when the link already existed: a double-click asked
    // for a state that is already true, and reporting "created" twice would
    // be a small lie about what just happened.
    return NextResponse.json(
      { ok: true, link: result.link, created: result.created },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LINK_ROLES]);

    const runId = trimmedParam(request, 'run_id');
    const blockId = trimmedParam(request, 'block_id');
    if (!runId || !blockId) {
      throw new ValidationError(
        'run_id and block_id are both required.',
        'SESSION_BLOCK_LINK_INVALID',
      );
    }

    // Unlinking is a write about this block, so it is gated exactly as
    // linking is -- on the athlete the stored block names.
    const block = await authorizeBlock(principal, blockId);
    if (!block) {
      return NextResponse.json({ ok: false, error: 'Block not found.' }, { status: 404 });
    }

    const removed = await unlinkSessionFromBlock(principal.organizationId, runId, blockId);
    // `removed: false` means there was nothing to remove, which is the state
    // the caller asked for either way. Not an error.
    return NextResponse.json({ ok: true, removed });
  } catch (error) {
    return jsonError(error);
  }
}
