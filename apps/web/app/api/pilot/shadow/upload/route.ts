import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { uploadPilotShadowFile } from '@/src/server/pilot/blob';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { createIntakeCase, createIntakeDocument, type IntakeDocumentType } from '@/src/server/pilot/intake';
import { assertShadowAuthority, type ShadowAutomationMode } from '@/src/server/pilot/shadowAuthority';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { createShadowResearchRequirement } from '@/src/server/pilot/shadowResearch';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';
import { buildUploadResearchFields, classifyShadowDocument, routeShadowClassification } from '@/src/server/pilot/shadow';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    await assertShadowRuntimeReadiness({
      requireBlob: true,
      requiredTables: ['intake_cases', 'intake_documents', 'shadow_intake', 'shadow_events', 'shadow_telemetry_events', 'shadow_authority_checks'],
    });

    const formData = await request.formData();
    const uploaded = formData.get('file');
    const hintValue = formData.get('hint');
    const intakeCaseIdValue = formData.get('intake_case_id');
    const documentTypeValue = formData.get('document_type');
    const automationModeValue = formData.get('automation_mode');
    const hint = typeof hintValue === 'string' ? hintValue : undefined;
    const intakeCaseIdInput = typeof intakeCaseIdValue === 'string' ? intakeCaseIdValue.trim() : '';
    const automationMode: ShadowAutomationMode =
      automationModeValue === 'automatic' || automationModeValue === 'manual'
        ? automationModeValue
        : 'assisted';
    const documentType: IntakeDocumentType =
      typeof documentTypeValue === 'string' && documentTypeValue.trim()
        ? (documentTypeValue.trim() as IntakeDocumentType)
        : 'general_intake';

    if (!(uploaded instanceof File)) {
      throw new TypeError('Missing file upload payload');
    }

    await assertShadowAuthority({
      actor: principal,
      organizationId: principal.organizationId,
      action: 'intake.shadow_upload',
      automationMode,
      confidenceTier: 'SUFFICIENT_FOR_REVIEW',
      sourceConfidenceTier: 'SUFFICIENT_FOR_REVIEW',
      sourceVerificationState: 'unverified',
      lowRisk: true,
      reversible: true,
      withinApprovedOptions: true,
      restrictionConflict: false,
      metadata: {
        file_name: uploaded.name,
        document_type: documentType,
      },
    });

    const intakeId = randomUUID();
    const filePath = `${intakeId}/${uploaded.name}`;

    await uploadPilotShadowFile(filePath, uploaded);

    const classification = classifyShadowDocument(uploaded.name, hint);
    const routedQueue = routeShadowClassification(classification);
    const researchFields = buildUploadResearchFields({
      fileName: uploaded.name,
      documentType,
      classification,
      routedQueue,
    });

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
      shadow_mirror: false,
    });

    await writePilotAuditEvent({
      event_type: 'shadow_routing',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'shadow_intake',
      entity_id: intakeId,
      details: { routed_queue: routedQueue, intake_case_id: intakeCaseId, intake_document_id: intakeDocumentId },
      shadow_mirror: false,
    });

    await emitShadowEvent({
      organizationId: principal.organizationId,
      eventName: 'SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED',
      entityType: 'shadow_intake',
      entityId: intakeId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      payload: {
        file_name: uploaded.name,
        intake_case_id: intakeCaseId,
        intake_document_id: intakeDocumentId,
        document_type: documentType,
        classification,
        routed_queue: routedQueue,
        automation_mode: automationMode,
        research_requirement: researchFields.researchRequirement,
        knowledge_gap: researchFields.knowledgeGap,
        source_status: researchFields.sourceStatus,
        source_verification_state: researchFields.sourceVerificationState,
      },
    });

    await createShadowResearchRequirement({
      organizationId: principal.organizationId,
      sourceEventName: 'SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED',
      sourceEntityType: 'shadow_intake',
      sourceEntityId: intakeId,
      researchRequirement: researchFields.researchRequirement,
      knowledgeGap: researchFields.knowledgeGap,
      evidenceLabel: classification,
      sourceStatus: researchFields.sourceStatus,
      sourceConfidenceTier: 'SUFFICIENT_FOR_REVIEW',
      sourceVerificationState: researchFields.sourceVerificationState,
      createdByAccountId: principal.accountId,
      createdByRole: principal.role,
      metadata: {
        file_name: uploaded.name,
        intake_case_id: intakeCaseId,
        intake_document_id: intakeDocumentId,
        document_type: documentType,
        routed_queue: routedQueue,
      },
    });

    await writeShadowTelemetryEvent({
      organizationId: principal.organizationId,
      metricName: 'shadow.intake.upload',
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      dimensions: {
        document_type: documentType,
        classification,
        routed_queue: routedQueue,
        automation_mode: automationMode,
        source_verification_state: researchFields.sourceVerificationState,
      },
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
