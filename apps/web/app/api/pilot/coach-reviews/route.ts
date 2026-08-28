import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getCoachReviewById, getSessionAthleteId, upsertCoachReview } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { validateCoachReviewPayload } from '@/src/server/pilot/validation';

export const runtime = 'nodejs';

/**
 * Create or update a coach review. One route, deliberately.
 *
 * A second route, coach-reviews/update, carried its own copy of the sequence
 * below -- role gate, stored-row resolution, athlete access on BOTH the stored
 * session and the payload session, coach_id ownership, compare-and-set upsert.
 * It was removed on 2026-08-28 with no caller anywhere in the repository, and
 * for an existing review it produced the same outcome, the same audit row and
 * the same refusals as this handler.
 *
 * TWO COPIES OF THIS IS THE HAZARD, not the duplication itself. The sequence
 * here has been repaired twice -- once for the overwrite hole described below,
 * once for an audit verb that recorded every edit as a creation -- and each
 * time a reviewer had to remember there was a second file. That is the shape
 * of defect this repository keeps finding by hand.
 *
 * WHAT WENT AWAY WITH IT, stated rather than quietly dropped: that route
 * REFUSED to create. A review_id it could not find was an error, not a new
 * record. This handler creates instead. No caller wanted the guarantee, but a
 * future one that does must ask for it -- an `expect_existing` flag or its own
 * route -- rather than assuming this path already refuses.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const payload = validateCoachReviewPayload(await request.json());

    if (principal.role === 'coach' && payload.coach_id !== principal.accountId) {
      throw new Error('Forbidden: coach can only create own reviews');
    }

    const athleteId = await getSessionAthleteId(principal.organizationId, payload.session_id);
    if (!athleteId) {
      throw new Error('Missing session for coach review');
    }

    await assertActorCanAccessAthlete(principal, athleteId);

    // The create path formerly called an UPDATE-first upsert, so a coach could
    // supply an EXISTING review_id together with their own athlete's session and
    // overwrite another athlete's review-clearance record -- only the payload's
    // athlete was ever authorized, never the stored row's. Mirror the #624 create
    // pattern: if the review already exists, resolve and authorize its STORED
    // owner (the athlete of its stored session) and compare-and-set on it;
    // otherwise create-only. Atomic, so a concurrent owner change fails closed.
    const existing = await getCoachReviewById(principal.organizationId, payload.review_id);
    if (existing) {
      const existingAthleteId = await getSessionAthleteId(principal.organizationId, existing.session_id);
      if (!existingAthleteId) {
        throw new Error('Missing session for existing coach review');
      }
      await assertActorCanAccessAthlete(principal, existingAthleteId);
      await upsertCoachReview(principal.organizationId, payload, {
        mode: 'update',
        expectedSessionId: existing.session_id,
      });
    } else {
      await upsertCoachReview(principal.organizationId, payload, { mode: 'create' });
    }

    await writePilotAuditEvent({
      /* The verb follows the branch above, and used to be a hardcoded 'create'.
         This route is an upsert: when the review already exists it takes the
         update branch, does a compare-and-set on the stored session, and then
         logged the edit as a creation anyway. Every edit a coach made through
         the workspace -- the only wired write path for coach reviews -- was
         recorded in pilot.audit_events under the wrong verb.

         'update' is already in the audit vocabulary
         (pilot_slice_postgres_audit_event_vocabulary_migration.sql), so this
         needs no schema change; the value was simply never derived. An audit
         row that names the wrong action is worse than a missing one, because a
         reader has no way to tell it is wrong. */
      event_type: existing ? 'update' : 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'coach_review',
      entity_id: payload.review_id,
      details: { session_id: payload.session_id },
    });

    return NextResponse.json({ ok: true, review_id: payload.review_id });
  } catch (error) {
    return jsonError(error);
  }
}
