import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  listObjectivesForBlock,
  type BlockObjectiveRow,
} from '@/src/server/pilot/athleteDevelopmentBlockObjectives';
import {
  listDevelopmentBlocksForAthlete,
  type AthleteDevelopmentBlockRow,
} from '@/src/server/pilot/athleteDevelopmentBlocks';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The plan, to the person it is about and the adult responsible for them.
 *
 * OWNER DECISION, 2026-08-28: an athlete sees their development blocks and
 * every objective on them, INCLUDING nutrition_body_composition, exactly as
 * the coach wrote them. A guardian reads precisely what their child reads and
 * no more. Asked as "what does the athlete see of the plan their coach wrote
 * about them", answered "everything, verbatim".
 *
 * WHY VERBATIM RATHER THAN A SOFTENED PROJECTION. A second, gentler version
 * of a coach's words would be a second version of the truth about a child,
 * and this platform has one. The transparency is itself a safeguarding
 * property: a plan about a minor that the minor and their guardian cannot
 * read is a plan neither of them can question. The same reasoning already
 * governs progression gaps and sparring notes, which reach the family
 * unaltered.
 *
 * The cost is named rather than hidden: a coach's blunt private phrasing is
 * now athlete-facing, and a body-composition sentence about a minor is
 * visible to that minor. That was the decision, made with the alternative in
 * front of it.
 *
 * WHAT THIS ROUTE REFUSES TO BE.
 *
 * It is READ-ONLY -- there is no POST and no PATCH, not a gated one. Reading
 * is not writing: an athlete marking their own block 'completed' is the coach
 * judgment this table exists to refuse to compute, and a guardian editing a
 * coach's plan is not a thing the gym's authority model contains. The data
 * layer would refuse both anyway (DEVELOPMENT_BLOCK_WRITE_ROLES); the route
 * offers no verb to refuse.
 *
 * It carries NO ROLL-UP, for the same reason the coach's own surface does
 * not, and more sharply here. "Three of five objectives completed" shown to a
 * child is a score about that child, produced by arithmetic rather than by a
 * coach. Whether a block went well is a human judgment, and this returns rows
 * so that a later summary has to be authored rather than derived.
 *
 * SEPARATE FROM THE COACH ROUTE ON PURPOSE, not duplicated. Both are thin
 * over the same data layer, which is where the one access rule lives. They
 * differ in audience, in verbs (this has one), and in shape: this returns
 * each block with its objectives already attached, because a family view is
 * small, read-once, and has no reason to make a screen fetch per block the
 * way an authoring panel does. Same relationship as /api/pilot/coach/athletes
 * and /api/pilot/athletes/list.
 */

/** The two roles this serves. Staff read the coach route; this is the family. */
const FAMILY_ROLES = ['athlete', 'parent'] as const;

export interface FamilyDevelopmentBlock extends AthleteDevelopmentBlockRow {
  objectives: BlockObjectiveRow[];
}

/**
 * Whose plan this request is for.
 *
 * An athlete never names a subject: they are the subject, and the id comes
 * from their own session rather than from the query string. A parent must
 * name which child, because they may hold links to several -- and that id is
 * then put through assertActorCanAccessAthlete, so naming a child they are
 * not linked to reaches nothing.
 *
 * Written as one function because the alternative -- trusting `athlete_id`
 * whenever it is present -- would let an athlete read a sibling's plan by
 * adding a query parameter. The athlete arm ignores the parameter entirely
 * rather than validating it, which is the difference between a check that can
 * be got wrong and a value that is never read.
 */
function subjectAthleteId(
  role: string,
  sessionAthleteId: string | null | undefined,
  requested: string | null,
): string {
  if (role === 'athlete') {
    if (!sessionAthleteId) {
      // An athlete-role account with no athlete_id is a provisioning fault,
      // not a request fault: there is no record to show and no id to guess.
      throw new ValidationError(
        'This account is not linked to an athlete record.',
        'ATHLETE_RECORD_NOT_LINKED',
      );
    }
    return sessionAthleteId;
  }

  const athleteId = requested?.trim();
  if (!athleteId) {
    throw new ValidationError(
      'Naming which child this is for is required.',
      'ATHLETE_ID_REQUIRED',
    );
  }
  return athleteId;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...FAMILY_ROLES]);

    const athleteId = subjectAthleteId(
      principal.role,
      principal.athleteId,
      request.nextUrl.searchParams.get('athlete_id'),
    );

    /* The gate, before the read, and it does the work for both arms: an
       athlete passes only for themselves, a parent only for a linked child,
       and a soft-deleted athlete fails for the parent. A 403 rather than an
       empty list, because a guardian who may not reach this child is owed
       that answer rather than one that reads as "your child has no plan". */
    await assertActorCanAccessAthlete(principal, athleteId);

    const blocks = await listDevelopmentBlocksForAthlete(principal, athleteId);

    /* Objectives attached per block, in one response. Sequential rather than
       parallel: this is a handful of blocks for one athlete, and each call is
       another authorization decision in the data layer -- fanning them out
       buys milliseconds on a page nobody refreshes in a loop. */
    const withObjectives: FamilyDevelopmentBlock[] = [];
    for (const block of blocks) {
      withObjectives.push({
        ...block,
        objectives: await listObjectivesForBlock(principal, block.block_id),
      });
    }

    return NextResponse.json(
      { ok: true, blocks: withObjectives },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
