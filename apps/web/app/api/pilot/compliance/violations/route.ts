import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, athleteIdsForCoach } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  ComplianceViolationAlreadyFiledError,
  type ComplianceViolationTransition,
  createComplianceViolation,
  FILM_STUDY_PROPOSAL_SOURCE,
  getComplianceRuleById,
  getComplianceViolationById,
  getOrganizationViolations,
  transitionComplianceViolation,
} from '@/src/server/pilot/compliance';
import { sanitizedSqlState } from '@/src/server/pilot/db';
import { hiddenNotFound, isUuid, parseSafeLimit, requirePrincipal, requireRole, jsonError } from '@/src/server/pilot/http';
import { getFilmStudyProposal } from '@/src/server/pilot/shadowFilmStudyProposals';
import { getVideoSessionById } from '@/src/server/pilot/videoSessions';

export const runtime = 'nodejs';

// A lost audit row is a gap an operator can close by re-dispatching, not a
// reason to tell the admin their (already-committed) lifecycle transition
// failed -- the same doctrine every sibling console carries.
async function auditViolationEvent(event: Parameters<typeof writePilotAuditEvent>[0]): Promise<void> {
  try {
    await writePilotAuditEvent(event);
  } catch (error) {
    const rawCode = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
    const code = sanitizedSqlState(rawCode);
    console.error({
      event: 'compliance-violation-audit-write-failed',
      action: event.details && typeof event.details === 'object' ? (event.details as { action?: unknown }).action : undefined,
      ...(code ? { code } : {}),
    });
  }
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    const status = request.nextUrl.searchParams.get('status');
    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 50, 100);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }

    if (athleteId) {
      await assertActorCanAccessAthlete(principal, athleteId);
    }

    const violations = await getOrganizationViolations(principal.organizationId, {
      athleteId: athleteId || undefined,
      status: status || undefined,
      limit,
      // A coach's unfiltered list: every athlete they reach, coverage included.
      athleteIds: principal.role === 'coach' && !athleteId
        ? await athleteIdsForCoach(principal.organizationId, principal.accountId)
        : undefined,
    });

    // `limit` travels with the rows because this read is capped and ordered
    // `created_at desc`: what comes back is the newest slice of the register,
    // not the register. Callers were computing totals and severity counts off
    // it and labelling them as the whole record. Naming the applied cap is
    // what lets a screen say which window its figures cover.
    return NextResponse.json({ items: violations, limit });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    // .catch(() => null) mirrors PATCH below: without it, malformed/empty
    // JSON throws a SyntaxError that matches no PilotError/prefix branch in
    // jsonError and falls to a masked 500, while the identical failure on
    // PATCH already returns a clean 400 for the same input.
    const body = (await request.json().catch(() => null)) as {
      rule_id?: string;
      video_session_id?: string;
      athlete_id?: string;
      severity?: string;
      details?: Record<string, unknown>;
    } | null;

    if (!body?.rule_id || !body.athlete_id) {
      throw new Error('Missing rule_id or athlete_id');
    }

    await assertActorCanAccessAthlete(principal, body.athlete_id);

    // Reject a rule_id from another organization without revealing whether
    // it exists at all.
    const rule = await getComplianceRuleById(principal.organizationId, body.rule_id);
    if (!rule) {
      return hiddenNotFound();
    }

    // Reject a video_session_id that belongs to another organization, or
    // that is attributed to a different athlete than the one this
    // violation is being filed against.
    if (body.video_session_id) {
      const videoSession = await getVideoSessionById(principal.organizationId, body.video_session_id);
      if (!videoSession || (videoSession.athlete_id && videoSession.athlete_id !== body.athlete_id)) {
        return hiddenNotFound();
      }
    }

    const details = body.details && typeof body.details === 'object' && !Array.isArray(body.details)
      ? body.details
      : {};

    // details.source and details.proposal_id say where a violation came
    // from, so only the server may vouch for them. The one source it can
    // vouch for is a Film Study proposal; any other claimed source (a
    // hand-filed violation calling itself a machine detection, say) and any
    // proposal cited outside that source are refused, not stored.
    if (details.source !== undefined && details.source !== FILM_STUDY_PROPOSAL_SOURCE) {
      throw new Error(`Unsupported details.source: the only supported source is "${FILM_STUDY_PROPOSAL_SOURCE}"`);
    }
    if (details.proposal_id !== undefined && details.source !== FILM_STUDY_PROPOSAL_SOURCE) {
      throw new Error(`Unsupported details.proposal_id: only a violation with details.source "${FILM_STUDY_PROPOSAL_SOURCE}" cites a proposal`);
    }

    // A violation escalated from the Film Study review queue names the
    // proposal it came from. That citation is provenance an admin will follow,
    // so it has to be true: the proposal must exist in THIS organization and
    // be about the same athlete and the same video the violation is filed
    // against. Anything else is refused without revealing whether the
    // proposal exists. Its stored details are then written by
    // createComplianceViolation from the verified id alone, so nothing else
    // the request put in details sits beside the citation looking backed by
    // it.
    let filmStudyProposalId: string | undefined;
    if (details.source === FILM_STUDY_PROPOSAL_SOURCE) {
      const proposalId = typeof details.proposal_id === 'string' ? details.proposal_id : '';
      if (!isUuid(proposalId)) {
        throw new Error('Missing details.proposal_id: a Film Study escalation must name its proposal');
      }
      const proposal = await getFilmStudyProposal(principal.organizationId, proposalId);
      if (
        !proposal
        || proposal.athlete_id !== body.athlete_id
        || proposal.video_session_id !== body.video_session_id
      ) {
        return hiddenNotFound();
      }
      filmStudyProposalId = proposal.proposal_id;
    }

    const violation = await createComplianceViolation({
      organizationId: principal.organizationId,
      ruleId: body.rule_id,
      videoSessionId: body.video_session_id || null,
      athleteId: body.athlete_id,
      detectedByAccountId: principal.accountId,
      severity: body.severity || 'medium',
      ...(filmStudyProposalId ? { filmStudyProposalId } : { details }),
    });

    // Same non-fatal audit the lifecycle transitions below write: the
    // violation row is already committed, so a lost audit row is logged for
    // an operator rather than reported to the filer as a failed filing.
    await auditViolationEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'compliance_violation',
      entity_id: violation.violation_id,
      details: {
        action: 'violation_filed',
        rule_id: body.rule_id,
        athlete_id: body.athlete_id,
        video_session_id: body.video_session_id || null,
        severity: violation.severity,
        source: filmStudyProposalId ? FILM_STUDY_PROPOSAL_SOURCE : null,
        proposal_id: filmStudyProposalId ?? null,
      },
      shadow_mirror: false,
    });

    return NextResponse.json(violation, { status: 201 });
  } catch (error) {
    // The same proposal is already filed under the same rule. Refused before
    // any insert, so neither a second register row nor a second escalation
    // exists; the existing violation is named so it can be found.
    if (error instanceof ComplianceViolationAlreadyFiledError) {
      return NextResponse.json({ error: error.message, violation_id: error.violationId }, { status: 409 });
    }
    return jsonError(error);
  }
}

const TRANSITIONS = new Set<ComplianceViolationTransition>(['acknowledge', 'resolve', 'dismiss']);

// The lifecycle levers. Gated to the same role set as the escalate route --
// the only pre-existing violation lifecycle mutation -- because that is the
// authority current source establishes: coaches read violations, admins move
// them. A transition changes workflow state only; it never touches severity,
// rule, athlete, evidence, or the escalation history rows.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'organization_admin']);

    const body = (await request.json().catch(() => null)) as
      | { violation_id?: unknown; action?: unknown; note?: unknown }
      | null;
    const violationId = typeof body?.violation_id === 'string' ? body.violation_id.trim() : '';
    const rawAction: unknown = body?.action;
    const note = typeof body?.note === 'string' ? body.note.trim() : '';

    if (!violationId) {
      throw new Error('Missing violation_id');
    }
    if (!TRANSITIONS.has(rawAction as ComplianceViolationTransition)) {
      throw new Error('Unsupported action: expected "acknowledge", "resolve", or "dismiss"');
    }
    const action = rawAction as ComplianceViolationTransition;

    // Closing a violation about a minor without a stated reason is
    // unauditable -- same rule the escalation ladder and the video console
    // apply to their own closing verdicts. Acknowledgement is receipt, not
    // closure, and carries no such requirement.
    if (action !== 'acknowledge' && !note) {
      throw new Error(`Missing note: a ${action === 'resolve' ? 'resolution' : 'dismissal'} needs a stated reason`);
    }

    // Resolve the violation scoped to this organization first, rejecting a
    // cross-organization violation_id without revealing whether it exists.
    const violation = await getComplianceViolationById(principal.organizationId, violationId);
    if (!violation) {
      return hiddenNotFound();
    }

    const pastTense = action === 'acknowledge' ? 'acknowledged' : action === 'resolve' ? 'resolved' : 'dismissed';
    const auditEvent: Parameters<typeof writePilotAuditEvent>[0] = {
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'compliance_violation',
      entity_id: violationId,
      details: {
        action: `violation_${action}`,
        prior_status: violation.status,
        new_status: pastTense,
        note: note || undefined,
      },
      shadow_mirror: false,
    };

    // A closure's reason exists only in its audit row, so a resolve or
    // dismiss writes that row inside the transition's transaction: no reason
    // recorded, no closure. An acknowledgement carries no reason and keeps
    // its best-effort audit after the commit.
    const isClosure = action !== 'acknowledge';
    const applied = await transitionComplianceViolation({
      organizationId: principal.organizationId,
      violationId,
      transition: action,
      ...(isClosure ? { audit: auditEvent } : {}),
    });

    // The CAS refused: the violation is not in a state this transition may
    // leave from, or another operator's transition already committed since
    // the read above. Name the current state so the refusal is actionable.
    if (!applied) {
      return NextResponse.json(
        { error: `This violation cannot be ${pastTense} from its current state.`, status: violation.status },
        { status: 409 },
      );
    }

    if (!isClosure) {
      await auditViolationEvent(auditEvent);
    }

    return NextResponse.json({ ok: true, violation_id: violationId, prior_status: violation.status });
  } catch (error) {
    return jsonError(error);
  }
}
