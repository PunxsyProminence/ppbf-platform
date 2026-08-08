import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  advanceLocalFindingTier,
  listLocalFindings,
  raiseLocalFinding,
  type LocalFindingDomain,
  type LocalFindingOriginatingSource,
  type LocalFindingPredictionOutcome,
  type LocalFindingStatus,
  type LocalFindingTier,
} from '@/src/server/pilot/localFindings';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

const RAISE_ROLES = ['organization_admin', 'admin', 'coach'] as const;
const REVIEW_ROLES = ['organization_admin', 'admin'] as const;

// The local-findings review queue: GET lists findings (filterable by
// domain/tier/status), POST raises a new one (always at 'observation' --
// see localFindings.ts's own header), PATCH advances a finding's tier.
// Advancing to a weight-bearing tier (local_tested/local_established)
// requires organization_admin/admin, matching the migration's own
// "the two weight-bearing tiers require a second human reviewer" rule --
// a coach cannot both raise and review-advance a finding to those tiers.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RAISE_ROLES]);

    const { searchParams } = new URL(request.url);
    const findings = await listLocalFindings(principal.organizationId, {
      domain: (searchParams.get('domain') as LocalFindingDomain | null) ?? undefined,
      localTier: (searchParams.get('local_tier') as LocalFindingTier | null) ?? undefined,
      status: (searchParams.get('status') as LocalFindingStatus | null) ?? undefined,
    });
    return NextResponse.json({ findings });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...RAISE_ROLES]);

    const body = (await request.json()) as {
      title?: string;
      statement?: string;
      domain?: LocalFindingDomain;
      applies_to?: string;
      originating_source?: LocalFindingOriginatingSource;
      supporting_activity_ids?: string[];
      supporting_assessment_ids?: string[];
      related_claim_ids?: string[];
      competing_explanations?: string;
      known_limitations?: string;
    };

    if (!body.title?.trim() || !body.statement?.trim() || !body.domain || !body.originating_source) {
      throw new Error('Missing title, statement, domain, or originating_source');
    }

    const created = await raiseLocalFinding({
      organizationId: principal.organizationId,
      title: body.title.trim(),
      statement: body.statement.trim(),
      domain: body.domain,
      appliesTo: body.applies_to,
      originatingSource: body.originating_source,
      supportingActivityIds: body.supporting_activity_ids,
      supportingAssessmentIds: body.supporting_assessment_ids,
      relatedClaimIds: body.related_claim_ids,
      competingExplanations: body.competing_explanations,
      knownLimitations: body.known_limitations,
      raisedByAccountId: principal.accountId,
      raisedByRole: principal.role,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'local_finding',
      entity_id: created.finding_id,
      details: { domain: created.domain, originating_source: created.originating_source },
    });

    return NextResponse.json({ finding: created }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

const WEIGHT_BEARING_TIERS: ReadonlySet<LocalFindingTier> = new Set(['local_tested', 'local_established']);

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    const body = (await request.json()) as {
      finding_id?: string;
      to_tier?: LocalFindingTier;
      rationale?: string;
      prediction_statement?: string;
      prediction_made_at?: string;
      prediction_outcome?: LocalFindingPredictionOutcome;
      prediction_checked_at?: string;
      prediction_note?: string;
      review_note?: string;
    };

    if (!body.finding_id || !body.to_tier || !body.rationale?.trim()) {
      throw new Error('Missing finding_id, to_tier, or rationale');
    }

    // Advancing to a weight-bearing tier is a review action, restricted to
    // admin roles; advancing between the lighter tiers is open to whoever
    // can raise a finding in the first place.
    requireRole(principal, WEIGHT_BEARING_TIERS.has(body.to_tier) ? [...REVIEW_ROLES] : [...RAISE_ROLES]);

    const { finding, historyEntry } = await advanceLocalFindingTier({
      organizationId: principal.organizationId,
      findingId: body.finding_id,
      toTier: body.to_tier,
      rationale: body.rationale.trim(),
      changedByAccountId: principal.accountId,
      changedByRole: principal.role,
      predictionStatement: body.prediction_statement,
      predictionMadeAt: body.prediction_made_at,
      predictionOutcome: body.prediction_outcome,
      predictionCheckedAt: body.prediction_checked_at,
      predictionNote: body.prediction_note,
      reviewedByAccountId: WEIGHT_BEARING_TIERS.has(body.to_tier) ? principal.accountId : undefined,
      reviewNote: body.review_note,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'local_finding',
      entity_id: finding.finding_id,
      details: { from_tier: historyEntry.from_tier, to_tier: historyEntry.to_tier },
    });

    return NextResponse.json({ finding, history_entry: historyEntry });
  } catch (error) {
    return jsonError(error);
  }
}
