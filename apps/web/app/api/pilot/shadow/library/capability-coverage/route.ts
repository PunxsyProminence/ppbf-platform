import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  listShadowCapabilityCoverage,
  recomputeShadowCapabilityCoverage,
  upsertShadowCapabilityMap,
} from '@/src/server/pilot/shadowLibrary';
import { SHADOW_LIBRARY_CURATOR_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

// Capability coverage answers "does the Library hold enough authority to speak
// on this capability at all". A rule names the source types and authority tier
// a capability requires; recompute grades every rule against what is actually
// registered and opens a research requirement wherever the answer is no.
//
// POST carries two operations because the seed script calls it both ways:
// {action:'recompute'} regrades, anything else upserts a rule.

const MAX_SOURCE_TYPES = 20;

// Reading coverage is a curator act rather than a general projection read: an
// uncovered capability is a statement about what this organization cannot yet
// substantiate, which belongs with the people who can fix it.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);

    const items = await listShadowCapabilityCoverage(principal.organizationId);
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);

    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      capability_key?: unknown;
      required_source_types?: unknown;
      minimum_authority_tier?: unknown;
      minimum_source_count?: unknown;
    };

    if (body.action !== undefined && body.action !== 'recompute') {
      return NextResponse.json({ ok: false, error: 'Unsupported action' }, { status: 400 });
    }

    if (body.action === 'recompute') {
      const items = await recomputeShadowCapabilityCoverage({
        organizationId: principal.organizationId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
      });
      return NextResponse.json({ ok: true, items });
    }

    if (typeof body.capability_key !== 'string' || !body.capability_key.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing capability_key' }, { status: 400 });
    }

    if (body.capability_key.length > 200) {
      return NextResponse.json({ ok: false, error: 'capability_key must be 200 characters or fewer' }, { status: 400 });
    }

    if (body.required_source_types !== undefined) {
      if (!Array.isArray(body.required_source_types)) {
        return NextResponse.json({ ok: false, error: 'required_source_types must be an array' }, { status: 400 });
      }
      if (body.required_source_types.length > MAX_SOURCE_TYPES) {
        return NextResponse.json(
          { ok: false, error: `required_source_types must hold ${MAX_SOURCE_TYPES} entries or fewer` },
          { status: 400 },
        );
      }
      if (body.required_source_types.some((item) => typeof item !== 'string' || !item.trim())) {
        return NextResponse.json(
          { ok: false, error: 'required_source_types must contain non-empty strings' },
          { status: 400 },
        );
      }
    }

    // Both clamp silently in shadowLibrary. Rejecting here instead means a rule
    // that asks for tier 9 is refused rather than quietly stored as tier 5 and
    // then reported as covered on evidence it never asked for.
    if (
      body.minimum_authority_tier !== undefined
      && (
        !Number.isSafeInteger(body.minimum_authority_tier)
        || (body.minimum_authority_tier as number) < 1
        || (body.minimum_authority_tier as number) > 5
      )
    ) {
      return NextResponse.json(
        { ok: false, error: 'minimum_authority_tier must be an integer between 1 and 5' },
        { status: 400 },
      );
    }

    if (
      body.minimum_source_count !== undefined
      && (
        !Number.isSafeInteger(body.minimum_source_count)
        || (body.minimum_source_count as number) < 1
        || (body.minimum_source_count as number) > 100
      )
    ) {
      return NextResponse.json(
        { ok: false, error: 'minimum_source_count must be an integer between 1 and 100' },
        { status: 400 },
      );
    }

    await upsertShadowCapabilityMap({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      capabilityKey: body.capability_key,
      requiredSourceTypes: body.required_source_types as string[] | undefined,
      minimumAuthorityTier: body.minimum_authority_tier as number | undefined,
      minimumSourceCount: body.minimum_source_count as number | undefined,
    });

    return NextResponse.json({ ok: true, capability_key: body.capability_key.trim() }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
