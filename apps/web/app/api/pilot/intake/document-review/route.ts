// POST /api/pilot/intake/document-review — human security review of one
// intake document.
//
// Uploads are born pending_security_review, and the state case approval
// requires (scanned clean + extraction ready) had no producer: the automated
// scanner the requirement assumed (#17) was never built, so approval was
// unreachable and the E2E gate has carried a KNOWN GAP branch since #60.
// This route is the producer. It is deliberately a human attestation, not a
// scanner: the reviewer opens the document (see document-link), reads it,
// and records 'clean' or 'quarantined'. 'clean' writes exactly what
// isIntakeDocumentReadyForReview checks; 'quarantined' writes states that can
// never satisfy it, so one bad document keeps the whole case unapprovable.
import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  isIntakeDocumentReadyForReview,
  reviewIntakeDocumentSecurity,
  type IntakeDocumentSecurityDecision,
} from '@/src/server/pilot/intake';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';

export const runtime = 'nodejs';

const DECISIONS = new Set<IntakeDocumentSecurityDecision>(['clean', 'quarantined']);

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // Same reviewers who can approve the case: document review is a step of
    // the same duty, and a wider set here would let someone unlock an
    // approval they could not perform.
    requireRole(principal, ['organization_admin', 'coach']);
    await assertShadowRuntimeReadiness({ requiredTables: ['intake_documents'] });

    const body = await request.json().catch(() => ({}));
    const intakeDocumentId = typeof body.intake_document_id === 'string' ? body.intake_document_id.trim() : '';
    const decision = body.decision as IntakeDocumentSecurityDecision;
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 2000) : undefined;
    if (!intakeDocumentId) {
      throw new Error('Missing intake_document_id');
    }
    if (!DECISIONS.has(decision)) {
      throw new Error('Missing decision: expected "clean" or "quarantined"');
    }

    const updated = await reviewIntakeDocumentSecurity({
      organizationId: principal.organizationId,
      intakeDocumentId,
      decision,
      reviewedByAccountId: principal.accountId,
      reviewedByRole: principal.role,
      notes,
    });
    if (!updated) {
      throw new Error('Not found: intake document');
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'intake_document',
      entity_id: intakeDocumentId,
      details: {
        action: 'document_security_review',
        decision,
        intake_case_id: updated.intake_case_id,
        file_name: updated.file_name,
        notes: notes ?? '',
      },
      shadow_mirror: false,
    });

    return NextResponse.json({
      ok: true,
      intake_document_id: intakeDocumentId,
      intake_case_id: updated.intake_case_id,
      decision,
      ready_for_review: isIntakeDocumentReadyForReview(updated),
    });
  } catch (error) {
    return jsonError(error);
  }
}
