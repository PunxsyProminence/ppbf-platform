import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { uploadPilotShadowFile } from '@/src/server/pilot/blob';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { createIntakeCase, createIntakeDocument, type IntakeDocumentType } from '@/src/server/pilot/intake';
import { classifyShadowDocument, routeShadowClassification } from '@/src/server/pilot/shadow';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const formData = await request.formData();
    const uploaded = formData.get('file');
    const hintValue = formData.get('hint');
    const intakeCaseIdValue = formData.get('intake_case_id');
    const documentTypeValue = formData.get('document_type');
    const hint = typeof hintValue === 'string' ? hintValue : undefined;
    const intakeCaseIdInput = typeof intakeCaseIdValue === 'string' ? intakeCaseIdValue.trim() : '';
    const documentType: IntakeDocumentType =
      typeof documentTypeValue === 'string' && documentTypeValue.trim()
        ? (documentTypeValue.trim() as IntakeDocumentType)
        : 'general_intake';

    if (!(uploaded instanceof File)) {
      throw new TypeError('Missing file upload payload');
    }

    const intakeId = randomUUID();
    const filePath = `${intakeId}/${uploaded.name}`;

    await uploadPilotShadowFile(filePath, uploaded);

    const classification = classifyShadowDocument(uploaded.name, hint);
    const routedQueue = routeShadowClassification(classification);

    const intakeCaseId =
      intakeCaseIdInput ||
      (await createIntakeCase({
        organizationId: principal.organizationId,
        submittedByAccountId: principal.accountId,
        summary: `SHADOW upload: ${uploaded.name}`,
        sourceShadowIntakeId: intakeId,
        payload: {
          file_name: uploaded.name,
          classification,
          routed_queue: routedQueue,
          document_type: documentType,
        },
      }));

    const intakeDocumentId = await createIntakeDocument({
      organizationId: principal.organizationId,
      intakeCaseId,
      shadowIntakeId: intakeId,
      documentType,
      fileName: uploaded.name,
      blobPath: filePath,
      classification,
      reviewStatus: 'pending_review',
      metadata: {
        hint: hint ?? null,
      },
    });

    await query(
      `insert into pilot.shadow_intake
       (organization_id, intake_id, file_name, file_path, classification, routed_queue, review_status, uploaded_by_account_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [principal.organizationId, intakeId, uploaded.name, filePath, classification, routedQueue, 'pending_human_review', principal.accountId],
    );

    await writePilotAuditEvent({
      event_type: 'shadow_classification',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'shadow_intake',
      entity_id: intakeId,
      details: { classification, intake_case_id: intakeCaseId, intake_document_id: intakeDocumentId, document_type: documentType },
    });

    await writePilotAuditEvent({
      event_type: 'shadow_routing',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'shadow_intake',
      entity_id: intakeId,
      details: { routed_queue: routedQueue, intake_case_id: intakeCaseId, intake_document_id: intakeDocumentId },
    });

    return NextResponse.json({
      ok: true,
      intake_id: intakeId,
      intake_case_id: intakeCaseId,
      intake_document_id: intakeDocumentId,
      document_type: documentType,
      classification,
      routed_queue: routedQueue,
      review_status: 'pending_human_review',
    });
  } catch (error) {
    return jsonError(error);
  }
}
