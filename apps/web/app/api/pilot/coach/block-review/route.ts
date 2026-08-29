import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import {
  getDevelopmentBlock,
  hasBlockWriteMembership,
} from '@/src/server/pilot/athleteDevelopmentBlocks';
import {
  blockEvidence,
  listBlockReviews,
  recordBlockReview,
  type AdherenceState,
} from '@/src/server/pilot/blockReview';
import { ForbiddenError, ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Plan versus what was actually recorded, for one development block.
 *
 * THE RESPONSE HAS TWO HALVES AND THEY ARE NOT THE SAME KIND OF CLAIM, which
 * is why they are returned as two named fields rather than merged into one
 * "block status" object a renderer would flatten:
 *
 *   `reviews`  -- what a HUMAN said. A state they chose from five, and their
 *                 own words about what departed from the plan and why.
 *   `evidence` -- what is ON RECORD elsewhere for this athlete in this
 *                 block's window. Counted, never interpreted.
 *
 * NOTHING HERE COMPARES THEM. No field says whether the evidence supports the
 * coach's state, whether the block is on track, or how much of the plan was
 * delivered. The build order refuses that explicitly -- "Do not invent an
 * adherence percentage" -- and the refusal has to live at the surface as well
 * as in the table, because this route is where a number would be assembled if
 * one ever were: it is the only place in the lane holding a plan and a record
 * of activity at the same time.
 *
 * A ZERO IS NOT A FINDING. An evidence source with `recorded: 0` means nobody
 * wrote anything down -- not that the athlete did not train and not that the
 * coach neglected the block. Every count is labelled `recorded` for that
 * reason and callers are obliged to keep the word.
 *
 * A FAILED READ IS NOT A ZERO EITHER. The evidence reads are not caught and
 * defaulted: if one throws, this route answers with an error and the surface
 * renders unavailability. Six zeroes from a broken query would be
 * indistinguishable from an empty record, which is the single confusion this
 * whole panel exists to avoid.
 *
 * ONE GATE, AND IT IS THE BLOCK'S. A review is a record about one minor, so
 * "may this caller review this block" is "may this caller open it" --
 * getDevelopmentBlock answers that for the actor, with "no such block" and
 * "not your athlete" deliberately indistinguishable. The evidence read is
 * scoped to the athlete THAT block names, never to an athlete id from the
 * request, so no query string can point this read at another child.
 */

const REVIEW_ROLES = ['coach', 'organization_admin', 'admin'] as const;

function stringField(body: Record<string, unknown> | null, name: string): string {
  const value = body?.[name];
  return typeof value === 'string' ? value : '';
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);

    const blockId = request.nextUrl.searchParams.get('block_id')?.trim() ?? '';
    if (!blockId) {
      throw new ValidationError('block_id is required.', 'BLOCK_REVIEW_INVALID');
    }

    const block = await getDevelopmentBlock(principal, blockId);
    if (!block) {
      return NextResponse.json({ ok: false, error: 'Block not found.' }, { status: 404 });
    }

    /* The athlete and the window come from the BLOCK, never from the request.
       A caller who could name the athlete could name a different one and read
       another child's training record through a block they legitimately
       hold. */
    const [reviews, evidence] = await Promise.all([
      listBlockReviews(principal.organizationId, blockId),
      blockEvidence(
        principal.organizationId,
        block.athlete_id,
        blockId,
        block.starts_on,
        block.ends_on,
      ),
    ]);

    return NextResponse.json(
      {
        ok: true,
        block: {
          block_id: block.block_id,
          title: block.title,
          training_emphasis: block.training_emphasis,
          starts_on: block.starts_on,
          ends_on: block.ends_on,
          status: block.status,
        },
        reviews,
        evidence,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const blockId = stringField(body, 'block_id').trim();
    if (!blockId) {
      throw new ValidationError('block_id is required.', 'BLOCK_REVIEW_INVALID');
    }

    const block = await getDevelopmentBlock(principal, blockId);
    if (!block) {
      return NextResponse.json({ ok: false, error: 'Block not found.' }, { status: 404 });
    }

    /* The same membership question the block and objective writers ask, from
       the same helper. The session role is the account's; this is the role
       held HERE, now, and it is the one that decides whether a person may
       author a lasting judgement about a child's training. A coach whose
       membership in this gym was deactivated keeps a valid session and loses
       this. */
    if (!(await hasBlockWriteMembership(principal.accountId, principal.organizationId))) {
      throw new ForbiddenError(
        'An active coaching membership in this organization is required to review a block.',
        'BLOCK_REVIEW_FORBIDDEN',
      );
    }

    const review = await recordBlockReview({
      organizationId: principal.organizationId,
      blockId,
      reviewedByAccountId: principal.accountId,
      // Absent means absent: the module defaults the state to 'unknown', which
      // is a real answer, and never guesses one from the other fields.
      adherenceState: (stringField(body, 'adherence_state').trim() ||
        undefined) as AdherenceState | undefined,
      deviations: stringField(body, 'deviations'),
      reason: stringField(body, 'reason'),
      whatWorked: stringField(body, 'what_worked'),
      whatDidNot: stringField(body, 'what_did_not'),
      nextAdjustment: stringField(body, 'next_adjustment'),
    });

    return NextResponse.json({ ok: true, review }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
