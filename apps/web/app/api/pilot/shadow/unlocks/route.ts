import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
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

    // Read the prior row before overwriting it, so the audit record can say
    // what changed rather than only what it became.
    const previous = (await listShadowThresholds(principal.organizationId, principal.accountId))
      .find((row) => row.featureKey === body.featureKey) ?? null;

    await updateShadowThreshold({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      featureKey: body.featureKey,
      metricKey: body.metricKey,
      minValue: body.minValue,
      activationMode: body.activationMode,
      description: body.description,
    });

    // Activation mode decides whether a capability can ever unlock, and
    // fine_tuning_pipeline is disabled pending a governance process it names
    // explicitly. Until the admin panel landed, this endpoint had no client
    // and the only trace of a change was updated_by_account_id on the row
    // itself -- no trail, no timestamped before/after. 'update' is the
    // existing vocabulary term; a new event type would need its own migration
    // and the constraint test that guards it.
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'shadow_feature_threshold',
      entity_id: body.featureKey,
      details: {
        featureKey: body.featureKey,
        from: previous
          ? { activationMode: previous.activationMode, minValue: previous.minValue, metricKey: previous.metricKey }
          : null,
        to: {
          activationMode: body.activationMode,
          minValue: body.minValue,
          metricKey: body.metricKey,
        },
      },
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
