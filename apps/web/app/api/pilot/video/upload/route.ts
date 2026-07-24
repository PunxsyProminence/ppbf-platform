import { randomUUID } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { uploadPilotVideoFile } from '@/src/server/pilot/blob';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { emitShadowEvent } from '@/src/server/pilot/shadowEvents';
import { enforceShadowRateLimit, ShadowRateLimitExceeded } from '@/src/server/pilot/shadowRateLimit';
import { writeShadowTelemetryEvent } from '@/src/server/pilot/shadowTelemetry';
import {
  describeVideoUpload,
  validateVideoUploadSignature,
  validateVideoUploadTransport,
} from '@/src/server/pilot/videoUploadPolicy';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);
    const transport = validateVideoUploadTransport(request.headers);
    if (!transport.ok) {
      return NextResponse.json({ error: transport.error }, { status: transport.status });
    }
    await enforceShadowRateLimit({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      endpointKey: 'video_upload',
      limit: 5,
      windowSeconds: 3_600,
    });

    const formData = await request.formData();
    const file = formData.get('file');
    const athleteIdValue = formData.get('athlete_id');
    const titleValue = formData.get('title');
    const notesValue = formData.get('notes');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing video file' }, { status: 400 });
    }
    const uploadDescriptor = describeVideoUpload(file);
    if (!uploadDescriptor) {
      return NextResponse.json(
        { error: 'Only bounded MP4, MOV, AVI, WebM, and MPEG video files are accepted.' },
        { status: 415 },
      );
    }
    const signatureBytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!validateVideoUploadSignature(uploadDescriptor, signatureBytes)) {
      return NextResponse.json(
        { error: 'The video content does not match its declared file type.' },
        { status: 415 },
      );
    }

    const athleteId = typeof athleteIdValue === 'string' ? athleteIdValue.trim() : null;
    const title = typeof titleValue === 'string' && titleValue.trim()
      ? titleValue.trim()
      : uploadDescriptor.safeOriginalName;
    const notes = typeof notesValue === 'string' ? notesValue.trim() : '';
    if (title.length > 200 || notes.length > 2_000) {
      return NextResponse.json({ error: 'Video title or notes exceed the allowed size.' }, { status: 400 });
    }

    if (athleteId) {
      await assertActorCanAccessAthlete(principal, athleteId);
    }

    const videoSessionId = randomUUID();
    const blobPath = `${principal.organizationId}/${videoSessionId}/${uploadDescriptor.generatedFileName}`;

    await uploadPilotVideoFile(blobPath, file);

    await query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, notes, blob_path, file_name, file_size_bytes, mime_type, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'quarantined', now(), now())`,
      [
        videoSessionId,
        principal.organizationId,
        principal.accountId,
        athleteId,
        title,
        notes,
        blobPath,
        uploadDescriptor.safeOriginalName,
        file.size,
        uploadDescriptor.contentType,
      ],
    );

    await emitShadowEvent({
      organizationId: principal.organizationId,
      eventName: 'video.uploaded',
      entityType: 'video_session',
      entityId: videoSessionId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      payload: {
        title,
        athlete_id: athleteId,
        file_name: uploadDescriptor.safeOriginalName,
        file_size_bytes: file.size,
        status: 'quarantined',
      },
    });

    await writeShadowTelemetryEvent({
      organizationId: principal.organizationId,
      metricName: 'video.uploaded',
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      dimensions: {
        mime_type: uploadDescriptor.contentType,
        video_session_id: videoSessionId,
        status: 'quarantined',
      },
    });

    return NextResponse.json(
      {
        video_session_id: videoSessionId,
        title,
        status: 'quarantined',
        accepted_for_security_review: true,
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof ShadowRateLimitExceeded) {
      return NextResponse.json(
        { error: 'Too many video uploads. Please wait and try again.' },
        { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } },
      );
    }
    return jsonError(error);
  }
}
