import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import {
  FULL_SPECTRUM_DOMAINS,
  OBJECTIVE_STATUSES,
  addBlockObjective,
  listObjectivesForBlock,
  setBlockObjectiveStatus,
  type FullSpectrumDomain,
  type ObjectiveStatus,
} from '@/src/server/pilot/athleteDevelopmentBlockObjectives';
import { getDevelopmentBlock } from '@/src/server/pilot/athleteDevelopmentBlocks';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What one development block is trying to move, one row per Full Spectrum
 * domain, in the coach's own words.
 *
 * THE TABLE SHIPPED WITH NOTHING ABLE TO REACH IT. The migration, the module
 * and 27 real-Postgres cases landed in #762; no route and no screen followed,
 * so a coach could write a block's title, emphasis, window and competition
 * target and still had nowhere to say what any of it was FOR. This route is
 * that surface, and it is deliberately the same shape as the blocks route
 * beside it rather than a new idea.
 *
 * ACCESS ARRIVES THROUGH THE BLOCK AND IS NOT RESTATED HERE. An objective
 * carries no athlete_id -- it reaches its athlete through its parent by
 * composite foreign key -- so every module function resolves that parent
 * through getDevelopmentBlock, which has been athlete-scoped since the owner
 * decision of 2026-08-28 ("Admin, Coach, Athlete, Guardian", implemented by
 * reusing assertActorCanAccessAthlete). There is exactly one place the answer
 * lives and this route does not add a second.
 *
 * What the route DOES add is the distinction between "no objectives" and "not
 * your block". listObjectivesForBlock answers [] for both, because a
 * data-layer read must not disclose that a block exists for someone else's
 * athlete. A coach reading their own athlete's block is owed better than an
 * empty list that reads as "nothing planned here", so GET reads the parent
 * first and answers 404 when it cannot be opened -- indistinguishable from a
 * block id that does not exist, which is the point.
 *
 *   Who may call this at all      coach, organization_admin, admin -- the
 *                                 same set the blocks route serves, and the
 *                                 same list DEVELOPMENT_BLOCK_WRITE_ROLES
 *                                 enforces one layer down. No role is
 *                                 broadened and no new taxonomy is invented.
 *   Which blocks they reach       whatever getDevelopmentBlock allows, which
 *                                 is whatever assertActorCanAccessAthlete
 *                                 allows about the block's athlete.
 *
 * THIS IS THE FIRST SURFACE THAT RENDERS nutrition_body_composition. That
 * domain was admitted by owner decision on 2026-08-28 and has been storable
 * ever since; until now nothing displayed it. Two things make showing it
 * defensible rather than a widening: FIELD_TIERS records
 * athlete_development_block_objectives.objective at `athlete_record` with the
 * module as its real enforcer, and this route serves staff only. The athlete
 * and guardian read surface was a separate slice with its own safeguarding
 * decisions, and it shipped: GET /api/pilot/athlete/development-blocks, which
 * shows a family the same domain under the same label and offers no verb that
 * could change it. This route remains the staff half and gains nothing from
 * that: no family role was added to AUTHOR_ROLES below.
 *
 * NO ROLL-UP, HERE OR ANYWHERE. This returns the rows. It does not count how
 * many reached 'completed', does not express that count as a proportion, and
 * does not present either as a judgment about how a block went or about the
 * athlete it names. "Three of five objectives completed" is arithmetic, not
 * coaching, and the module's own header refuses it for the same reason. A
 * later summary surface would have to be authored by a human the way
 * intervention_outcome_reviews already requires.
 */

const AUTHOR_ROLES = ['coach', 'organization_admin', 'admin'] as const;

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The block id a request names, or a 400 saying so.
 *
 * Separate from the access question on purpose: a request with no block id is
 * malformed and gets told that, while a request naming a block the caller
 * cannot open is a 404. Collapsing the two would let a caller distinguish
 * "you sent nothing" from "not yours" only by guessing.
 */
function requiredBlockId(value: unknown, field = 'block_id'): string {
  const blockId = trimmedString(value)?.trim();
  if (!blockId) {
    throw new ValidationError(
      `A block objective needs a ${field}.`,
      'BLOCK_OBJECTIVE_INVALID',
    );
  }
  return blockId;
}

/**
 * The domain vocabulary, offered so a client never has to hold its own copy
 * of ten values that a migration owns.
 *
 * Organization-free and athlete-free: these are the platform's Full Spectrum
 * labels, identical in every gym, carrying nothing about anybody. So this
 * branch is not athlete-gated -- WHICH block an objective may be attached to
 * is the athlete question, and POST answers it against that block's own
 * athlete.
 */
function domainOptionsResponse() {
  return NextResponse.json(
    { ok: true, domains: [...FULL_SPECTRUM_DOMAINS], statuses: [...OBJECTIVE_STATUSES] },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...AUTHOR_ROLES]);

    if (request.nextUrl.searchParams.get('domains') === 'options') {
      return domainOptionsResponse();
    }

    const blockId = requiredBlockId(request.nextUrl.searchParams.get('block_id'));

    /* The parent, first and by the module's own read. This is the gate AND
       the not-found answer in one call: null means the block is in another
       organization, is about an athlete this coach cannot reach, or does not
       exist, and a caller must not be able to tell those three apart. */
    const block = await getDevelopmentBlock(principal, blockId);
    if (!block) {
      return NextResponse.json({ error: 'Development block not found.' }, { status: 404 });
    }

    const objectives = await listObjectivesForBlock(principal, blockId);
    return NextResponse.json(
      { ok: true, objectives },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...AUTHOR_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;
    const blockId = requiredBlockId(body.block_id);

    /* Validated here rather than passed through, so a body carrying an
       unknown domain cannot reach the data layer at all. The module and the
       database both refuse it too -- this is the third of three, and the one
       that can say WHICH value was wrong. */
    const domain = trimmedString(body.domain);
    if (!domain || !(FULL_SPECTRUM_DOMAINS as readonly string[]).includes(domain)) {
      throw new ValidationError(
        `An objective needs one of the Full Spectrum domains, not '${domain ?? ''}'.`,
        'BLOCK_OBJECTIVE_INVALID',
      );
    }

    const status = trimmedString(body.status);
    if (status && !(OBJECTIVE_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError(`Unknown objective status '${status}'.`, 'BLOCK_OBJECTIVE_INVALID');
    }

    /* The organization is the principal's, always, and it is never read from
       the body -- accepting one at all is how a write crosses a tenant
       boundary. Same for the author: addBlockObjective takes the actor and
       writes actor.accountId, so there is no field a caller could forge a
       signature into. */
    const objective = await addBlockObjective({
      actor: principal,
      blockId,
      domain: domain as FullSpectrumDomain,
      objective: trimmedString(body.objective) ?? '',
      status: status as ObjectiveStatus | undefined,
    });

    /* null means the block could not be opened. addBlockObjective throws
       ForbiddenError first for an account that may not author here, so
       reaching this line means the caller IS a writer and the block is not
       theirs -- a 404 on the block, not a 403 and not a silent success. */
    if (!objective) {
      return NextResponse.json({ error: 'Development block not found.' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, objective }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...AUTHOR_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;

    const objectiveId = trimmedString(body.objective_id)?.trim();
    if (!objectiveId) {
      throw new ValidationError(
        'An objective update needs an objective_id.',
        'BLOCK_OBJECTIVE_INVALID',
      );
    }

    const status = trimmedString(body.status);
    if (!status || !(OBJECTIVE_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError(`Unknown objective status '${status ?? ''}'.`, 'BLOCK_OBJECTIVE_INVALID');
    }

    /* STATUS IS THE ONLY THING THIS MOVES, and the omissions are the design.
       The domain an objective was filed under and the sentence the coach
       wrote are not patchable here: re-domaining an objective silently
       reassigns what a coach said about one part of an athlete's development
       to another, and rewriting the sentence in place destroys the record
       this table exists to keep verbatim. A wrong objective is cancelled and
       a new one written -- which is why 'cancelled' is in the vocabulary.

       block_id is absent for the same reason athlete_id is absent from the
       block patch: an objective does not move between blocks. */
    const objective = await setBlockObjectiveStatus(
      principal,
      objectiveId,
      status as ObjectiveStatus,
    );

    if (!objective) {
      return NextResponse.json({ error: 'Objective not found.' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, objective });
  } catch (error) {
    return jsonError(error);
  }
}
