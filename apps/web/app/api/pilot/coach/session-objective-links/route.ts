import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { getDevelopmentBlock } from '@/src/server/pilot/athleteDevelopmentBlocks';
import { listObjectivesForBlock } from '@/src/server/pilot/athleteDevelopmentBlockObjectives';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  linkSessionToObjective,
  listObjectiveLinksForBlock,
  listObjectivesForSessionBlock,
  unlinkSessionFromObjective,
} from '@/src/server/pilot/sessionObjectiveLinks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Which Full Spectrum objectives a coach says a delivered session addressed.
 *
 * EVERY PATH IS GATED ON THE BLOCK, AND ONLY ON THE BLOCK. An objective lives
 * inside exactly one block, and a block is a record about one minor, so
 * "may this caller see this objective" is the same question as "may this
 * caller open its block" -- which getDevelopmentBlock answers for the actor,
 * with "no such block" and "not your athlete" deliberately indistinguishable.
 * There is no second copy of that rule here, and no path reaches an objective
 * without going through it.
 *
 * THE BLOCK ID IS ALWAYS REQUIRED, INCLUDING WHERE IT LOOKS REDUNDANT. A
 * group session may serve several children's blocks at once, so "every
 * objective this class addressed" would hand back objectives belonging to
 * children the caller has not been cleared for. Every read here is therefore
 * per block: the caller names the block, the block is cleared, and the answer
 * is confined to it. That is why the session-side read takes a block_id it
 * could in principle have looked up.
 *
 * NOTHING IS INFERRED. A link exists because a coach said so -- never because
 * a session's date fell inside the block's window, because its drills sound
 * like the objective's domain, or because the words match.
 *
 * NOTHING IS COUNTED, and this is the surface where that matters most in the
 * whole lane. Objectives carry a domain, so a tally here is one GROUP BY from
 * a per-domain coverage chart about a child's training, and a step further
 * from an objective completed because enough sessions pointed at it. No
 * response carries a count, a coverage figure, a weight or a percentage. An
 * objective with no linked sessions means NOBODY RECORDED A LINK -- not that
 * the domain was neglected -- and no surface over this route may render it as
 * a finding.
 */

const LINK_ROLES = ['coach', 'organization_admin', 'admin'] as const;

function trimmedParam(request: NextRequest, name: string): string {
  return request.nextUrl.searchParams.get(name)?.trim() ?? '';
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...LINK_ROLES]);

    const blockId = trimmedParam(request, 'block_id');
    if (!blockId) {
      throw new ValidationError(
        'block_id is required.',
        'SESSION_OBJECTIVE_LINK_INVALID',
      );
    }

    // The one gate. Null covers both "no such block" and "not your athlete".
    const block = await getDevelopmentBlock(principal, blockId);
    if (!block) {
      return NextResponse.json({ ok: false, error: 'Block not found.' }, { status: 404 });
    }

    const runId = trimmedParam(request, 'run_id');
    if (runId) {
      // What this one session addressed, within this one block.
      const objectives = await listObjectivesForSessionBlock(
        principal.organizationId,
        runId,
        blockId,
      );
      return NextResponse.json(
        { ok: true, objectives },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    /* The block-wide view: every objective the block has, and every link
       across its sessions. Both are returned raw and separately rather than
       stitched into "objective -> sessions" here, because the join is a
       rendering decision -- and because an objective with an empty list must
       stay visibly an objective with no recorded links, not a hole in a
       derived structure. */
    const [objectives, links] = await Promise.all([
      listObjectivesForBlock(principal, blockId),
      listObjectiveLinksForBlock(principal.organizationId, blockId),
    ]);

    return NextResponse.json(
      { ok: true, objectives, links },
      { headers: { 'Cache-Control': 'no-store' } },
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
    const objectiveId = typeof body?.objective_id === 'string' ? body.objective_id.trim() : '';
    const blockId = typeof body?.block_id === 'string' ? body.block_id.trim() : '';
    if (!runId || !objectiveId || !blockId) {
      throw new ValidationError(
        'run_id, objective_id and block_id are all required.',
        'SESSION_OBJECTIVE_LINK_INVALID',
      );
    }

    const block = await getDevelopmentBlock(principal, blockId);
    if (!block) {
      return NextResponse.json({ ok: false, error: 'Block not found.' }, { status: 404 });
    }

    /* block_id is used ONLY to clear the caller. It is deliberately not
       passed on: the module establishes the objective's real parent itself,
       so a body naming a block the caller can open and an objective belonging
       to one they cannot gets nothing -- the module's own SQL requires the
       objective and the block link to agree, and the database's composite key
       requires it again. */
    const result = await linkSessionToObjective({
      organizationId: principal.organizationId,
      runId,
      objectiveId,
      linkedByAccountId: principal.accountId,
    });

    if (!result) {
      /* One of: the objective is not in this organization, it belongs to a
         different block than the one this session supports, or the session
         was never linked to that block at all. Indistinguishable on purpose
         -- telling them apart would say whether an objective id exists. */
      return NextResponse.json(
        { ok: false, error: 'That objective is not on a block this session supports.' },
        { status: 404 },
      );
    }

    // 200 rather than 201 when it already existed: the second click asked for
    // a state that is already true.
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
    const objectiveId = trimmedParam(request, 'objective_id');
    const blockId = trimmedParam(request, 'block_id');
    if (!runId || !objectiveId || !blockId) {
      throw new ValidationError(
        'run_id, objective_id and block_id are all required.',
        'SESSION_OBJECTIVE_LINK_INVALID',
      );
    }

    // Unlinking is a write about this block, gated exactly as linking is.
    const block = await getDevelopmentBlock(principal, blockId);
    if (!block) {
      return NextResponse.json({ ok: false, error: 'Block not found.' }, { status: 404 });
    }

    /* blockId is passed, not just checked. The block cleared two lines above
       is the block the delete is scoped to; without it the authorization was
       proved about one block and spent on another. */
    const removed = await unlinkSessionFromObjective(
      principal.organizationId,
      runId,
      objectiveId,
      blockId,
    );
    // `removed: false` means there was nothing to remove, which is the state
    // the caller asked for either way. Not an error.
    return NextResponse.json({ ok: true, removed });
  } catch (error) {
    return jsonError(error);
  }
}
