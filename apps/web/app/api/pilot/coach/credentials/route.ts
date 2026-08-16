import { createHash } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { uploadPilotCredentialFile } from '@/src/server/pilot/blob';
import {
  deriveCredentialBand,
  listClearanceTypes,
  listPersonClearances,
  recordPersonClearance,
  STAFF_CREDENTIAL_ROLES,
} from '@/src/server/pilot/clearanceRegister';
import {
  describeCredentialUpload,
  validateCredentialContent,
  validateCredentialUploadTransport,
} from '@/src/server/pilot/credentialUploadPolicy';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Self-upload your own staff credential documents (SafeSport, USA Boxing
 * coach cert, background check, CPR/First Aid, ...).
 *
 * The route takes no account id, matching /api/pilot/profile/photo: a
 * person uploads THEIR OWN document, never someone else's. Uploading always
 * sets status='submitted' and clears any prior verification (verified_by,
 * verified_at, issued_on, expires_on) -- see clearanceRegister.ts's own
 * header on why this module never sets status='current' itself. A new
 * document invalidates whatever an admin previously confirmed about the old
 * one; only /api/pilot/admin/credentials can move a submission to 'current'.
 */
const SELF_UPLOAD_ROLES = STAFF_CREDENTIAL_ROLES;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SELF_UPLOAD_ROLES]);

    const [clearanceTypes, myClearances] = await Promise.all([
      listClearanceTypes(principal.organizationId, { active: true }),
      listPersonClearances(principal.organizationId, { personAccountId: principal.accountId }),
    ]);

    const byType = new Map(myClearances.map((row) => [row.clearance_type_id, row]));

    return NextResponse.json({
      ok: true,
      items: clearanceTypes.map((type) => {
        const mine = byType.get(type.clearance_type_id) ?? null;
        return {
          clearance_type_id: type.clearance_type_id,
          name: type.name,
          issuing_authority: type.issuing_authority,
          validity_months: type.validity_months,
          status: mine?.status ?? 'not_started',
          band: deriveCredentialBand(mine?.status ?? 'not_started', mine?.expires_on ?? null),
          issued_on: mine?.issued_on ?? null,
          expires_on: mine?.expires_on ?? null,
          verification_note: mine?.verification_note ?? null,
          // Never document_ref -- even to the document's own owner, on this
          // list response. /api/pilot/credentials/document is the one path
          // to the bytes.
          has_document: Boolean(mine?.document_ref),
        };
      }),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SELF_UPLOAD_ROLES]);

    const transport = validateCredentialUploadTransport(request.headers);
    if (!transport.ok) {
      return NextResponse.json({ ok: false, error: transport.error }, { status: transport.status });
    }

    const formData = await request.formData();
    const clearanceTypeId = formData.get('clearance_type_id');
    if (typeof clearanceTypeId !== 'string' || !clearanceTypeId.trim()) {
      throw new ValidationError('Missing clearance_type_id.');
    }

    const clearanceTypes = await listClearanceTypes(principal.organizationId, { active: true });
    const clearanceType = clearanceTypes.find((type) => type.clearance_type_id === clearanceTypeId);
    if (!clearanceType) {
      throw new ValidationError('Unsupported clearance_type_id: not an active clearance type for this organization.');
    }

    const uploaded = formData.get('document');
    if (!(uploaded instanceof File)) {
      return NextResponse.json({ ok: false, error: 'Missing document upload.' }, { status: 400 });
    }

    const descriptor = describeCredentialUpload(uploaded);
    if (!descriptor) {
      return NextResponse.json(
        { ok: false, error: 'Only bounded PDF, JPG, or PNG documents are accepted.' },
        { status: 415 },
      );
    }

    const bytes = new Uint8Array(await uploaded.arrayBuffer());
    const validation = validateCredentialContent(descriptor, bytes);
    if (!validation.ok) {
      return NextResponse.json({ ok: false, error: validation.error }, { status: validation.status ?? 415 });
    }

    const blobPath = `${principal.organizationId}/${principal.accountId}/${clearanceTypeId}/${descriptor.generatedFileName}`;
    await uploadPilotCredentialFile(blobPath, bytes, descriptor.contentType);
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');

    // Uploading resets verification on purpose: a new document is a new
    // submission, and the old one's issued_on/expires_on may no longer be
    // true of it. clearanceRegister's own header says a status transition to
    // 'current' only happens via an explicit admin action -- this write
    // deliberately never passes status: 'current'.
    const result = await recordPersonClearance({
      organizationId: principal.organizationId,
      personAccountId: principal.accountId,
      clearanceTypeId,
      status: 'submitted',
      documentRef: blobPath,
      issuedOn: null,
      expiresOn: null,
      verifiedByAccountId: null,
      verificationNote: null,
    });

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'person_clearance',
      entity_id: result.clearance_id,
      details: {
        action: 'credential_submitted',
        clearance_type_id: clearanceTypeId,
        content_type: descriptor.contentType,
        stored_bytes: bytes.byteLength,
        content_sha256: contentSha256,
      },
      shadow_mirror: false,
    });

    return NextResponse.json(
      {
        ok: true,
        status: 'submitted',
        message: 'Uploaded. An administrator verifies it before it shows as current.',
      },
      { status: 202 },
    );
  } catch (error) {
    return jsonError(error);
  }
}
