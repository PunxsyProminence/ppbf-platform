import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { flagContactWithoutClearance } from '@/src/server/pilot/contactClearanceGate';
import { flagContactDuringHold } from '@/src/server/pilot/trainingHolds';
import {
  autoCalculateForObservationContext,
  canTriggerStoredCalculation,
} from '@/src/server/pilot/formulas/autoCalculation';
import {
  deterministicKey,
} from '@/src/server/pilot/formulas/identity';
import {
  alertCoachToPainReport,
} from '@/src/server/pilot/formulas/painReportAlert';
import {
  FormulaRepositoryError,
  saveFormulaObservation,
} from '@/src/server/pilot/formulas/repository';
import {
  recalculateForSupersededObservation,
} from '@/src/server/pilot/formulas/runner';
import {
  FORMULA_UNITS,
  OBSERVATION_KINDS,
  type FormulaUnit,
  type ObservationKind,
} from '@/src/server/pilot/formulas/types';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';

export const runtime = 'nodejs';

const observationKinds = new Set<string>(OBSERVATION_KINDS);
const formulaUnits = new Set<string>(FORMULA_UNITS);

interface ObservationRequestBody {
  athleteId?: unknown;
  contextId?: unknown;
  kind?: unknown;
  value?: unknown;
  unit?: unknown;
  dimensions?: unknown;
  observedAt?: unknown;
  idempotencyKey?: unknown;
  supersedesObservationId?: unknown;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function normalizeDimensions(
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> | null {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 50) return null;
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of entries) {
    if (
      !key.trim()
      || key.length > 120
      || (
        item !== null
        && typeof item !== 'string'
        && typeof item !== 'number'
        && typeof item !== 'boolean'
      )
      || (typeof item === 'string' && item.length > 300)
      || (typeof item === 'number' && !Number.isFinite(item))
    ) {
      return null;
    }
    normalized[key] = item as string | number | boolean | null;
  }
  return Object.freeze(normalized);
}

function invalidObservation(message: string) {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['athlete', 'coach', 'organization_admin', 'admin']);

    const body = (await request.json().catch(() => ({}))) as ObservationRequestBody;
    if (
      !boundedString(body.athleteId, 300)
      || !boundedString(body.contextId, 300)
      || !boundedString(body.idempotencyKey, 300)
      || !boundedString(body.observedAt, 80)
      || !Number.isFinite(Date.parse(body.observedAt))
      || typeof body.kind !== 'string'
      || !observationKinds.has(body.kind)
      || typeof body.unit !== 'string'
      || !formulaUnits.has(body.unit)
      || (
        body.value !== null
        && (typeof body.value !== 'number' || !Number.isFinite(body.value))
      )
      || (
        body.supersedesObservationId != null
        && !boundedString(body.supersedesObservationId, 300)
      )
    ) {
      return invalidObservation('Formula observation payload is invalid.');
    }
    const dimensions = normalizeDimensions(body.dimensions);
    if (!dimensions) {
      return invalidObservation('Formula observation dimensions are invalid.');
    }

    await assertActorCanAccessAthlete(principal, body.athleteId);
    await assertShadowRuntimeReadiness({
      requiredTables: [
        'shadow_formula_observations',
        'shadow_formula_results',
        'shadow_formula_baseline_snapshots',
      ],
    });

    // Runs BEFORE the observation is stored, so a failure here aborts the whole
    // request rather than quietly persisting contact nobody was alerted to. The
    // observation write below is idempotency-keyed, so a retry is safe. See
    // contactClearanceGate.ts for why this flags rather than refuses.
    const clearance = await flagContactWithoutClearance({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      kind: body.kind,
      value: body.value as number | null,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      contextId: body.contextId.trim(),
      observedAt: new Date(body.observedAt).toISOString(),
    });

    // #82 REGRESS: same ordering, same doctrine -- contact logged while a
    // hold covering contact is active raises a near miss (auto-escalated)
    // rather than refusing the record. Runs before the store so a failure
    // aborts loudly instead of persisting contact nobody was alerted to.
    await flagContactDuringHold({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      kind: body.kind,
      value: body.value as number | null,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      contextId: body.contextId.trim(),
      observedAt: new Date(body.observedAt).toISOString(),
    });

    // Same ordering and the same reason as the clearance gate above: a stored
    // pain report nobody was told about is worse than a request that fails
    // loudly, so the coach-visible record is written first.
    const painAlert = await alertCoachToPainReport({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      kind: body.kind,
      value: body.value as number | null,
      dimensions,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      contextId: body.contextId.trim(),
      observedAt: new Date(body.observedAt).toISOString(),
    });

    const sourceType = principal.role === 'athlete'
      ? 'manual'
      : principal.role === 'coach'
        ? 'coach_tag'
        : 'imported';
    const observation = await saveFormulaObservation({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      contextId: body.contextId.trim(),
      kind: body.kind as ObservationKind,
      value: body.value as number | null,
      unit: body.unit as FormulaUnit,
      dimensions,
      observedAt: new Date(body.observedAt).toISOString(),
      source: {
        type: sourceType,
        quality: 'moderate',
        referenceId: deterministicKey('formula-api-source', {
          organizationId: principal.organizationId,
          accountId: principal.accountId,
          idempotencyKey: body.idempotencyKey,
        }),
        qualityNotes: 'Authenticated fallback input; not sensor-verified.',
      },
      idempotencyKey: body.idempotencyKey.trim(),
      supersedesObservationId: body.supersedesObservationId?.trim() ?? null,
      createdByAccountId: principal.accountId,
    });

    // A correction re-runs the calculations the replaced observation was
    // actually used in, which knows more than re-detecting the context can:
    // it carries the parameters and policyVersion each original ran under.
    // Auto-detection below is therefore the else-branch, not an addition --
    // running both would compute the same context twice.
    const recalculated = observation.supersedesObservationId
      ? await recalculateForSupersededObservation({
          organizationId: principal.organizationId,
          athleteId: body.athleteId,
          supersededObservationId: observation.supersedesObservationId,
          replacementObservationId: observation.observationId,
        })
      : [];

    // Runs AFTER the store, and must: the detector reads this context back out
    // of the database, so the observation this request just wrote has to be
    // visible to the calculation it may have completed.
    //
    // The role check is the narrower of the two lists that meet here. This
    // endpoint admits athletes; POST /api/pilot/shadow/formulas/results -- the
    // manual "run this formula" path -- does not. An athlete's own submission
    // must not become the side channel that runs a calculation they cannot
    // ask for directly, so their observation is stored and no calculation
    // follows it. Widening that is an owner decision, not this route's.
    const autoCalculated = observation.supersedesObservationId
      || !canTriggerStoredCalculation(principal.role)
      ? []
      : await autoCalculateForObservationContext({
          organizationId: principal.organizationId,
          athleteId: body.athleteId,
          contextId: body.contextId.trim(),
        });

    return NextResponse.json({
      ok: true,
      observation,
      recalculatedResultCount: recalculated.length,
      autoCalculatedResultCount: autoCalculated.length,
      // Surfaced rather than silent: whoever logged this should know a review
      // was raised, and the sparring page displays this back to them.
      ...(clearance.flagged
        ? {
            safetyReview: {
              raised: true,
              reason: 'contact_without_medical_clearance',
              medicalStatus: clearance.medicalStatus,
              severity: clearance.severity,
              // What earns clearance, not just that a review was raised --
              // the "teaching moment" doctrine (owner principle, 2026-08-03).
              lesson: clearance.lesson,
            },
          }
        : {}),
      // The athlete who reported the pain is told, in the same response, that
      // it reached a coach -- so the workspace never has to guess.
      ...(painAlert.raised
        ? {
            painReport: {
              coachNotified: true,
              severity: painAlert.severity,
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof FormulaRepositoryError) {
      if (error.code === 'OBSERVATION_NOT_FOUND') return hiddenNotFound();
      if (
        error.code === 'IDEMPOTENCY_CONFLICT'
        || error.code === 'SUPERSEDED_OBSERVATION'
      ) {
        return NextResponse.json(
          { ok: false, error: 'Formula observation conflicts with an immutable record.' },
          { status: 409 },
        );
      }
    }
    return jsonError(error);
  }
}
