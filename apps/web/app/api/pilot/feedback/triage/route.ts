import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  FEEDBACK_NOTE_MAX_LENGTH,
  isFeedbackTriageStatus,
  setFeedbackTriage,
} from '@/src/server/pilot/feedback';
import { jsonError, requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * Working the queue: an administrator of the gym that received a submission
 * sets its status and leaves a note.
 *
 * Restricted to that gym's own administrators. The platform owner reads across
 * every gym de-identified and does not act here: acting on a submission means
 * knowing who wrote it, which is the thing the owner's read deliberately does
 * not carry.
 *
 * The audit event records who moved a submission and where to. It carries no
 * body, no note, no route and no submitter -- pilot.audit_events is readable by
 * this organization's coaches, and a coach is one of the people a child's
 * disclosure can be about.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireMicrosoftAuthenticatedPrincipal(request);
    if (!isOrganizationAdminRole(principal.role)) {
      throw new Error('Forbidden: role not allowed');
    }

    const payload = (await request.json().catch(() => ({}))) as {
      submission_id?: unknown;
      triage_status?: unknown;
      triage_note?: unknown;
    };

    const submissionId = typeof payload.submission_id === 'string' ? payload.submission_id.trim() : '';
    const triageStatus = typeof payload.triage_status === 'string' ? payload.triage_status.trim() : '';
    const rawNote = typeof payload.triage_note === 'string' ? payload.triage_note.trim() : '';
    // An empty field is "no note this time", which leaves whatever note is
    // already on the row rather than blanking a colleague's handover.
    const note = rawNote || null;

    if (!submissionId) {
      throw new Error('Missing submission_id');
    }

    if (!isFeedbackTriageStatus(triageStatus)) {
      throw new Error('Unsupported triage_status');
    }

    if (note && note.length > FEEDBACK_NOTE_MAX_LENGTH) {
      throw new Error(`Unsupported triage_note: longer than ${FEEDBACK_NOTE_MAX_LENGTH} characters`);
    }

    const updated = await setFeedbackTriage({
      organizationId: principal.organizationId,
      submissionId,
      triageStatus,
      note,
      triagedByAccountId: principal.accountId,
    });

    if (!updated) {
      return NextResponse.json({ ok: true, updated: false });
    }

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'feedback_submission',
      entity_id: updated.submission_id,
      details: {
        triage_status: updated.triage_status,
        note_written: note !== null,
      },
    });

    return NextResponse.json({ ok: true, updated: true, submission: updated });
  } catch (error) {
    return jsonError(error);
  }
}
