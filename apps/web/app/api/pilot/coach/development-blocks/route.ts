import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { getCoachDisplayName } from '@/src/server/pilot/achievements';
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
import {
  listDevelopmentBlockTargetOptions,
  resolveDevelopmentBlockTarget,
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

/**
 * Who wrote each block, as a person's name rather than as an account id.
 *
 * The surface used to print `created_by_account_id` straight to the screen --
 * `Written by acct-coach-a`. That is not attribution; it is the absence of it
 * shown to a coach who then cannot tell which colleague planned the block they
 * are looking at.
 *
 * getCoachDisplayName is the platform's ONE answer to this and is reused
 * rather than reimplemented. Its own header explains what it does and why:
 * `pilot.accounts` carries no display-name column today, so the local part of
 * the login address is the best true thing available, and when accounts grow a
 * real name that function is the single place to change. A second derivation
 * here would be a second place to forget.
 *
 * RESOLVED ONCE PER AUTHOR, not once per block. A coach looking at their own
 * athlete's history is looking at blocks they mostly wrote themselves, so the
 * naive per-row lookup would issue the same query a dozen times for one
 * answer. The map is built from the distinct ids actually present.
 */
async function withAuthorNames<T extends { created_by_account_id: string }>(
  organizationId: string,
  blocks: readonly T[],
): Promise<Array<T & { created_by_name: string }>> {
  const distinctIds = Array.from(new Set(blocks.map((block) => block.created_by_account_id)));
  const names = new Map<string, string>();
  await Promise.all(distinctIds.map(async (accountId) => {
    names.set(accountId, await getCoachDisplayName(organizationId, accountId));
  }));

  /* The id stays on the row beside the name. The name is derived and the id is
     the fact -- a caller that needs to know WHICH ACCOUNT authored something,
     rather than what to call them, must not be forced to reverse a display
     string to get it. */
  return blocks.map((block) => ({
    ...block,
    created_by_name: names.get(block.created_by_account_id) ?? 'Your coach',
  }));
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
      /* Kept even though listDevelopmentBlocksForAthlete now makes the same
         check itself. The two answers differ on purpose: the module returns
         [] because a data-layer read must not disclose that a block exists
         for someone else's athlete, while this route owes an authorized
         coach a 403 rather than an empty list that reads as "this athlete
         has no plan". Belt and braces, with the braces load-bearing. */
      await assertActorCanAccessAthlete(principal, athleteId);
      const rows = await listDevelopmentBlocksForAthlete(principal, athleteId);
      const blocks = await withAuthorNames(
        principal.organizationId,
        await withTargets(principal.organizationId, rows),
      );
      return NextResponse.json({ ok: true, blocks }, { headers: { 'Cache-Control': 'no-store' } });
    }

    /* The landing view's scope is the data layer's, not a second copy of it.
       This route used to hand listDevelopmentBlocks an organization id and
       then re-derive a coach's reach with athleteIdsForCoach, because the
       module read the whole gym and the filtering had to happen somewhere.
       listDevelopmentBlocks now takes the actor and filters through
       accessibleAthleteIds -- assertActorCanAccessAthlete's batched
       counterpart -- so the re-derivation is gone rather than duplicated.

       The target enrichment stays: which fixture a block names is not an
       access question, and resolving it here keeps every reader out of the
       business of knowing which of two competition tables to look in. */
    const rows = await listDevelopmentBlocks(principal);
    const blocks = await withAuthorNames(
      principal.organizationId,
      await withTargets(principal.organizationId, rows),
    );
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
      actor: principal,
      athleteId,
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
    const existing = await getDevelopmentBlock(principal, blockId);
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

    /* PARSED BEFORE ANY WRITE. It used to be parsed after the field update
       had already committed, so a patch carrying good fields and a malformed
       target returned 400 with the title, dates, status and updated_at
       already moved -- and the caller, told it failed, would retry. Found by
       review on #771. */
    const target = Object.prototype.hasOwnProperty.call(body, 'target')
      ? parseTargetInput(body.target)
      : undefined;

    const patch: DevelopmentBlockPatch = {
      ...(trimmedString(body.title) !== undefined ? { title: trimmedString(body.title) } : {}),
      ...(trimmedString(body.training_emphasis) !== undefined
        ? { trainingEmphasis: trimmedString(body.training_emphasis) }
        : {}),
      ...(trimmedString(body.starts_on) !== undefined ? { startsOn: trimmedString(body.starts_on) } : {}),
      ...(trimmedString(body.ends_on) !== undefined ? { endsOn: trimmedString(body.ends_on) } : {}),
      ...(status ? { status: status as DevelopmentBlockStatus } : {}),
      // Omitted when the caller said nothing about it, so the block keeps the
      // target it has. Written by the SAME statement as the fields.
      ...(target ? { target } : {}),
    };

    /* ONE write for the fields and the target together. These were two calls
       until review on #771 pointed out what that costs: a target that failed
       its foreign key left the field changes committed, and the caller was
       told the request failed. Now either the whole patch lands or none of
       it does, and the database's own single-target check is the backstop
       rather than the mechanism. */
    const block = await updateDevelopmentBlock(principal, blockId, patch);
    if (!block) {
      return NextResponse.json({ error: 'Development block not found.' }, { status: 404 });
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
