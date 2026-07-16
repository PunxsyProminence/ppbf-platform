import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { listShadowCapabilityCoverage, recomputeShadowCapabilityCoverage, upsertShadowCapabilityMap } from '@/src/server/pilot/shadowLibrary';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff']);
    await assertShadowRuntimeReadiness({ requiredTables: [] });

    const items = await listShadowCapabilityCoverage(principal.organizationId);
    return NextResponse.json({ ok: true, organization_id: principal.organizationId, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach']);
    await assertShadowRuntimeReadiness({ requiredTables: [] });

    const body = (await request.json().catch(() => ({}))) as {
      action?: 'upsert' | 'recompute';
      capability_key?: string;
      required_source_types?: string[];
      minimum_authority_tier?: number;
      minimum_source_count?: number;
    };

    if (body.action === 'recompute') {
      const items = await recomputeShadowCapabilityCoverage({
        organizationId: principal.organizationId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
      });

      return NextResponse.json({ ok: true, organization_id: principal.organizationId, items });
    }

    if (!body.capability_key?.trim()) {
      return NextResponse.json({ ok: false, error: 'missing capability_key' }, { status: 400 });
    }

    await upsertShadowCapabilityMap({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      capabilityKey: body.capability_key,
      requiredSourceTypes: Array.isArray(body.required_source_types)
        ? body.required_source_types.filter((value) => typeof value === 'string' && value.trim())
        : [],
      minimumAuthorityTier: body.minimum_authority_tier,
      minimumSourceCount: body.minimum_source_count,
    });

    const items = await listShadowCapabilityCoverage(principal.organizationId);
    return NextResponse.json({ ok: true, organization_id: principal.organizationId, items });
  } catch (error) {
    return jsonError(error);
  }
}
