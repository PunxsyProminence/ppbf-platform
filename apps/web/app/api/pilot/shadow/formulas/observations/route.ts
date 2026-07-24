import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  deterministicKey,
} from '@/src/server/pilot/formulas/identity';
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

    const recalculated = observation.supersedesObservationId
      ? await recalculateForSupersededObservation({
          organizationId: principal.organizationId,
          athleteId: body.athleteId,
          supersededObservationId: observation.supersedesObservationId,
          replacementObservationId: observation.observationId,
        })
      : [];

    return NextResponse.json({
      ok: true,
      observation,
      recalculatedResultCount: recalculated.length,
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
