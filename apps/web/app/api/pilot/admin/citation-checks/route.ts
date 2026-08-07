import { NextResponse, type NextRequest } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  getSourceCitationStatus,
  getSourcesNeedingCitationCheck,
  listSourceCitationChecks,
  type SourceCitationReviewSignal,
} from '@/src/server/pilot/sourceCitationChecks';

export const runtime = 'nodejs';

const REVIEW_ROLES = ['organization_admin', 'admin', 'platform_owner'] as const;

const REVIEW_SIGNALS: ReadonlySet<string> = new Set([
  'needs_adjudication',
  'recheck_pending',
  'not_machine_checkable',
  'ok',
]);

// Read-only: this route has no POST/PATCH. Every row in source_citation_checks
// is written by apps/web/scripts/verify-research-citations.mjs, never by the
// app -- see sourceCitationChecks.ts's own header for why. What this route
// gives a reviewer is the latest status per source (review_signal flags what
// needs a look), the raw per-source history, and the still-outstanding queue.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);

    const { searchParams } = new URL(request.url);
    const sourceId = searchParams.get('source_id');
    if (sourceId) {
      const checks = await listSourceCitationChecks(principal.organizationId, sourceId);
      return NextResponse.json({ checks });
    }

    if (searchParams.get('view') === 'queue') {
      const rawLimit = searchParams.get('limit');
      const limit = rawLimit === null ? 500 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
        return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
      }
      const queue = await getSourcesNeedingCitationCheck(principal.organizationId, limit);
      return NextResponse.json({ queue });
    }

    const rawSignal = searchParams.get('review_signal');
    if (rawSignal !== null && !REVIEW_SIGNALS.has(rawSignal)) {
      return NextResponse.json({ error: 'Invalid review_signal' }, { status: 400 });
    }

    const status = await getSourceCitationStatus(principal.organizationId, {
      reviewSignal: (rawSignal as SourceCitationReviewSignal | null) ?? undefined,
    });
    return NextResponse.json({ status });
  } catch (error) {
    return jsonError(error);
  }
}
