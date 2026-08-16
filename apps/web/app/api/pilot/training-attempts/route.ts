import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  isAttemptContextType,
  isAttemptMetricKind,
  listAttempts,
  recordAttempt,
} from '@/src/server/pilot/trainingAttempts';

export const runtime = 'nodejs';

// The attempts ledger. Staff record for their athletes; an athlete records
// and reads their OWN attempts (assertActorCanAccessAthlete is the standing
// authority on which athlete a caller may touch -- an athlete principal
// passes only for themselves). Parents deliberately have no write here and
// no read either in v1: an athlete's failure log is training data between
// athlete and coach, not a family scoreboard.

const ATTEMPT_ROLES = ['coach', 'organization_admin', 'admin', 'athlete'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ATTEMPT_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);

    const metricKind = request.nextUrl.searchParams.get('metric_kind') ?? undefined;
    if (metricKind !== undefined && !isAttemptMetricKind(metricKind)) {
      throw new ValidationError('Unknown metric_kind.');
    }

    const items = await listAttempts(principal.organizationId, athleteId, { metricKind });
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ATTEMPT_ROLES]);

    const body = (await request.json()) as {
      athlete_id?: string;
      context_type?: string;
      context_id?: string | null;
      metric_kind?: string;
      target_value?: number | null;
      achieved_value?: number;
      note?: string;
    };

    const athleteId = body.athlete_id?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);

    if (!isAttemptMetricKind(body.metric_kind)) {
      throw new ValidationError('Unknown metric_kind.');
    }
    if (body.context_type !== undefined && !isAttemptContextType(body.context_type)) {
      throw new ValidationError('Unknown context_type.');
    }
    const achieved = body.achieved_value;
    if (typeof achieved !== 'number' || !Number.isFinite(achieved) || achieved < 0) {
      throw new ValidationError('achieved_value must be a non-negative number.');
    }
    const target = body.target_value ?? null;
    if (target !== null && (typeof target !== 'number' || !Number.isFinite(target) || target <= 0)) {
      throw new ValidationError('target_value must be a positive number when provided.');
    }

    const item = await recordAttempt({
      organizationId: principal.organizationId,
      athleteId,
      contextType: body.context_type,
      contextId: body.context_id ?? null,
      metricKind: body.metric_kind,
      targetValue: target,
      achievedValue: achieved,
      note: body.note,
      recordedByAccountId: principal.accountId,
    });

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
