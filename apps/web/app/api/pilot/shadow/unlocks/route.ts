import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  evaluateShadowUnlockState,
  listShadowThresholds,
  updateShadowThreshold,
  type ActivationMode,
  type ShadowFeatureKey,
  type ShadowMetricKey,
} from '@/src/server/pilot/shadowUnlocks';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner', 'organization_admin', 'admin', 'coach']);

    const [thresholds, state] = await Promise.all([
      listShadowThresholds(principal.organizationId, principal.accountId),
      evaluateShadowUnlockState({
        organizationId: principal.organizationId,
        accountId: principal.accountId,
      }),
    ]);

    return NextResponse.json({ ok: true, thresholds, state });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['platform_owner', 'organization_admin', 'admin']);

    const body = (await request.json().catch(() => ({}))) as {
      featureKey?: ShadowFeatureKey;
      metricKey?: ShadowMetricKey;
      minValue?: number;
      activationMode?: ActivationMode;
      description?: string;
    };

    if (!body.featureKey || !body.metricKey || body.minValue == null || !body.activationMode) {
      return NextResponse.json({
        ok: false,
        error: 'featureKey, metricKey, minValue, and activationMode are required',
      }, { status: 400 });
    }

    await updateShadowThreshold({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      featureKey: body.featureKey,
      metricKey: body.metricKey,
      minValue: body.minValue,
      activationMode: body.activationMode,
      description: body.description,
    });

    const [thresholds, state] = await Promise.all([
      listShadowThresholds(principal.organizationId, principal.accountId),
      evaluateShadowUnlockState({
        organizationId: principal.organizationId,
        accountId: principal.accountId,
      }),
    ]);

    return NextResponse.json({ ok: true, thresholds, state });
  } catch (error) {
    return jsonError(error);
  }
}
