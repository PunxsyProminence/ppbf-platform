import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import {
  getSourceRetractionStatus,
  getSourcesNeedingRetractionCheck,
  listSourceRetractionChecks,
  recordRetractionDisposition,
  suppressSource,
  unsuppressSource,
  type SourceRetractionActionSignal,
  type SourceRetractionDisposition,
} from '@/src/server/pilot/sourceRetractionChecks';

export const runtime = 'nodejs';

const REVIEW_ROLES = ['organization_admin', 'admin', 'platform_owner'] as const;

const ACTION_SIGNALS: ReadonlySet<string> = new Set([
  'urgent_unhandled',
  'needs_review',
  'informational',
  'recheck_pending',
  'not_surveillable',
  'handled',
]);

const DISPOSITIONS: ReadonlySet<string> = new Set([
  'suppress_source',
  'keep_with_caveat',
  'claim_unaffected',
  'superseded_by_newer',
  'under_review',
]);

// GET is read-only: every row in source_retraction_checks is written by
// apps/web/scripts/check-source-retractions.mjs, never by the app. PATCH is
// where a human disposes of a finding and/or suppresses a source from
// retrieval -- two distinct, explicit actions, matching sourceRetractionChecks.ts's
// own separation between "the check raises it" and "a person disposes of it."
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);

    const { searchParams } = new URL(request.url);
    const sourceId = searchParams.get('source_id');
    if (sourceId) {
      const checks = await listSourceRetractionChecks(principal.organizationId, sourceId);
      return NextResponse.json({ checks });
    }

    if (searchParams.get('view') === 'queue') {
      const rawLimit = searchParams.get('limit');
      const limit = rawLimit === null ? 500 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
        return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
      }
      const queue = await getSourcesNeedingRetractionCheck(principal.organizationId, limit);
      return NextResponse.json({ queue });
    }

    const rawSignal = searchParams.get('action_signal');
    if (rawSignal !== null && !ACTION_SIGNALS.has(rawSignal)) {
      return NextResponse.json({ error: 'Invalid action_signal' }, { status: 400 });
    }

    const status = await getSourceRetractionStatus(principal.organizationId, {
      actionSignal: (rawSignal as SourceRetractionActionSignal | null) ?? undefined,
    });
    return NextResponse.json({ status });
  } catch (error) {
    return jsonError(error);
  }
}

type PatchBody = {
  action?: unknown;
  retraction_check_id?: unknown;
  disposition?: unknown;
  disposition_note?: unknown;
  source_id?: unknown;
  reason?: unknown;
};

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);
    const body = (await request.json()) as PatchBody;

    if (body.action === 'disposition') {
      if (
        typeof body.retraction_check_id !== 'string' || !body.retraction_check_id
        || typeof body.disposition !== 'string' || !DISPOSITIONS.has(body.disposition)
        || typeof body.disposition_note !== 'string' || !body.disposition_note.trim()
      ) {
        return NextResponse.json({ error: 'Missing or invalid retraction_check_id, disposition, or disposition_note' }, { status: 400 });
      }

      const check = await recordRetractionDisposition({
        organizationId: principal.organizationId,
        retractionCheckId: body.retraction_check_id,
        disposition: body.disposition as SourceRetractionDisposition,
        dispositionNote: body.disposition_note,
        acknowledgedByAccountId: principal.accountId,
        actorRole: principal.role,
      });

      await writePilotAuditEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'source_retraction_check',
        entity_id: check.retraction_check_id,
        details: { disposition: check.disposition, source_id: check.source_id, status: check.status },
      });

      return NextResponse.json({ check });
    }

    if (body.action === 'suppress' || body.action === 'unsuppress') {
      if (typeof body.source_id !== 'string' || !body.source_id) {
        return NextResponse.json({ error: 'Missing source_id' }, { status: 400 });
      }

      if (body.action === 'suppress') {
        if (typeof body.reason !== 'string' || !body.reason.trim()) {
          return NextResponse.json({ error: 'Missing reason' }, { status: 400 });
        }
        await suppressSource({
          organizationId: principal.organizationId,
          sourceId: body.source_id,
          reason: body.reason,
          suppressedByAccountId: principal.accountId,
          actorRole: principal.role,
        });
      } else {
        await unsuppressSource({
          organizationId: principal.organizationId,
          sourceId: body.source_id,
          actorRole: principal.role,
        });
      }

      await writePilotAuditEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'shadow_library_source',
        entity_id: body.source_id,
        details: { retrieval_suppressed: body.action === 'suppress' },
      });

      return NextResponse.json({ success: true, source_id: body.source_id, retrieval_suppressed: body.action === 'suppress' });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error) {
    if (error instanceof Error && (error.message === 'SOURCE_NOT_FOUND' || error.message === 'RETRACTION_CHECK_NOT_FOUND')) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return jsonError(error);
  }
}
