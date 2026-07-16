import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { createShadowLibrarySource, listShadowLibrarySources, type ShadowLibrarySourceStatus, type ShadowLibrarySourceType } from '@/src/server/pilot/shadowLibrary';

export const runtime = 'nodejs';

const requiredShadowLibraryTables = [
  'shadow_library_sources',
  'shadow_library_documents',
  'shadow_library_chunks',
  'shadow_library_capability_map',
];

function parseSourceType(value: string | undefined): ShadowLibrarySourceType | undefined {
  if (!value) return undefined;
  const allowed: ShadowLibrarySourceType[] = [
    'peer_reviewed',
    'clinical_guideline',
    'governing_body',
    'coach_observation',
    'athlete_self_report',
    'sensor_data',
    'internal_policy',
    'textbook',
    'media',
    'other',
  ];
  return allowed.includes(value as ShadowLibrarySourceType) ? (value as ShadowLibrarySourceType) : undefined;
}

function parseSourceStatus(value: string | undefined): ShadowLibrarySourceStatus | undefined {
  if (!value) return undefined;
  const allowed: ShadowLibrarySourceStatus[] = ['active', 'archived', 'rejected', 'quarantined'];
  return allowed.includes(value as ShadowLibrarySourceStatus) ? (value as ShadowLibrarySourceStatus) : undefined;
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'volunteer', 'staff']);
    await assertShadowRuntimeReadiness({ requiredTables: requiredShadowLibraryTables });

    const params = request.nextUrl.searchParams;
    const sourceType = parseSourceType(params.get('source_type') ?? undefined);
    const status = parseSourceStatus(params.get('status') ?? undefined);
    const limit = Number(params.get('limit'));
    const offset = Number(params.get('offset'));

    const items = await listShadowLibrarySources({
      organizationId: principal.organizationId,
      sourceType,
      status,
      limit,
      offset,
    });

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach']);
    await assertShadowRuntimeReadiness({ requiredTables: requiredShadowLibraryTables });

    const body = (await request.json().catch(() => ({}))) as {
      title?: string;
      publisher?: string;
      source_type?: string;
      authority_tier?: number;
      url?: string;
      publication_date?: string;
      status?: string;
      metadata?: Record<string, unknown>;
    };

    const sourceType = parseSourceType(body.source_type);
    const status = parseSourceStatus(body.status);

    if (!body.title?.trim()) {
      return NextResponse.json({ ok: false, error: 'missing title' }, { status: 400 });
    }

    if (!sourceType) {
      return NextResponse.json({ ok: false, error: 'invalid source_type' }, { status: 400 });
    }

    const item = await createShadowLibrarySource({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      title: body.title,
      publisher: body.publisher,
      sourceType,
      authorityTier: body.authority_tier,
      url: body.url,
      publicationDate: body.publication_date,
      status,
      metadata: body.metadata,
    });

    return NextResponse.json({ ok: true, source: item });
  } catch (error) {
    return jsonError(error);
  }
}
