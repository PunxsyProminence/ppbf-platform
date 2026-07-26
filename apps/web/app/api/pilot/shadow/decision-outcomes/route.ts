import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { getDecisionAthleteId } from '@/src/server/pilot/shadowDecisions';
import {
  evaluateDecisionOutcome,
  listDecisionOutcomes,
  type ShadowDecisionMatchState,
} from '@/src/server/pilot/shadowDecisionOutcomes';

export const runtime = 'nodejs';

const DECISION_LOOP_ROLES = ['coach', 'organization_admin', 'admin'] as const;
const MATCH_STATES = new Set<string>(['match', 'partial', 'miss', 'confounded']);
const REQUIRED_TABLES = ['shadow_decision_outcomes', 'shadow_decisions', 'shadow_audit_entries'];

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

async function assertActorCanAccessDecision(
  principal: Parameters<typeof assertActorCanAccessAthlete>[0],
  organizationId: string,
  decisionId: string,
): Promise<void> {
  const athleteId = await getDecisionAthleteId(organizationId, decisionId);
  if (!athleteId) {
    throw new Error('Not found');
  }
  await assertActorCanAccessAthlete(principal, athleteId);
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const decisionId = request.nextUrl.searchParams.get('decisionId');
    if (!boundedString(decisionId, 300)) {
      return NextResponse.json({ ok: false, error: 'decisionId is required.' }, { status: 400 });
    }

    await assertShadowRuntimeReadiness({ requiredTables: REQUIRED_TABLES });
    try {
      await assertActorCanAccessDecision(principal, principal.organizationId, decisionId);
    } catch {
      return hiddenNotFound();
    }

    const outcomes = await listDecisionOutcomes(principal.organizationId, decisionId);
    return NextResponse.json({ ok: true, outcomes });
  } catch (error) {
    return jsonError(error);
  }
}

interface DecisionOutcomeRequestBody {
  decisionId?: unknown;
  observationIds?: unknown;
  matchState?: unknown;
  notes?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DECISION_LOOP_ROLES]);

    const body = (await request.json().catch(() => ({}))) as DecisionOutcomeRequestBody;
    const observationIds = Array.isArray(body.observationIds)
      ? body.observationIds.filter((item): item is string => typeof item === 'string')
      : null;

    if (
      !boundedString(body.decisionId, 300)
      || typeof body.matchState !== 'string'
      || !MATCH_STATES.has(body.matchState)
      || !observationIds
      || observationIds.length !== (body.observationIds as unknown[]).length
      || (body.notes !== undefined && body.notes !== null && !boundedString(body.notes, 4000))
    ) {
      return NextResponse.json({ ok: false, error: 'Decision outcome payload is invalid.' }, { status: 400 });
    }

    await assertShadowRuntimeReadiness({ requiredTables: REQUIRED_TABLES });
    try {
      await assertActorCanAccessDecision(principal, principal.organizationId, body.decisionId);
    } catch {
      return hiddenNotFound();
    }

    const outcome = await evaluateDecisionOutcome({
      organizationId: principal.organizationId,
      decisionId: body.decisionId,
      observationIds,
      matchState: body.matchState as ShadowDecisionMatchState,
      notes: body.notes as string | undefined,
      evaluatedByAccountId: principal.accountId,
      evaluatedByRole: principal.role,
    });

    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    return jsonError(error);
  }
}
