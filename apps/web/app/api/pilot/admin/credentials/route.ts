import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  computeClearanceExpiry,
  deriveCredentialBand,
  getPersonClearanceForOrganization,
  listClearanceTypes,
  listPersonClearancesForVerification,
  recordPersonClearance,
} from '@/src/server/pilot/clearanceRegister';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { staffDisplayName } from '@/src/server/pilot/profileDb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The admin verification queue (module: staff credentials).
 *
 * GET lists every person_clearances row in the organization -- submitted,
 * current, expired, revoked -- so an admin sees both the review queue and
 * the standing alerts (expired = critical, expiring within 30 days =
 * warning) in one read. Unlike /api/pilot/staff-credentials, this one DOES
 * carry document_ref-derived download access (via
 * /api/pilot/credentials/document) and the verification_note, because
 * reviewing a submission is the entire point of this page.
 *
 * POST is action-dispatched, mirroring behavior-standards and floor-groups:
 *
 *   'verify' -- moves a submission to status='current'. Requires issued_on;
 *   expires_on may be supplied explicitly or left for the server to suggest
 *   from the clearance type's validity_months (computeClearanceExpiry) --
 *   either way the admin's own request is what gets stored, never a value
 *   inferred and written without the admin's request naming it.
 *
 *   'reject' -- sends a submission back to status='not_started' with a
 *   required note explaining why, so the person sees what to fix on their
 *   next upload. pilot.person_clearances has no 'rejected' status in its
 *   vocabulary (only not_started/submitted/current/expired/revoked/
 *   not_required -- see the clearance-register migration's check
 *   constraint), and widening that constraint is real schema work this
 *   ticket's own guidance says should not be needed; 'not_started' plus an
 *   attributed verification_note is the closest existing state that does
 *   not claim anything about the document that is not true.
 *
 * Both actions require an EXISTING person_clearances row scoped to this
 * organization (getPersonClearanceForOrganization) before touching
 * anything -- there is no path here that creates a clearance record for an
 * account that never submitted one, and no path that can act on another
 * organization's account by guessing an id: a row from a different
 * organization simply does not exist under this organization's scope.
 */
const ADMIN_ROLES = ['organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ADMIN_ROLES]);

    const rows = await listPersonClearancesForVerification(principal.organizationId);

    return NextResponse.json({
      ok: true,
      items: rows.map((row) => ({
        clearance_id: row.clearance_id,
        person_account_id: row.person_account_id,
        person_display_name: staffDisplayName(row.person_login_email, row.person_account_id),
        person_role: row.person_role,
        clearance_type_id: row.clearance_type_id,
        clearance_name: row.clearance_name,
        issuing_authority: row.issuing_authority,
        validity_months: row.validity_months,
        status: row.status,
        band: deriveCredentialBand(row.status, row.expires_on),
        issued_on: row.issued_on,
        expires_on: row.expires_on,
        has_document: Boolean(row.document_ref),
        verified_by_account_id: row.verified_by_account_id,
        verified_at: row.verified_at,
        verification_note: row.verification_note,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ADMIN_ROLES]);

    const body = (await request.json()) as Record<string, unknown>;
    const personAccountId = text(body.person_account_id)?.trim();
    const clearanceTypeId = text(body.clearance_type_id)?.trim();
    if (!personAccountId || !clearanceTypeId) {
      throw new ValidationError('Missing person_account_id or clearance_type_id.');
    }

    const existing = await getPersonClearanceForOrganization(
      principal.organizationId,
      personAccountId,
      clearanceTypeId,
    );
    if (!existing) return hiddenNotFound();

    if (body.action === 'verify') {
      const issuedOn = text(body.issued_on)?.trim();
      if (!issuedOn) {
        throw new ValidationError('verify needs issued_on -- the date a human confirmed this clearance was issued.');
      }

      const clearanceTypes = await requireClearanceType(principal.organizationId, clearanceTypeId);
      const expiresOn = text(body.expires_on)?.trim()
        || computeClearanceExpiry(issuedOn, clearanceTypes.validity_months);

      const updated = await recordPersonClearance({
        organizationId: principal.organizationId,
        personAccountId,
        clearanceTypeId,
        status: 'current',
        issuedOn,
        expiresOn: expiresOn ?? null,
        documentRef: existing.document_ref,
        verifiedByAccountId: principal.accountId,
        verificationNote: text(body.note)?.trim() || null,
      });

      await audit(principal, updated.clearance_id, {
        action: 'credential_verified',
        clearance_type_id: clearanceTypeId,
        person_account_id: personAccountId,
        issued_on: issuedOn,
        expires_on: expiresOn ?? null,
      });

      return NextResponse.json({ ok: true, item: { status: updated.status, expires_on: updated.expires_on } });
    }

    if (body.action === 'reject') {
      const note = text(body.note)?.trim();
      if (!note) {
        throw new ValidationError('reject needs a note explaining what the person should fix before resubmitting.');
      }

      const updated = await recordPersonClearance({
        organizationId: principal.organizationId,
        personAccountId,
        clearanceTypeId,
        status: 'not_started',
        issuedOn: null,
        expiresOn: null,
        documentRef: existing.document_ref,
        verifiedByAccountId: principal.accountId,
        verificationNote: note,
      });

      await audit(principal, updated.clearance_id, {
        action: 'credential_rejected',
        clearance_type_id: clearanceTypeId,
        person_account_id: personAccountId,
      });

      return NextResponse.json({ ok: true, item: { status: updated.status } });
    }

    throw new ValidationError("action must be 'verify' or 'reject'.");
  } catch (error) {
    return jsonError(error);
  }
}

async function requireClearanceType(organizationId: string, clearanceTypeId: string) {
  const types = await listClearanceTypes(organizationId, {});
  const found = types.find((type) => type.clearance_type_id === clearanceTypeId);
  if (!found) {
    throw new ValidationError('Unsupported clearance_type_id: not a clearance type for this organization.');
  }
  return found;
}

async function audit(principal: PilotPrincipal, entityId: string, details: Record<string, unknown>) {
  await writePilotAuditEvent({
    event_type: 'update',
    actor_account_id: principal.accountId,
    actor_role: principal.role,
    organization_id: principal.organizationId,
    entity_type: 'person_clearance',
    entity_id: entityId,
    details,
    shadow_mirror: false,
  });
}
