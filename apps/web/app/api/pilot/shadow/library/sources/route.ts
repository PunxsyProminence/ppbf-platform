import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  createShadowLibrarySource,
  listShadowLibrarySources,
  type ShadowLibrarySourceStatus,
  type ShadowLibrarySourceType,
  updateShadowLibrarySourceClassification,
} from '@/src/server/pilot/shadowLibrary';
import { SHADOW_LIBRARY_CURATOR_ROLES } from '@/src/server/pilot/shadowRoleSets';
import { isResearchClassificationDomain, isResearchClassificationLayer } from '@/src/shared/researchClassification';

export const runtime = 'nodejs';

// The write half of the SHADOW Library. Until this route existed, nothing could
// put a source into pilot.shadow_library_sources: seed:shadow:library POSTs
// here and got a 404, so searchShadowLibrary had nothing to match and every
// answer's evidence tier was derived from zero citations.
//
// Registering a source does NOT make it citable. Rows land on
// approval_state='pending_review' / verification_state='unverified', and
// searchShadowLibrary requires 'approved'/'verified' on both the source and its
// document. Promotion happens only through PATCH /shadow/evidence/review. That
// human gate is the point of the Library, so this route must never pre-approve
// its own writes.

// Keyed by the union rather than listed as a string[] so that adding a member
// to ShadowLibrarySourceType fails to compile here until it is classified,
// rather than silently becoming un-postable through this route.
const SOURCE_TYPES: Record<ShadowLibrarySourceType, true> = {
  peer_reviewed: true,
  clinical_guideline: true,
  governing_body: true,
  coach_observation: true,
  athlete_self_report: true,
  sensor_data: true,
  internal_policy: true,
  textbook: true,
  media: true,
  other: true,
};

const SOURCE_STATUSES: Record<ShadowLibrarySourceStatus, true> = {
  active: true,
  archived: true,
  rejected: true,
  quarantined: true,
};

function isSourceType(value: unknown): value is ShadowLibrarySourceType {
  return typeof value === 'string' && Object.hasOwn(SOURCE_TYPES, value);
}

function isSourceStatus(value: unknown): value is ShadowLibrarySourceStatus {
  return typeof value === 'string' && Object.hasOwn(SOURCE_STATUSES, value);
}

// Postgres stores publication_date as `date`; an unparseable string would reach
// the driver as a cast error and surface as a 500. Reject it here as a 400.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);

    const params = new URL(request.url).searchParams;
    const sourceType = params.get('source_type');
    const status = params.get('status');
    const generalResearch = params.get('general_research');

    if (generalResearch !== null && generalResearch !== 'true' && generalResearch !== 'false') {
      return NextResponse.json({ ok: false, error: "general_research must be 'true' or 'false'" }, { status: 400 });
    }
    const rawLimit = params.get('limit');
    const rawOffset = params.get('offset');

    if (sourceType !== null && !isSourceType(sourceType)) {
      return NextResponse.json({ ok: false, error: 'Unsupported source_type' }, { status: 400 });
    }

    if (status !== null && !isSourceStatus(status)) {
      return NextResponse.json({ ok: false, error: 'Unsupported status' }, { status: 400 });
    }

    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return NextResponse.json({ ok: false, error: 'limit must be an integer between 1 and 200' }, { status: 400 });
    }

    const offset = rawOffset === null ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return NextResponse.json({ ok: false, error: 'offset must be a non-negative integer' }, { status: 400 });
    }

    const items = await listShadowLibrarySources({
      organizationId: principal.organizationId,
      sourceType: sourceType ?? undefined,
      status: status ?? undefined,
      generalResearch: generalResearch === null ? undefined : generalResearch === 'true',
      limit,
      offset,
    });

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
      title?: unknown;
      publisher?: unknown;
      source_type?: unknown;
      authority_tier?: unknown;
      url?: unknown;
      publication_date?: unknown;
      status?: unknown;
      metadata?: unknown;
    };

    if (typeof body.title !== 'string' || !body.title.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing source title' }, { status: 400 });
    }

    if (!isSourceType(body.source_type)) {
      return NextResponse.json({ ok: false, error: 'Unsupported source_type' }, { status: 400 });
    }

    if (body.publisher !== undefined && body.publisher !== null && typeof body.publisher !== 'string') {
      return NextResponse.json({ ok: false, error: 'publisher must be a string' }, { status: 400 });
    }

    if (body.url !== undefined && body.url !== null && typeof body.url !== 'string') {
      return NextResponse.json({ ok: false, error: 'url must be a string' }, { status: 400 });
    }

    // clampAuthorityTier would silently coerce an out-of-range tier, and
    // authority tier drives both search ranking and coverage evaluation. A
    // caller that means tier 9 should be told it is wrong, not quietly given
    // tier 5.
    if (
      body.authority_tier !== undefined
      && (!Number.isSafeInteger(body.authority_tier) || (body.authority_tier as number) < 1 || (body.authority_tier as number) > 5)
    ) {
      return NextResponse.json({ ok: false, error: 'authority_tier must be an integer between 1 and 5' }, { status: 400 });
    }

    if (
      body.publication_date !== undefined
      && body.publication_date !== null
      && (typeof body.publication_date !== 'string' || !ISO_DATE.test(body.publication_date))
    ) {
      return NextResponse.json({ ok: false, error: 'publication_date must be YYYY-MM-DD' }, { status: 400 });
    }

    if (body.status !== undefined && !isSourceStatus(body.status)) {
      return NextResponse.json({ ok: false, error: 'Unsupported status' }, { status: 400 });
    }

    if (
      body.metadata !== undefined
      && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))
    ) {
      return NextResponse.json({ ok: false, error: 'metadata must be an object' }, { status: 400 });
    }

    // The classification taxonomy is a shared contract (issue #345): a label
    // arriving through registration is held to the same domain/layer lists
    // the correction PATCH enforces, so no route can file a source outside
    // either taxonomy.
    const classificationDomain = (body.metadata as Record<string, unknown> | undefined)?.classification_domain;
    if (classificationDomain !== undefined && !isResearchClassificationDomain(classificationDomain)) {
      return NextResponse.json({ ok: false, error: 'Unsupported classification_domain' }, { status: 400 });
    }

    const classificationLayer = (body.metadata as Record<string, unknown> | undefined)?.classification_layer;
    if (classificationLayer !== undefined && !isResearchClassificationLayer(classificationLayer)) {
      return NextResponse.json({ ok: false, error: 'Unsupported classification_layer' }, { status: 400 });
    }

    const source = await createShadowLibrarySource({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      title: body.title,
      publisher: (body.publisher as string | null | undefined) ?? null,
      sourceType: body.source_type,
      authorityTier: body.authority_tier as number | undefined,
      url: (body.url as string | null | undefined) ?? null,
      publicationDate: (body.publication_date as string | null | undefined) ?? null,
      status: body.status as ShadowLibrarySourceStatus | undefined,
      metadata: body.metadata as Record<string, unknown> | undefined,
    });

    return NextResponse.json({ ok: true, source }, { status: 201 });
  } catch (error) {
    // shadow_library_sources has unique (organization_id, url). Re-registering
    // the same URL is a caller conflict, not a server fault.
    if (error instanceof Error && error.message.includes('duplicate key value')) {
      return NextResponse.json(
        { ok: false, error: 'A source with this URL is already registered in this organization' },
        { status: 409 },
      );
    }
    return jsonError(error);
  }
}

// Classification correction (issue #345 workflow 3). Curator-gated like every
// other write here, and narrower than all of them: two metadata keys, each
// human-picked from its own shared taxonomy, nothing else about the source
// reachable. domain and layer are independent axes -- a caller may correct
// either one alone, or both together.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);

    const body = (await request.json().catch(() => ({}))) as {
      source_id?: unknown;
      classification_domain?: unknown;
      classification_layer?: unknown;
    };

    if (typeof body.source_id !== 'string' || !body.source_id.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing source_id' }, { status: 400 });
    }

    if (body.classification_domain === undefined && body.classification_layer === undefined) {
      return NextResponse.json(
        { ok: false, error: 'Provide classification_domain and/or classification_layer' },
        { status: 400 },
      );
    }
    if (body.classification_domain !== undefined && !isResearchClassificationDomain(body.classification_domain)) {
      return NextResponse.json({ ok: false, error: 'Unsupported classification_domain' }, { status: 400 });
    }
    if (body.classification_layer !== undefined && !isResearchClassificationLayer(body.classification_layer)) {
      return NextResponse.json({ ok: false, error: 'Unsupported classification_layer' }, { status: 400 });
    }

    const source = await updateShadowLibrarySourceClassification(
      principal.organizationId,
      body.source_id.trim(),
      {
        domain: body.classification_domain as string | undefined,
        layer: body.classification_layer as string | undefined,
      },
    );

    if (!source) return hiddenNotFound();
    return NextResponse.json({ ok: true, source });
  } catch (error) {
    return jsonError(error);
  }
}
