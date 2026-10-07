import { createHash, randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { uploadPilotShadowFile } from '@/src/server/pilot/blob';
import { query, queryOne } from '@/src/server/pilot/db';
import { ConflictError } from '@/src/server/pilot/errors';
import { isUuid, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  assertActorCanAccessIntakeCase,
  createIntakeCase,
  createIntakeDocument,
  type IntakeDocumentType,
} from '@/src/server/pilot/intake';
import { assertShadowAuthority, type ShadowAutomationMode } from '@/src/server/pilot/shadowAuthority';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';
import { buildUploadResearchFields, classifyShadowDocument, routeShadowClassification } from '@/src/server/pilot/shadow';
import {
  enforceShadowRateLimit,
  resolveShadowRateLimit,
  shadowRateLimitMessage,
  ShadowRateLimitExceeded,
} from '@/src/server/pilot/shadowRateLimit';
import {
  describeShadowUpload,
  SHADOW_INTAKE_DOCUMENT_TYPES,
  validateShadowUploadContent,
  validateShadowUploadTransport,
} from '@/src/server/pilot/shadowUploadPolicy';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // platform_owner is deliberately excluded: uploading source material into an
    // organization's SHADOW library is an in-organization authoring act, not a
    // platform-governance one. Omega reads across organizations; it does not
    // write content into them.
    requireRole(principal, ['organization_admin', 'coach']);
    await assertShadowRuntimeReadiness({
      requireBlob: true,
      requiredTables: ['intake_cases', 'intake_documents', 'shadow_intake', 'shadow_events', 'shadow_telemetry_events', 'shadow_authority_checks', 'shadow_rate_limit_buckets'],
    });

    const transport = validateShadowUploadTransport(request.headers);
    if (!transport.ok) {
      return NextResponse.json({ ok: false, error: transport.error }, { status: transport.status });
    }
    await enforceShadowRateLimit({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      ...resolveShadowRateLimit('shadow_upload'),
    });

    const formData = await request.formData();
    const uploaded = formData.get('file');
    const hintValue = formData.get('hint');
    const intakeCaseIdValue = formData.get('intake_case_id');
    const documentTypeValue = formData.get('document_type');
    const automationModeValue = formData.get('automation_mode');
    const hint = typeof hintValue === 'string' ? hintValue.trim().slice(0, 1_000) : undefined;
    const intakeCaseIdInput = typeof intakeCaseIdValue === 'string' ? intakeCaseIdValue.trim() : '';
    if (
      automationModeValue != null
      && automationModeValue !== 'automatic'
      && automationModeValue !== 'manual'
      && automationModeValue !== 'assisted'
    ) {
      return NextResponse.json({ ok: false, error: 'Invalid automation mode.' }, { status: 400 });
    }
    const automationMode: ShadowAutomationMode = automationModeValue ?? 'assisted';
    const requestedDocumentType = typeof documentTypeValue === 'string' && documentTypeValue.trim()
      ? documentTypeValue.trim()
      : 'general_intake';
    if (!SHADOW_INTAKE_DOCUMENT_TYPES.has(requestedDocumentType)) {
      return NextResponse.json({ ok: false, error: 'Unsupported intake document type.' }, { status: 400 });
    }
    const documentType = requestedDocumentType as IntakeDocumentType;

    if (!(uploaded instanceof File)) {
      throw new TypeError('Missing file upload payload');
    }
    const uploadDescriptor = describeShadowUpload(uploaded);
    if (!uploadDescriptor) {
      return NextResponse.json(
        { ok: false, error: 'Only bounded PDF, DOCX, and plain-text documents are accepted.' },
        { status: 415 },
      );
    }
    const uploadBytes = new Uint8Array(await uploaded.arrayBuffer());
    const contentValidation = validateShadowUploadContent(uploadDescriptor, uploadBytes);
    if (!contentValidation.ok) {
      return NextResponse.json(
        { ok: false, error: contentValidation.error },
        { status: 415 },
      );
    }
    const contentSha256 = createHash('sha256').update(uploadBytes).digest('hex');
    if (intakeCaseIdInput && !isUuid(intakeCaseIdInput)) {
      return NextResponse.json({ ok: false, error: 'Intake case not found.' }, { status: 404 });
    }

    // A supplied case is checked BEFORE the file is written (CL-A9, CL-C18).
    // The id used to go straight into the document insert: any coach could
    // file a document onto any case in the gym -- an athlete they do not
    // coach, or a case already decided -- and an id naming no case here
    // failed at the foreign key as a 500 after the blob was already stored.
    // Same gate every intake-case read uses, then the case must still be
    // open for review. createIntakeDocument repeats the pending check in its
    // own insert, so a case decided between here and there is refused too.
    if (intakeCaseIdInput) {
      const authority = await assertActorCanAccessIntakeCase(principal, principal.organizationId, intakeCaseIdInput);
      if (!authority.found) {
        return NextResponse.json({ ok: false, error: 'Intake case not found.' }, { status: 404 });
      }
      const existingCase = await queryOne<{ status: string }>(
        'select status from pilot.intake_cases where organization_id = $1 and intake_case_id = $2',
        [principal.organizationId, intakeCaseIdInput],
      );
      if (existingCase?.status !== 'pending_review') {
        throw new ConflictError('This intake case is no longer open for review; upload without a case to start a new one.');
      }
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
        file_name: uploadDescriptor.safeOriginalName,
        document_type: documentType,
        quarantine_status: 'pending_security_review',
      },
    });

    const intakeId = randomUUID();
    const filePath = `quarantine/${principal.organizationId}/${intakeId}/${uploadDescriptor.generatedFileName}`;

    await uploadPilotShadowFile(filePath, uploaded);

    const classification = classifyShadowDocument(uploadDescriptor.safeOriginalName, hint);
    const routedQueue = routeShadowClassification(classification);
    const researchFields = buildUploadResearchFields({
      fileName: uploadDescriptor.safeOriginalName,
      documentType,
      classification,
      routedQueue,
    });

    const intakeCaseId =
      intakeCaseIdInput ||
      (await createIntakeCase({
        organizationId: principal.organizationId,
        submittedByAccountId: principal.accountId,
        summary: `SHADOW upload: ${uploadDescriptor.safeOriginalName}`,
        sourceShadowIntakeId: intakeId,
        payload: {
          file_name: uploadDescriptor.safeOriginalName,
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
      fileName: uploadDescriptor.safeOriginalName,
      blobPath: filePath,
      classification,
      reviewStatus: 'pending_review',
      metadata: {
        hint: hint ?? null,
        quarantine_status: 'pending_security_review',
        content_sha256: contentSha256,
      },
    });

    await query(
      `insert into pilot.shadow_intake
       (organization_id, intake_id, file_name, file_path, classification, routed_queue, review_status, uploaded_by_account_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [principal.organizationId, intakeId, uploadDescriptor.safeOriginalName, filePath, classification, routedQueue, 'pending_human_review', principal.accountId],
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
        file_name: uploadDescriptor.safeOriginalName,
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
        quarantine_status: 'pending_security_review',
      },
    });

    // NO RESEARCH REQUIREMENT IS OPENED FOR AN INTAKE UPLOAD (OD-2026-10-02-015
    // D4: "Athlete intake files stay out of research"). Every document type
    // this route accepts is athlete intake. Until 2026-10-03 each upload also
    // wrote a pilot.shadow_research_requirements row whose text was "Review
    // <type> (<file name>) and validate routing to ...". That table is listed
    // on /research to every organization role, and the row named no subject
    // for the subject gate to narrow on, so the file name -- often the child's
    // name, as the admin saved the form -- was readable by athletes, parents
    // and volunteers. The intake record above keeps the file name, where
    // only intake readers see it. The SHADOW event above still carries it,
    // and the read model strips it for every role that is not staff
    // (shadowReadModels.ts, sanitizeEventPayload). Rows written before this
    // change are not touched here: what to do with them is Jason's (question
    // Q1 of the 2026-10-03 intake audit, PR #1121).

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

    return NextResponse.json(
      {
        ok: true,
        accepted_for_security_review: true,
        intake_id: intakeId,
        intake_case_id: intakeCaseId,
        intake_document_id: intakeDocumentId,
        document_type: documentType,
        classification,
        routed_queue: routedQueue,
        review_status: 'pending_human_review',
        quarantine_status: 'pending_security_review',
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof ShadowRateLimitExceeded) {
      return NextResponse.json(
        { ok: false, error: shadowRateLimitMessage(error.retryAfterSeconds, 'upload') },
        { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } },
      );
    }
    return jsonError(error);
  }
}
