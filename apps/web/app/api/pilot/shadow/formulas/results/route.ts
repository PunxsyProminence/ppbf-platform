import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import {
  FormulaRepositoryError,
  listActiveFormulaResults,
} from '@/src/server/pilot/formulas/repository';
import {
  FormulaExecutionError,
  isMvpFormulaId,
  runStoredMvpFormula,
} from '@/src/server/pilot/formulas/runner';
import { FORMULA_IDS, type FormulaId } from '@/src/server/pilot/formulas/types';
import {
  hiddenNotFound,
  jsonError,
  parseSafeLimit,
  requirePrincipal,
} from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';

export const runtime = 'nodejs';

const formulaIds = new Set<string>(FORMULA_IDS);

interface FormulaRunBody {
  athleteId?: unknown;
  formulaId?: unknown;
  observationIds?: unknown;
  parameters?: unknown;
  policyVersion?: unknown;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function isParameterObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function repositoryErrorResponse(error: FormulaRepositoryError) {
  if (error.code === 'OBSERVATION_NOT_FOUND') return hiddenNotFound();
  return NextResponse.json(
    { ok: false, error: 'Formula calculation conflicts with an immutable record.' },
    { status: 409 },
  );
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [
      'athlete',
      'parent',
      'coach',
      'organization_admin',
      'admin',
    ]);

    const athleteId = request.nextUrl.searchParams.get('athleteId')
      ?? request.nextUrl.searchParams.get('athlete_id');
    const formulaId = request.nextUrl.searchParams.get('formulaId')
      ?? request.nextUrl.searchParams.get('formula_id');
    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 50, 200);
    if (
      !boundedString(athleteId, 300)
      || (formulaId != null && !formulaIds.has(formulaId))
      || limit === null
    ) {
      return NextResponse.json(
        { ok: false, error: 'Formula result query is invalid.' },
        { status: 400 },
      );
    }

    await assertActorCanAccessAthlete(principal, athleteId);
    await assertShadowRuntimeReadiness({
      requiredTables: [
        'shadow_formula_observations',
        'shadow_formula_results',
      ],
    });
    const results = await listActiveFormulaResults({
      organizationId: principal.organizationId,
      athleteId,
      formulaId: formulaId == null ? undefined : formulaId as FormulaId,
      limit,
    });
    return NextResponse.json({ ok: true, results });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);
    const body = (await request.json().catch(() => ({}))) as FormulaRunBody;
    if (
      !boundedString(body.athleteId, 300)
      || !isMvpFormulaId(body.formulaId)
      || !Array.isArray(body.observationIds)
      || body.observationIds.length === 0
      || body.observationIds.length > 500
      || body.observationIds.some((value) => !boundedString(value, 300))
      || (
        body.parameters != null
        && !isParameterObject(body.parameters)
      )
      || (
        body.parameters != null
        && JSON.stringify(body.parameters).length > 20_000
      )
      || (
        body.policyVersion != null
        && !boundedString(body.policyVersion, 120)
      )
    ) {
      return NextResponse.json(
        { ok: false, error: 'Formula calculation payload is invalid.' },
        { status: 400 },
      );
    }

    await assertActorCanAccessAthlete(principal, body.athleteId);
    await assertShadowRuntimeReadiness({
      requiredTables: [
        'shadow_formula_observations',
        'shadow_formula_results',
        'shadow_formula_baseline_snapshots',
      ],
    });
    const output = await runStoredMvpFormula({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      formulaId: body.formulaId,
      observationIds: body.observationIds as string[],
      ...(body.parameters != null
        ? { parameters: body.parameters as Readonly<Record<string, unknown>> }
        : {}),
      ...(typeof body.policyVersion === 'string'
        ? { policyVersion: body.policyVersion.trim() }
        : {}),
    });
    return NextResponse.json({ ok: true, ...output });
  } catch (error) {
    if (error instanceof FormulaRepositoryError) {
      return repositoryErrorResponse(error);
    }
    if (error instanceof FormulaExecutionError || error instanceof TypeError) {
      return NextResponse.json(
        { ok: false, error: 'Formula calculation input is invalid.' },
        { status: 400 },
      );
    }
    return jsonError(error);
  }
}
