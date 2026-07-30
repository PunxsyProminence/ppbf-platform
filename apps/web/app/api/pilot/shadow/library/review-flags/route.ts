// GET/PATCH /api/pilot/shadow/library/review-flags — the missing half of the
// library review-flag lifecycle.
//
// The learning loop has always WRITTEN flags: a negative outcome on a cited
// answer upserts a row per (organization, topic) with review_state 'pending',
// bumping flag_count on repeats. Until this route existed nothing ever read
// them beyond a bare topics list in metrics, and nothing could move a flag off
// 'pending' -- the schema's reviewed_by_account_id / reviewed_at columns had
// no writer, so the "concerned topics" list could only grow while the flagged
// evidence kept being cited.
//
// GET lists the flags with their whole story (signal, note, count, dates).
// PATCH records the curator's verdict: 'resolved' (looked at it; evidence
// fixed, retired, or confirmed sound) or 'rejected' (flag is noise). Both are
// terminal here, and both remove the topic from the metrics' concerned list.
// The learning loop's upsert deliberately returns a topic to 'pending' when
// NEW negative feedback arrives after a verdict, so resolution is never
// permanent immunity -- that behavior is pinned by the pg suite.
import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne } from '@/src/server/pilot/db';
import { isUuid, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { SHADOW_LIBRARY_CURATOR_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

interface ReviewFlagRow {
  flag_id: string;
  topic: string;
  session_type: string | null;
  outcome_signal: string | null;
  latest_outcome_signal: string | null;
  user_note: string | null;
  flag_count: number;
  review_state: string;
  proposed_action: string | null;
  flagged_at: string;
  last_flagged_at: string;
  reviewed_by_account_id: string | null;
  reviewed_at: string | null;
}

const TERMINAL_STATES = new Set(['resolved', 'rejected']);

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_library_review_flags'] });

    const stateParam = request.nextUrl.searchParams.get('state') ?? 'pending';
    if (!['pending', 'all'].includes(stateParam)) {
      throw new Error('Missing state: expected "pending" or "all"');
    }

    const flags = await query<ReviewFlagRow>(
      `SELECT flag_id, topic, session_type, outcome_signal, latest_outcome_signal,
              user_note, flag_count, review_state, proposed_action,
              flagged_at, last_flagged_at, reviewed_by_account_id, reviewed_at
       FROM pilot.shadow_library_review_flags
       WHERE organization_id = $1
         AND ($2 = 'all' OR review_state = 'pending')
       ORDER BY last_flagged_at DESC
       LIMIT 100`,
      [principal.organizationId, stateParam],
    );

    return NextResponse.json({ ok: true, flags });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_library_review_flags'] });

    const body = await request.json().catch(() => ({}));
    const flagId = typeof body.flag_id === 'string' ? body.flag_id.trim() : '';
    const reviewState = typeof body.review_state === 'string' ? body.review_state : '';
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 2000) : undefined;
    if (!flagId || !isUuid(flagId)) {
      throw new Error('Missing flag_id');
    }
    if (!TERMINAL_STATES.has(reviewState)) {
      throw new Error('Missing review_state: expected "resolved" or "rejected"');
    }

    // Only a pending flag can take a verdict: re-reviewing a settled flag
    // would silently overwrite who decided it. A topic that re-offends comes
    // back as 'pending' via the learning loop's upsert and can be judged
    // afresh then.
    const updated = await queryOne<{ flag_id: string; topic: string }>(
      `UPDATE pilot.shadow_library_review_flags
       SET review_state = $3,
           reviewed_by_account_id = $4,
           reviewed_at = NOW()
       WHERE organization_id = $1
         AND flag_id = $2
         AND review_state = 'pending'
       RETURNING flag_id, topic`,
      [principal.organizationId, flagId, reviewState, principal.accountId],
    );
    if (!updated) {
      throw new Error('Not found: pending review flag');
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'shadow_library_review_flag',
      entity_id: flagId,
      details: {
        action: 'library_review_flag_verdict',
        review_state: reviewState,
        topic: updated.topic,
        notes: notes ?? '',
      },
      shadow_mirror: false,
    });

    return NextResponse.json({ ok: true, flag_id: flagId, review_state: reviewState });
  } catch (error) {
    return jsonError(error);
  }
}
