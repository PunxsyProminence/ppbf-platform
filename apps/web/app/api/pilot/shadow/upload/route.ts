import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { uploadPilotShadowFile } from '@/src/server/pilot/blob';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { classifyShadowDocument, routeShadowClassification } from '@/src/server/pilot/shadow';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'coach']);

    const formData = await request.formData();
    const uploaded = formData.get('file');
    const hintValue = formData.get('hint');
    const hint = typeof hintValue === 'string' ? hintValue : undefined;

    if (!(uploaded instanceof File)) {
      throw new TypeError('Missing file upload payload');
    }

    const intakeId = randomUUID();
    const filePath = `${intakeId}/${uploaded.name}`;

    await uploadPilotShadowFile(filePath, uploaded);

    const classification = classifyShadowDocument(uploaded.name, hint);
    const routedQueue = routeShadowClassification(classification);

    await query(
      `insert into pilot.shadow_intake
       (intake_id, file_name, file_path, classification, routed_queue, review_status, uploaded_by_account_id)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [intakeId, uploaded.name, filePath, classification, routedQueue, 'pending_human_review', principal.accountId],
    );

    await writePilotAuditEvent({
      event_type: 'shadow_classification',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      entity_type: 'shadow_intake',
      entity_id: intakeId,
      details: { classification },
    });

    await writePilotAuditEvent({
      event_type: 'shadow_routing',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      entity_type: 'shadow_intake',
      entity_id: intakeId,
      details: { routed_queue: routedQueue },
    });

    return NextResponse.json({
      ok: true,
      intake_id: intakeId,
      classification,
      routed_queue: routedQueue,
      review_status: 'pending_human_review',
    });
  } catch (error) {
    return jsonError(error);
  }
}
