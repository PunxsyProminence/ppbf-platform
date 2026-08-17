// GET/PATCH /api/pilot/shadow/film-study/proposals — the coach's acceptance
// gate for Film Study observations (#103, safety design owner-approved
// 2026-07-31).
//
// Vision output is an AI observation about an identifiable minor, so it never
// touches an athlete record on its own: it lands as a proposal and waits here.
// GET is the queue; PATCH is the human attestation that settles one.
//
// This ships BEFORE the executor deliberately. A producer without a reviewer
// is how the feedback queue ended up with no exit at all (audit C1/C2, #122),
// so the exit exists first and the executor lands into a surface that can
// already clear it.
import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { isUuid, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  createCoachReportedObservation,
  getFilmStudyProposal,
  listFilmStudyProposals,
  resolveFilmStudyProposal,
  type FilmStudyProposalVerdict,
} from '@/src/server/pilot/shadowFilmStudyProposals';

export const runtime = 'nodejs';

// Accepting an observation about an athlete is a coaching act, so it is
// restricted to the roles that carry coaching authority. platform_owner is
// absent by the Omega doctrine in shadowRoleSets.ts: broader in breadth,
// strictly NARROWER in depth, and per-athlete observations are depth.
const PROPOSAL_REVIEWER_ROLES = ['coach', 'organization_admin', 'admin'] as const;

const VERDICTS = new Set<string>(['accepted', 'rejected', 'corrected']);

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...PROPOSAL_REVIEWER_ROLES]);

    const params = request.nextUrl.searchParams;
    const stateParam = params.get('state') ?? 'pending';
    if (stateParam !== 'pending' && stateParam !== 'all') {
      throw new Error('Missing state: expected "pending" or "all"');
    }

    const athleteId = params.get('athlete_id');
    if (athleteId) {
      // Narrowing to one athlete is a per-athlete read, so it takes the same
      // access check every other athlete-scoped read takes.
      await assertActorCanAccessAthlete(principal, athleteId);
    }

    const proposals = await listFilmStudyProposals({
      organizationId: principal.organizationId,
      state: stateParam,
      athleteId,
    });

    return NextResponse.json({ ok: true, proposals });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...PROPOSAL_REVIEWER_ROLES]);

    const body = (await request.json().catch(() => ({}))) as {
      proposal_id?: unknown;
      verdict?: unknown;
      notes?: unknown;
      corrected_observation_text?: unknown;
    };

    const proposalId = typeof body.proposal_id === 'string' ? body.proposal_id.trim() : '';
    const verdict = typeof body.verdict === 'string' ? body.verdict : '';
    const notes = typeof body.notes === 'string' ? body.notes : null;
    const correctedObservationText = typeof body.corrected_observation_text === 'string'
      ? body.corrected_observation_text
      : null;

    if (!proposalId || !isUuid(proposalId)) {
      throw new Error('Missing proposal_id');
    }
    if (!VERDICTS.has(verdict)) {
      throw new Error('Missing verdict: expected "accepted", "rejected" or "corrected"');
    }

    // Loaded before settling so the athlete-access check runs against the
    // proposal's real subject rather than anything the caller supplied.
    const existing = await getFilmStudyProposal(principal.organizationId, proposalId);
    if (!existing) {
      throw new Error('Not found: film study proposal');
    }
    await assertActorCanAccessAthlete(principal, existing.athlete_id);

    const settled = await resolveFilmStudyProposal({
      organizationId: principal.organizationId,
      proposalId,
      verdict: verdict as FilmStudyProposalVerdict,
      reviewerAccountId: principal.accountId,
      reviewerRole: principal.role,
      notes,
      correctedObservationText,
    });

    // The proposal exists and the caller may see it, so the only way to reach
    // here is that somebody already settled it. Say that, rather than
    // reporting a 404 for a row the reviewer is looking at.
    if (!settled) {
      return NextResponse.json(
        {
          ok: false,
          error: `This proposal was already ${existing.review_state === 'pending_review' ? 'settled' : existing.review_state}`
            + ' by another reviewer. A recorded verdict cannot be replaced.',
          review_state: existing.review_state,
        },
        { status: 409 },
      );
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'shadow_film_study_proposal',
      entity_id: proposalId,
      details: {
        action: 'film_study_proposal_verdict',
        verdict,
        origin: settled.origin,
        athlete_id: settled.athlete_id,
        video_session_id: settled.video_session_id,
        model_deployment: settled.model_deployment ?? '',
        frames_analyzed: settled.frames_analyzed ?? 0,
        // Recorded so the audit trail shows a correction changed the wording,
        // without reproducing an observation about a minor into the audit log.
        corrected: settled.corrected_observation_text !== null,
        notes: notes ?? '',
      },
    });

    return NextResponse.json({ ok: true, proposal: settled });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * POST — the missed detection: a coach records an observation the model never
 * proposed.
 *
 * Until this existed the queue could only hold the vision pipeline's own
 * output, so the review record was blind to what the model failed to say. A
 * model offering one easy observation per video and having it accepted scored
 * the same as one that found everything.
 *
 * The entry lands `pending_review` like any other row rather than
 * pre-accepted, so it keeps both exits: a mis-entered observation about a
 * minor must be retractable (#122).
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...PROPOSAL_REVIEWER_ROLES]);

    const body = (await request.json().catch(() => ({}))) as {
      athlete_id?: unknown;
      video_session_id?: unknown;
      observation_text?: unknown;
    };

    const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
    const videoSessionId = typeof body.video_session_id === 'string'
      ? body.video_session_id.trim()
      : '';
    const observationText = typeof body.observation_text === 'string'
      ? body.observation_text.trim()
      : '';

    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }
    if (!videoSessionId) {
      throw new Error('Missing video_session_id');
    }
    if (!observationText) {
      throw new Error('Missing observation_text');
    }

    // Same per-athlete access check every athlete-scoped write takes. Writing
    // an observation about an athlete is at least as sensitive as reading one.
    await assertActorCanAccessAthlete(principal, athleteId);

    const proposal = await createCoachReportedObservation({
      organizationId: principal.organizationId,
      athleteId,
      videoSessionId,
      observationText,
      reportedByAccountId: principal.accountId,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'shadow_film_study_proposal',
      entity_id: proposal.proposal_id,
      details: {
        action: 'film_study_coach_reported_observation',
        origin: proposal.origin,
        athlete_id: proposal.athlete_id,
        video_session_id: proposal.video_session_id,
      },
    });

    return NextResponse.json({ ok: true, proposal }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
