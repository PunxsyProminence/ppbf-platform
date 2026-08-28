import { NextResponse, type NextRequest } from 'next/server';

import {
  assertActorCanAccessAthlete,
  athleteIdsForCoach,
  isOrganizationAdminRole,
  requireRole,
} from '@/src/server/pilot/access';
import {
  createDevelopmentBlock,
  getDevelopmentBlock,
  listDevelopmentBlocks,
  listDevelopmentBlocksForAthlete,
  updateDevelopmentBlock,
  type DevelopmentBlockPatch,
  type DevelopmentBlockStatus,
  DEVELOPMENT_BLOCK_STATUSES,
} from '@/src/server/pilot/athleteDevelopmentBlocks';
import type { PilotRole } from '@/src/server/pilot/contracts';
import {
  listDevelopmentBlockTargetOptions,
  resolveDevelopmentBlockTarget,
  setDevelopmentBlockTarget,
  type DevelopmentBlockTargetInput,
  type ResolvedDevelopmentBlockTarget,
} from '@/src/server/pilot/athleteDevelopmentBlockTargets';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Coach-authored multi-week development blocks for one athlete.
 *
 * THE FOUNDATION DELIBERATELY LEFT THIS DECISION OPEN. athleteDevelopmentBlocks.ts
 * says so in its own header: it refuses a creator with no ACTIVE membership in
 * the block's organization -- the floor every write path here stands on -- and
 * states that "exactly which staff roles may author a block is an owner
 * decision that this slice does not make". This route makes the SMALLEST
 * answer that does not invent policy: the same one the rest of the platform
 * already gives for athlete-scoped staff writes.
 *
 *   Who may call this at all      coach, organization_admin, admin --
 *                                 the same set /api/pilot/coach/athletes and
 *                                 the escalation routes serve.
 *   Which athletes they reach     assertActorCanAccessAthlete, unchanged and
 *                                 uncopied. A coach reaches athletes they are
 *                                 coach of record for plus active, unexpired
 *                                 coverage; an organization admin reaches the
 *                                 organization's athletes. Nothing here
 *                                 re-derives either rule.
 *
 * No role is broadened. platform_owner and board are absent for the reasons
 * assertActorCanAccessAthlete itself gives -- the first is refused
 * organization-private athlete records by default, the second is aggregates
 * only -- so a block, which is a named plan about one child, is not theirs.
 *
 * NO COMPUTED TRAINING SCIENCE. This route stores what a coach typed and reads
 * it back. There is no workload score, no readiness-adjusted volume, no ACWR,
 * no fatigue or injury-risk score, no taper percentage, no periodization
 * classification, and no status that advances itself because a date passed.
 * A block records human planning intent; a derived recommendation would need
 * its own evidence and its own safety contract.
 *
 * THE COMPETITION TARGET DOES NOT CHANGE THAT. A block may name the event it
 * is preparing for -- Open Question 2 of module 036's engine-unlock proposal,
 * answered (a) -- and the answer's own words bound it: "as a target date only
 * (name and date, nothing else), leaving both competition tables exactly as
 * skeletal as they are today". Naming a target here derives no taper, no
 * peak, no volume curve and no weight plan, and nothing reads the target back
 * as a training input. It says when the coach is aiming.
 */

const AUTHOR_ROLES = ['coach', 'organization_admin', 'admin'] as const;

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The `target` key on a PATCH body, validated into the module's own input
 * type.
 *
 * `null` clears the target. An object names one: `{ kind, id }`. Anything
 * else is refused rather than coerced -- a malformed target on a plan about
 * a child should fail loudly, not quietly become "no target", which a coach
 * would read as having cleared something they were trying to set.
 *
 * The two kinds are named explicitly rather than passed through, so a body
 * carrying an unknown kind cannot reach the data layer at all.
 */
function parseTargetInput(value: unknown): DevelopmentBlockTargetInput {
  if (value === null) {
    return { kind: 'none' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(
      'A development block target must be an object naming a kind and an id, or null to clear it.',
      'DEVELOPMENT_BLOCK_TARGET_INVALID',
    );
  }
  const candidate = value as { kind?: unknown; id?: unknown };
  if (candidate.kind === 'none') {
    return { kind: 'none' };
  }
  if (candidate.kind !== 'competition' && candidate.kind !== 'wrestling_event') {
    throw new ValidationError(
      "A development block target's kind must be 'competition', 'wrestling_event', or 'none'.",
      'DEVELOPMENT_BLOCK_TARGET_INVALID',
    );
  }
  if (typeof candidate.id !== 'string' || !candidate.id.trim()) {
    throw new ValidationError(
      'A development block target needs the id of the competition or event it names.',
      'DEVELOPMENT_BLOCK_TARGET_INVALID',
    );
  }
  return { kind: candidate.kind, id: candidate.id };
}

/**
 * A coach's blocks across every athlete they may reach, for the landing view.
 *
 * Filtered by the access contract rather than read per-athlete: the ids come
 * from athleteIdsForCoach, and a block whose athlete is not in that set never
 * enters the response. An organization admin reads the organization's blocks,
 * which is what listDevelopmentBlocks already returns.
 */
async function blocksInScope(
  organizationId: string,
  role: PilotRole,
  accountId: string,
) {
  const all = await listDevelopmentBlocks(organizationId);
  if (isOrganizationAdminRole(role)) {
    return all;
  }
  const reachable = new Set(await athleteIdsForCoach(organizationId, accountId));
  return all.filter((block) => reachable.has(block.athlete_id));
}

/**
 * Each block with its target resolved, or `target: null` when it names none.
 *
 * Resolved here rather than by the client so no surface has to know which of
 * two skeletal competition tables a block happens to point at, and so the
 * "sanctioning body where stored" rule -- null for a wrestling event, whose
 * table has no such column -- has one answer instead of one per reader.
 */
async function withTargets<T extends { target_competition_id: string | null; target_wrestling_event_id: string | null }>(
  organizationId: string,
  blocks: readonly T[],
): Promise<Array<T & { target: ResolvedDevelopmentBlockTarget | null }>> {
  return Promise.all(blocks.map(async (block) => ({
    ...block,
    target: await resolveDevelopmentBlockTarget(organizationId, block),
  })));
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...AUTHOR_ROLES]);

    /* The picker. Competitions and league events are organization fixtures
       carrying no athlete data, so this branch is organization-scoped and
       deliberately not athlete-gated -- which BLOCK a target may be attached
       to is the athlete question, and PATCH answers it against that block's
       own athlete. */
    if (request.nextUrl.searchParams.get('targets') === 'options') {
      const options = await listDevelopmentBlockTargetOptions(principal.organizationId);
      return NextResponse.json({ ok: true, options }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();

    if (athleteId) {
      // The gate, before the read. A caller who may not reach this athlete
      // learns nothing about whether they have blocks -- or exist.
      await assertActorCanAccessAthlete(principal, athleteId);
      const rows = await listDevelopmentBlocksForAthlete(principal.organizationId, athleteId);
      const blocks = await withTargets(principal.organizationId, rows);
      return NextResponse.json({ ok: true, blocks }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const rows = await blocksInScope(
      principal.organizationId,
      principal.role,
      principal.accountId,
    );
    const blocks = await withTargets(principal.organizationId, rows);
    return NextResponse.json({ ok: true, blocks }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...AUTHOR_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;

    const athleteId = trimmedString(body.athlete_id)?.trim();
    if (!athleteId) {
      throw new ValidationError('A development block needs an athlete_id.', 'DEVELOPMENT_BLOCK_INVALID');
    }

    /* The organization is the principal's, always. A client-supplied
       organization_id is not merely ignored here -- accepting one at all is
       how a write crosses a tenant boundary, so it is never read. */
    await assertActorCanAccessAthlete(principal, athleteId);

    const status = trimmedString(body.status);
    if (status && !(DEVELOPMENT_BLOCK_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError(`Unknown block status '${status}'.`, 'DEVELOPMENT_BLOCK_INVALID');
    }

    const block = await createDevelopmentBlock({
      organizationId: principal.organizationId,
      athleteId,
      createdByAccountId: principal.accountId,
      title: trimmedString(body.title) ?? '',
      trainingEmphasis: trimmedString(body.training_emphasis) ?? '',
      startsOn: trimmedString(body.starts_on) ?? '',
      endsOn: trimmedString(body.ends_on) ?? '',
      status: status as DevelopmentBlockStatus | undefined,
    });

    /* createDevelopmentBlock answers null for an athlete outside this
       organization. assertActorCanAccessAthlete above has already refused
       that case, so reaching here means the roster changed underneath the
       request -- a 404 on the athlete, not a 500 and not a silent success. */
    if (!block) {
      return NextResponse.json({ error: 'Athlete not found in this organization.' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, block }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...AUTHOR_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;

    const blockId = trimmedString(body.block_id)?.trim();
    if (!blockId) {
      throw new ValidationError('A development block update needs a block_id.', 'DEVELOPMENT_BLOCK_INVALID');
    }

    /* Read the block FIRST, and authorize against the athlete the STORED row
       names -- never against an athlete_id the caller sent. A patch carrying
       someone else's athlete id would otherwise authorize against an athlete
       the caller can reach while writing to a block about one they cannot.
       updateDevelopmentBlock does not accept an athlete_id at all, which is
       the other half of the same guard. */
    const existing = await getDevelopmentBlock(principal.organizationId, blockId);
    if (!existing) {
      // Also the answer for a block in another organization: a caller must
      // not be able to tell those two apart.
      return NextResponse.json({ error: 'Development block not found.' }, { status: 404 });
    }
    await assertActorCanAccessAthlete(principal, existing.athlete_id);

    const status = trimmedString(body.status);
    if (status && !(DEVELOPMENT_BLOCK_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError(`Unknown block status '${status}'.`, 'DEVELOPMENT_BLOCK_INVALID');
    }

    const patch: DevelopmentBlockPatch = {
      ...(trimmedString(body.title) !== undefined ? { title: trimmedString(body.title) } : {}),
      ...(trimmedString(body.training_emphasis) !== undefined
        ? { trainingEmphasis: trimmedString(body.training_emphasis) }
        : {}),
      ...(trimmedString(body.starts_on) !== undefined ? { startsOn: trimmedString(body.starts_on) } : {}),
      ...(trimmedString(body.ends_on) !== undefined ? { endsOn: trimmedString(body.ends_on) } : {}),
      ...(status ? { status: status as DevelopmentBlockStatus } : {}),
    };

    let block = await updateDevelopmentBlock(principal.organizationId, blockId, patch);
    if (!block) {
      return NextResponse.json({ error: 'Development block not found.' }, { status: 404 });
    }

    /* The competition/event target, set or cleared only when the caller
       actually said something about it. An absent `target` key leaves the
       block's target exactly as it was -- the same omitted-means-unchanged
       rule the field patch above follows, and the reason target is its own
       key rather than two nullable columns in the patch: `null` has to be
       able to mean "clear this", which it cannot when null is also how a
       field says "I did not mention it". */
    if (Object.prototype.hasOwnProperty.call(body, 'target')) {
      const target = parseTargetInput(body.target);
      const retargeted = await setDevelopmentBlockTarget(
        principal.organizationId,
        blockId,
        target,
      );
      if (!retargeted) {
        return NextResponse.json({ error: 'Development block not found.' }, { status: 404 });
      }
      block = retargeted;
    }

    return NextResponse.json({
      ok: true,
      block: {
        ...block,
        target: await resolveDevelopmentBlockTarget(principal.organizationId, block),
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
