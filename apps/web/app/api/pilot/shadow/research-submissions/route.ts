import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  createResearchSubmission,
  isResearchDomain,
  listResearchSubmissions,
  RESEARCH_DOMAINS,
} from '@/src/server/pilot/shadowResearchSubmissions';
import { SHADOW_LIBRARY_CURATOR_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

// Filing a submission against a research requirement or registering general
// research is a curation act — it requires the same authority as curating a
// library source so that the submission chain is consistent: source curator
// → submission curator → evidence reviewer.
//
// domain_classification is validated against RESEARCH_DOMAINS on both GET
// (filter) and POST (general research) so the shared constant is the single
// authority for valid domain values.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_research_submissions'] });

    const params = new URL(request.url).searchParams;
    const rawReqId = params.get('research_requirement_id');
    const researchRequirementId = rawReqId !== null ? parseInt(rawReqId, 10) : undefined;

    if (researchRequirementId !== undefined && (!Number.isInteger(researchRequirementId) || researchRequirementId <= 0)) {
      return NextResponse.json({ ok: false, error: 'Invalid research_requirement_id' }, { status: 400 });
    }

    const items = await listResearchSubmissions(principal.organizationId, {
      researchRequirementId,
    });

    return NextResponse.json({ ok: true, organization_id: principal.organizationId, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);
    await assertShadowRuntimeReadiness({ requiredTables: ['shadow_research_submissions'] });

    const body = (await request.json().catch(() => ({}))) as {
      // Required for "Answer a Gap"
      research_requirement_id?: number;
      source_id?: string;
      // Optional provenance
      doi?: string | null;
      pmid?: string | null;
      provider_provenance?: string | null;
      why_this_source?: string | null;
      // For "General Research" — domain classification stored in metadata
      domain_classification?: string | null;
      metadata?: Record<string, unknown>;
    };

    if (!body.source_id || typeof body.source_id !== 'string') {
      return NextResponse.json({ ok: false, error: 'source_id is required' }, { status: 400 });
    }

    if (!body.research_requirement_id || typeof body.research_requirement_id !== 'number' || body.research_requirement_id <= 0) {
      return NextResponse.json({ ok: false, error: 'research_requirement_id is required' }, { status: 400 });
    }

    // domain_classification is optional but must be a valid taxonomy value when present.
    if (body.domain_classification !== undefined && body.domain_classification !== null) {
      if (!isResearchDomain(body.domain_classification)) {
        return NextResponse.json(
          {
            ok: false,
            error: `domain_classification must be one of: ${RESEARCH_DOMAINS.join(', ')}`,
          },
          { status: 400 },
        );
      }
    }

    const metadata: Record<string, unknown> = { ...(body.metadata ?? {}) };
    if (body.domain_classification != null) {
      metadata['domain_classification'] = body.domain_classification;
    }

    const submission = await createResearchSubmission({
      organizationId: principal.organizationId,
      researchRequirementId: body.research_requirement_id,
      sourceId: body.source_id,
      submittedByAccountId: principal.accountId,
      submittedByRole: principal.role,
      doi: body.doi ?? null,
      pmid: body.pmid ?? null,
      providerProvenance: body.provider_provenance ?? null,
      whyThisSource: body.why_this_source ?? null,
      metadata,
    });

    return NextResponse.json({ ok: true, submission }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
